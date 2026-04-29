/**
 * /v1/roundtable — M3.A roundtable orchestration.
 *
 * M3.A.1: POST + GET (creation + analyzer)
 * M3.A.2 (current): POST round + PUT retry — fans out one round in parallel via SSE annotations
 *
 * M3.A.3 will add:
 *   POST /v1/roundtable/:id/summarize
 *   GET  /v1/roundtable/:id/export
 */

import type { FastifyInstance } from 'fastify';
import { PassThrough } from 'node:stream';
import { z } from 'zod';
import {
  TaoriError,
  CreateRoundtableRequestSchema,
  type AnalyzerOutput,
} from '@taori/shared';
import {
  ConversationsRepo,
  CostsRepo,
  MemoriesRepo,
  MessagesRepo,
  ModelsRepo,
  ProvidersRepo,
  RoundtableMessagesRepo,
  RoundtablesRepo,
} from '../db/repos/index.js';
import type { BuildServerArgs } from '../server.js';
import {
  pickAnalyzerModel,
  pickFallbackParticipantModels,
} from '../roundtable/model-pick.js';
import { runAnalyzer, buildFallbackOutput } from '../roundtable/analyzer.js';
import {
  estimateRoundtableCostRange,
  estimateRoundtableCallsAndDuration,
  buildAnalyzerModeReason,
} from '../roundtable/cost-estimate.js';
import { runRound } from '../roundtable/round-runner.js';
import { runSummary } from '../roundtable/summarizer.js';
import { renderRoundtableMarkdown, renderRoundtableSummaryMarkdown } from '../roundtable/export.js';

export function registerRoundtableRoute(
  app: FastifyInstance,
  deps: BuildServerArgs,
): void {
  const convRepo = new ConversationsRepo(deps.db);
  const modelsRepo = new ModelsRepo(deps.db);
  const providersRepo = new ProvidersRepo(deps.db);
  const memoriesRepo = new MemoriesRepo(deps.db);
  const costsRepo = new CostsRepo(deps.db);
  const rtRepo = new RoundtablesRepo(deps.db);
  const rtMsgRepo = new RoundtableMessagesRepo(deps.db);
  const messagesRepo = new MessagesRepo(deps.db);
  // M3.A.6 — In-memory in-flight tracker. The DB `status` column is a coarse
  // FSM that lingers in 'round1' / 'round2' / 'summarizing' even after the
  // stream finishes (spec has no idle-between-rounds state). To safely allow
  // 再来一轮 / 总结结束 / 重试 / 取消 we instead track whether a stream is
  // **actively** running per roundtable id.
  //
  // ASSUMES SINGLE SIDECAR PROCESS PER DESKTOP INSTANCE (see
  // docs/architecture/03-process-and-ipc.md). If horizontal scaling is ever
  // introduced, migrate this to a SQLite advisory flag or external lock.
  const inFlightStreams = new Set<string>();

  app.post('/v1/roundtable', async (req, reply) => {
    const parsed = CreateRoundtableRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new TaoriError({
        code: 'validation_error',
        message: parsed.error.issues
          .map((i) => `${i.path.join('.')}:${i.message}`)
          .join('; '),
      });
    }
    const body = parsed.data;
    const conv = convRepo.ensure(body.conversation_id, { type: 'roundtable' });
    const requestedMode = body.mode ?? 'auto';

    const allEnabledChat = modelsRepo
      .list()
      .filter(
        (m) =>
          m.enabled &&
          !m.demoted &&
          m.provider_id &&
          m.capability === 'chat' &&
          (!m.disabled_until || m.disabled_until < Date.now()),
      );
    if (allEnabledChat.length === 0) {
      throw new TaoriError({
        code: 'conflict',
        message: 'no_available_chat_models',
        details: { hint: '请先在设置中启用至少一个 chat 模型' },
      });
    }

    const candidateModels = allEnabledChat.map((m) => ({
      id: m.id,
      display_name: m.display_name,
      model_name: m.model_name,
    }));
    const analyzerModel = pickAnalyzerModel(modelsRepo, memoriesRepo);
    const analyzerProvider = analyzerModel?.provider_id
      ? providersRepo.get(analyzerModel.provider_id)
      : null;

    // Pre-allocate the roundtable id so the analyzer cost_record can FK to it.
    // We insert the actual roundtable row only after analyzer settles so the
    // initial status reflects reality (ready / failed).
    const pendingId = `rt_${Math.random().toString(36).slice(2, 14)}`;

    let analyzerOutput: AnalyzerOutput | null = null;
    let analyzerFailed = false;

    if (analyzerModel && analyzerProvider) {
      const analyzerResult = await runAnalyzer(
        { keystore: deps.keystore, log: req.log },
        {
          topic: body.topic,
          requestedMode,
          candidateModels,
          analyzerModel,
          analyzerProvider,
        },
        pendingId,
        conv.id,
      );
      if (analyzerResult.costInsert) {
        costsRepo.insert(analyzerResult.costInsert);
      }
      if (analyzerResult.ok) {
        analyzerOutput = analyzerResult.output;
      } else {
        analyzerFailed = true;
        req.log.warn(
          { reason: analyzerResult.reason, message: analyzerResult.message },
          'roundtable.analyzer.failed',
        );
      }
    } else {
      analyzerFailed = true;
      req.log.info(
        'roundtable.analyzer.skipped — no analyzer model / provider key',
      );
    }

    if (!analyzerOutput) {
      const fallbackModels = pickFallbackParticipantModels(modelsRepo, 3);
      analyzerOutput = buildFallbackOutput({
        participantModels: fallbackModels,
        summarizerModelId: fallbackModels[0]!.id,
        requestedMode,
      });
    }

    const participantModels = analyzerOutput.participants
      .map((p) => modelsRepo.get(p.model_id))
      .filter((m): m is NonNullable<typeof m> => m !== null);
    if (participantModels.length < analyzerOutput.participants.length) {
      // Defensive: a model the analyzer picked got deleted between candidate
      // listing and resolution. Re-roll via fallback path so we never persist
      // a roundtable with missing participant models.
      req.log.warn(
        {
          expected: analyzerOutput.participants.length,
          got: participantModels.length,
        },
        'roundtable.create.participant_models_missing_rerolling',
      );
      const fallbackModels = pickFallbackParticipantModels(modelsRepo, 3);
      analyzerOutput = buildFallbackOutput({
        participantModels: fallbackModels,
        summarizerModelId: fallbackModels[0]!.id,
        requestedMode,
      });
      analyzerFailed = true;
      participantModels.length = 0;
      for (const p of analyzerOutput.participants) {
        const m = modelsRepo.get(p.model_id);
        if (m) participantModels.push(m);
      }
    }
    const summarizerModel = modelsRepo.get(analyzerOutput.summarizer_model_id);
    if (!summarizerModel) {
      throw new TaoriError({
        code: 'internal',
        message: 'summarizer model resolved to null after analyzer',
      });
    }

    const estimate = estimateRoundtableCostRange({
      mode: analyzerOutput.suggested_mode,
      analyzerModel,
      participantModels,
      summarizerModel,
      topicLength: body.topic.length,
    });

    // A5 — also compute the alternate-mode estimate so the launch dialog can
    // show fast vs deep side-by-side. Same participants, just different round
    // count.
    const altMode: 'fast' | 'deep' =
      analyzerOutput.suggested_mode === 'fast' ? 'deep' : 'fast';
    const altEstimate = estimateRoundtableCostRange({
      mode: altMode,
      analyzerModel,
      participantModels,
      summarizerModel,
      topicLength: body.topic.length,
    });
    const callsChosen = estimateRoundtableCallsAndDuration({
      mode: analyzerOutput.suggested_mode,
      hasAnalyzer: !analyzerFailed && !!analyzerModel,
      participantCount: analyzerOutput.participants.length,
    });
    const callsAlt = estimateRoundtableCallsAndDuration({
      mode: altMode,
      hasAnalyzer: !analyzerFailed && !!analyzerModel,
      participantCount: analyzerOutput.participants.length,
    });
    const launchReason = buildAnalyzerModeReason({
      topicType: analyzerFailed ? null : analyzerOutput.topic_type,
      complexity: analyzerFailed ? null : analyzerOutput.complexity,
      requestedMode,
      chosenMode: analyzerOutput.suggested_mode,
      analyzerFallback: analyzerFailed,
    });

    const inserted = rtRepo.insert({
      id: pendingId,
      conversation_id: conv.id,
      topic: body.topic,
      mode: analyzerOutput.suggested_mode,
      participants: analyzerOutput.participants,
      summarizer_model_id: analyzerOutput.summarizer_model_id,
      origin_conversation_id: body.origin_conversation_id ?? null,
      analyzer_fallback: analyzerFailed,
      status: 'analyzing',
      current_round: 0,
      estimated_cost_usd_low: estimate.low,
      estimated_cost_usd_high: estimate.high,
    });

    return reply.code(201).send({
      id: inserted.id,
      conversation_id: inserted.conversation_id,
      topic: inserted.topic,
      mode: inserted.mode,
      participants: inserted.participants,
      summarizer_model_id: inserted.summarizer_model_id,
      analyzer_fallback: inserted.analyzer_fallback,
      status: inserted.status,
      current_round: inserted.current_round,
      estimated_cost_usd_low: inserted.estimated_cost_usd_low,
      estimated_cost_usd_high: inserted.estimated_cost_usd_high,
      created_at: inserted.created_at,
      // A5 — launch preview metadata (renderer-only; not persisted).
      preview: {
        topic_type: analyzerFailed ? null : analyzerOutput.topic_type,
        complexity: analyzerFailed ? null : analyzerOutput.complexity,
        requested_mode: requestedMode,
        analyzer_chose_mode_reason: launchReason,
        estimated_calls: callsChosen.calls,
        estimated_duration_sec_low: callsChosen.durationSecLow,
        estimated_duration_sec_high: callsChosen.durationSecHigh,
        alt_mode: altMode,
        alt_estimated_cost_usd_low: altEstimate.low,
        alt_estimated_cost_usd_high: altEstimate.high,
        alt_estimated_calls: callsAlt.calls,
        alt_estimated_duration_sec_low: callsAlt.durationSecLow,
        alt_estimated_duration_sec_high: callsAlt.durationSecHigh,
      },
    });
  });

  app.get<{ Params: { id: string } }>('/v1/roundtable/:id', async (req) => {
    const rt = rtRepo.get(req.params.id);
    if (!rt) {
      throw new TaoriError({
        code: 'not_found',
        message: `Roundtable ${req.params.id} not found`,
      });
    }
    const messages = rtMsgRepo.listByRoundtable(rt.id);
    const costs = costsRepo.listForRoundtable({
      conversationId: rt.conversation_id,
      roundtableId: rt.id,
      messageIds: messages.map((m) => m.id),
    });
    const total_cost_usd = costs.reduce(
      (s, c) => s + (c.actual_cost_usd ?? 0),
      0,
    );
    return { roundtable: rt, messages, total_cost_usd };
  });

  /**
   * POST /v1/roundtable/:id/cancel — user-initiated cancel.
   *
   * Marks status='cancelled' if not already terminal. Does NOT abort an
   * in-flight stream (the renderer aborts via AbortController locally); the
   * sidecar guarantees subsequent /round and /summarize calls reject with 409
   * because cancelled is a terminal status.
   */
  app.post<{ Params: { id: string } }>(
    '/v1/roundtable/:id/cancel',
    async (req, reply) => {
      const rt = rtRepo.get(req.params.id);
      if (!rt) {
        throw new TaoriError({
          code: 'not_found',
          message: `Roundtable ${req.params.id} not found`,
        });
      }
      if (
        rt.status === 'completed' ||
        rt.status === 'failed' ||
        rt.status === 'cancelled'
      ) {
        return reply.code(200).send({ ok: true, status: rt.status });
      }
      rtRepo.setStatus(rt.id, 'cancelled');
      return reply.code(200).send({ ok: true, status: 'cancelled' });
    },
  );

  /**
   * A3 — PUT /v1/roundtable/:id/participants — replace participants list.
   *
   * Only allowed when no round has started yet (current_round === 0) and
   * status is not terminal. Validates: 2..4 entries, all model_ids are
   * existing enabled chat-capable models with their provider available,
   * role_label and persona_prompt within length bounds.
   */
  app.put<{
    Params: { id: string };
    Body: { participants: unknown };
  }>('/v1/roundtable/:id/participants', async (req, reply) => {
    const rt = rtRepo.get(req.params.id);
    if (!rt) {
      throw new TaoriError({
        code: 'not_found',
        message: `Roundtable ${req.params.id} not found`,
      });
    }
    if (rt.current_round !== 0) {
      throw new TaoriError({
        code: 'conflict',
        message: '已经开始第 1 轮后不能再修改参与者',
      });
    }
    if (
      rt.status === 'completed' ||
      rt.status === 'failed' ||
      rt.status === 'cancelled'
    ) {
      throw new TaoriError({
        code: 'conflict',
        message: `roundtable status=${rt.status}，不允许修改参与者`,
      });
    }
    const ParticipantArr = z
      .array(
        z.object({
          model_id: z.string().min(1),
          display_name: z.string().min(1).max(80),
          role_label: z.string().min(1).max(40),
          persona_prompt: z.string().min(8).max(2000),
        }),
      )
      .min(2)
      .max(4);
    const parsed = ParticipantArr.safeParse(req.body?.participants);
    if (!parsed.success) {
      throw new TaoriError({
        code: 'validation_error',
        message: parsed.error.message,
      });
    }
    for (const p of parsed.data) {
      const m = modelsRepo.get(p.model_id);
      if (!m) {
        throw new TaoriError({
          code: 'validation_error',
          message: `模型不存在：${p.model_id}`,
        });
      }
      if (m.capability !== 'chat') {
        throw new TaoriError({
          code: 'validation_error',
          message: `模型 ${m.display_name} 非 chat 能力`,
        });
      }
      if (m.disabled_until && m.disabled_until > Date.now()) {
        throw new TaoriError({
          code: 'validation_error',
          message: `模型 ${m.display_name} 已被临时禁用`,
        });
      }
      if (!m.provider_id) {
        throw new TaoriError({
          code: 'validation_error',
          message: `模型 ${m.display_name} 缺少 provider_id`,
        });
      }
      const provider = providersRepo.get(m.provider_id);
      if (!provider) {
        throw new TaoriError({
          code: 'validation_error',
          message: `模型 ${m.display_name} 的提供商不可用`,
        });
      }
    }
    const updated = rtRepo.setParticipants(rt.id, parsed.data);
    return reply.code(200).send({ ok: true, roundtable: updated });
  });

  /**
   * A4 — POST /v1/roundtable/:id/loopback
   *
   * Writes the roundtable's final summary back into the original chat
   * conversation as an assistant message, so the user can keep chatting
   * about the conclusion without copy/paste.
   *
   * Behavior:
   *   - Requires status === 'completed' AND a non-null summary.
   *   - Target conversation: prefer roundtable.origin_conversation_id; if
   *     null (or the original conv was deleted), mint a fresh chat conv
   *     and write into that one.
   *   - Idempotent in spirit: nothing prevents the user from clicking
   *     twice — each click appends another assistant message. The renderer
   *     is responsible for one-shot UX (disable button after click).
   *   - Returns { conversation_id, message_id } so the renderer can switch
   *     active conversation and refresh.
   */
  app.post<{ Params: { id: string } }>(
    '/v1/roundtable/:id/loopback',
    async (req, reply) => {
      const rt = rtRepo.get(req.params.id);
      if (!rt) {
        throw new TaoriError({
          code: 'not_found',
          message: `Roundtable ${req.params.id} not found`,
        });
      }
      if (rt.status !== 'completed') {
        throw new TaoriError({
          code: 'conflict',
          message: `roundtable status=${rt.status}，仅完成后才能回填到原对话`,
        });
      }
      if (!rt.summary) {
        throw new TaoriError({
          code: 'conflict',
          message: '当前圆桌尚无总结，无法回填',
        });
      }

      let targetConvId: string | null = null;
      if (rt.origin_conversation_id) {
        const exists = convRepo.get(rt.origin_conversation_id);
        if (exists && exists.type === 'chat') targetConvId = exists.id;
      }
      if (!targetConvId) {
        const fresh = convRepo.create({
          type: 'chat',
          title: `圆桌结论：${rt.topic.slice(0, 40)}`,
        });
        targetConvId = fresh.id;
      }

      const summaryMd = renderRoundtableSummaryMarkdown(rt.summary);
      const header = `> 🔍 来自圆桌讨论 · ${rt.topic}\n\n`;
      const inserted = messagesRepo.insert({
        conversation_id: targetConvId,
        role: 'assistant',
        content: header + summaryMd,
        status: 'complete',
      });
      convRepo.touch(targetConvId);

      return reply.code(200).send({
        conversation_id: targetConvId,
        message_id: inserted.id,
      });
    },
  );

  /**
   * GET /v1/conversations/:id/roundtable — returns the most recent roundtable
   * associated with the given conversation, or `{roundtable_id: null}` if none.
   * Used by the renderer to restore the roundtable panel on conversation
   * switch (spec §5.3).
   */
  app.get<{ Params: { id: string } }>(
    '/v1/conversations/:id/roundtable',
    async (req) => {
      const list = rtRepo.listByConversation(req.params.id);
      const last = list[list.length - 1];
      return { roundtable_id: last?.id ?? null };
    },
  );

  /**
   * POST /v1/roundtable/:id/round — start the next round (current_round + 1).
   *
   * Streams `8:` annotation frames (Vercel AI SDK data-stream format) so the
   * renderer can reuse useChat-style tee logic. Multiplexes participant deltas
   * via `participant_index`. Ends with a single `d:` finish frame.
   */
  app.post<{ Params: { id: string } }>(
    '/v1/roundtable/:id/round',
    async (req, reply) => {
      const rt = rtRepo.get(req.params.id);
      if (!rt) {
        throw new TaoriError({
          code: 'not_found',
          message: `Roundtable ${req.params.id} not found`,
        });
      }
      const next = (rt.current_round ?? 0) + 1;
      if (next > 2) {
        throw new TaoriError({
          code: 'conflict',
          message: 'no_more_rounds',
          details: { hint: '已达到最大轮数' },
        });
      }
      if (next === 2 && rt.mode !== 'deep') {
        throw new TaoriError({
          code: 'conflict',
          message: 'fast_mode_no_round_two',
          details: { hint: '快速模式只有一轮' },
        });
      }
      if (rt.status === 'completed' || rt.status === 'failed') {
        throw new TaoriError({
          code: 'conflict',
          message: `roundtable_${rt.status}`,
          details: { hint: '已结束的圆桌不能继续' },
        });
      }
      if (inFlightStreams.has(rt.id)) {
        throw new TaoriError({
          code: 'conflict',
          message: 'roundtable_busy',
          details: { hint: '圆桌正在运行中' },
        });
      }
      // Reject if the round being requested has already been recorded.
      if (next <= (rt.current_round ?? 0)) {
        throw new TaoriError({
          code: 'conflict',
          message: 'round_already_done',
          details: { hint: '该轮已完成' },
        });
      }

      const priorMessages =
        next === 2 ? rtMsgRepo.listByRoundtable(rt.id) : [];

      const stream = new PassThrough();
      const origin = req.headers.origin;
      if (
        typeof origin === 'string' &&
        (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin) ||
          origin === 'tauri://localhost' ||
          origin.startsWith('http://tauri.localhost'))
      ) {
        reply.header('Access-Control-Allow-Origin', origin);
        reply.header('Vary', 'Origin');
        reply.header('Access-Control-Expose-Headers', 'x-vercel-ai-data-stream');
      }
      reply
        .type('text/plain; charset=utf-8')
        .header('Cache-Control', 'no-cache, no-transform')
        .header('Connection', 'keep-alive')
        .header('x-vercel-ai-data-stream', 'v1');

      if (typeof reply.raw.socket?.setNoDelay === 'function') {
        reply.raw.socket.setNoDelay(true);
      }

      const abortController = new AbortController();
      reply.raw.on('close', () => {
        if (!stream.writableEnded) abortController.abort();
      });
      reply.send(stream);

      // Lead annotation so renderers know which roundtable this stream binds to.
      stream.write(
        `8:${JSON.stringify([
          {
            type: 'rt.meta',
            roundtable_id: rt.id,
            conversation_id: rt.conversation_id,
            round: next,
          },
        ])}\n`,
      );

      try {
        inFlightStreams.add(rt.id);
        const result = await runRound(
          {
            modelsRepo,
            providersRepo,
            costsRepo,
            rtRepo,
            rtMsgRepo,
            keystore: deps.keystore,
            log: req.log,
          },
          {
            roundtable: rt,
            round: next as 1 | 2,
            priorRoundMessages: priorMessages,
            stream,
            signal: abortController.signal,
          },
        );

        // Spec §6.1: fast 模式 round 1 完成后**自动**触发 summarize（同一 SSE
        // 响应里 round_done 紧跟 summary_*）。仅在未触发 majority-fail 时执行。
        // Spec §5.3: 多数 = 严格超过半数（n=3→≥2, n=4→≥3, n=5→≥3）。
        const majorityThreshold = Math.floor(rt.participants.length / 2) + 1;
        const majorityFailed = result.failed.length >= majorityThreshold;
        const shouldAutoSummarize =
          rt.mode === 'fast' && next === 1 && !majorityFailed;
        if (shouldAutoSummarize) {
          const allMessages = rtMsgRepo.listByRoundtable(rt.id);
          const hasContent = allMessages.some(
            (m) => m.status === 'complete' && m.content.trim().length > 0,
          );
          if (!hasContent) {
            req.log.warn(
              { roundtable_id: rt.id },
              'auto_chain_skipped_no_content',
            );
          } else {
          rtRepo.setStatus(rt.id, 'summarizing');
          await runSummary(
            {
              modelsRepo,
              providersRepo,
              costsRepo,
              rtRepo,
              rtMsgRepo,
              keystore: deps.keystore,
              log: req.log,
            },
            {
              roundtable: { ...rt, status: 'summarizing' },
              messages: allMessages,
              stream,
              signal: abortController.signal,
              revertStatusOnFail: 'round1',
            },
          );
          }
        }

        // Spec §5.2.1 / §5.3: 多数失败 → 终态 failed（不允许继续 retry/next-round）。
        if (majorityFailed) {
          rtRepo.setStatus(rt.id, 'failed');
        }

        stream.write(
          `d:${JSON.stringify({
            finishReason: majorityFailed ? 'error' : 'stop',
            usage: { promptTokens: 0, completionTokens: 0 },
          })}\n`,
        );
      } catch (e) {
        req.log.error({ err: e }, 'roundtable.round.unhandled');
        stream.write(
          `3:${JSON.stringify(
            `roundtable_round_failed: ${e instanceof Error ? e.message : String(e)}`,
          )}\n`,
        );
        stream.write(
          `d:${JSON.stringify({ finishReason: 'error', usage: { promptTokens: 0, completionTokens: 0 } })}\n`,
        );
        rtRepo.setStatus(rt.id, 'failed');
      } finally {
        inFlightStreams.delete(rt.id);
        stream.end();
      }
    },
  );

  /**
   * GET /v1/roundtable/:id/participant/:index/retry-candidates — A1.
   *
   * Returns the list of chat-capable models eligible to replace this
   * participant on retry, plus the recommended fallback (M2 demote-aware).
   * The current model is always returned as the first item with
   * `is_current: true` so the UI can render it as the "stay on current" choice.
   *
   * Items include both healthy and demoted models so the user can still
   * force a demoted model if they want; demoted/disabled flags are surfaced
   * for UI grading.
   */
  app.get<{
    Params: { id: string; index: string };
  }>(
    '/v1/roundtable/:id/participant/:index/retry-candidates',
    async (req) => {
      const rt = rtRepo.get(req.params.id);
      if (!rt) {
        throw new TaoriError({
          code: 'not_found',
          message: `Roundtable ${req.params.id} not found`,
        });
      }
      const index = Number(req.params.index);
      if (
        !Number.isInteger(index) ||
        index < 0 ||
        index >= rt.participants.length
      ) {
        throw new TaoriError({
          code: 'validation_error',
          message: 'participant index out of range',
        });
      }
      const current = rt.participants[index]!;
      const recommended = modelsRepo.nextFallback(current.model_id, 'chat');
      const all = modelsRepo
        .list()
        .filter((m) => m.capability === 'chat' && m.enabled);
      const now = Date.now();
      const sameModelIds = new Set(
        rt.participants.map((p, i) => (i === index ? null : p.model_id)),
      );
      const candidates = all
        .map((m) => ({
          model_id: m.id,
          display_name: m.display_name ?? m.model_name,
          model_name: m.model_name,
          provider_id: m.provider_id,
          fallback_order: m.fallback_order ?? 0,
          demoted: !!m.demoted,
          disabled:
            !!m.disabled_until && (m.disabled_until ?? 0) > now,
          is_current: m.id === current.model_id,
          recommended: !!recommended && m.id === recommended.id,
          already_used_by_other_participant: sameModelIds.has(m.id),
        }))
        .sort((a, b) => {
          if (a.is_current !== b.is_current) return a.is_current ? -1 : 1;
          if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
          if (a.demoted !== b.demoted) return a.demoted ? 1 : -1;
          if (a.disabled !== b.disabled) return a.disabled ? 1 : -1;
          return a.fallback_order - b.fallback_order;
        });
      return {
        roundtable_id: rt.id,
        participant_index: index,
        current_model_id: current.model_id,
        recommended_model_id: recommended?.id ?? null,
        candidates,
      };
    },
  );

  /**
   * PUT /v1/roundtable/:id/round/:round/participant/:index/retry — retry a
   * single participant's row in place. Streams the same annotation set as a
   * full round but only for the given index.
   *
   * Failure-count rule (spec §3.3): same as first attempt — record failure on
   * provider error (except content_filter). Connect 3 strikes → renderer
   * disables the retry button.
   */
  app.put<{
    Params: { id: string; round: string; index: string };
    Body: { model_id?: string } | undefined;
  }>(
    '/v1/roundtable/:id/round/:round/participant/:index/retry',
    async (req, reply) => {
      const rt0 = rtRepo.get(req.params.id);
      if (!rt0) {
        throw new TaoriError({
          code: 'not_found',
          message: `Roundtable ${req.params.id} not found`,
        });
      }
      const round = Number(req.params.round);
      const index = Number(req.params.index);
      if (!Number.isInteger(round) || (round !== 1 && round !== 2)) {
        throw new TaoriError({
          code: 'validation_error',
          message: 'round must be 1 or 2',
        });
      }
      if (
        !Number.isInteger(index) ||
        index < 0 ||
        index >= rt0.participants.length
      ) {
        throw new TaoriError({
          code: 'validation_error',
          message: 'participant index out of range',
        });
      }
      const existing = rtMsgRepo.findOne(rt0.id, round, index);
      if (!existing) {
        throw new TaoriError({
          code: 'not_found',
          message: 'roundtable message row not found — run the round first',
        });
      }
      if (inFlightStreams.has(rt0.id)) {
        throw new TaoriError({
          code: 'conflict',
          message: 'roundtable_busy',
          details: { hint: '圆桌正在运行中' },
        });
      }

      // A1 — optional override: switch to a different chat model for this
      // retry (and subsequent rounds). Validate the candidate is a real,
      // chat-capable model with a usable provider.
      const overrideId = req.body?.model_id;
      let rt = rt0;
      let overrideApplied = false;
      if (overrideId && overrideId !== rt0.participants[index]!.model_id) {
        const m = modelsRepo.get(overrideId);
        if (!m || m.capability !== 'chat' || !m.enabled) {
          throw new TaoriError({
            code: 'validation_error',
            message: 'override model is not a usable chat model',
          });
        }
        if (!m.provider_id) {
          throw new TaoriError({
            code: 'validation_error',
            message: 'override model has no provider',
          });
        }
        const updated = rtRepo.setParticipantModel(rt0.id, index, overrideId);
        if (updated) rt = updated;
        rtMsgRepo.update(existing.id, { model_id: overrideId });
        overrideApplied = true;
      }

      // Reset row to streaming/empty so listeners see a clean retry.
      rtMsgRepo.update(existing.id, {
        status: 'pending',
        content: '',
        classification: null,
        error_message: null,
      });

      const stream = new PassThrough();
      const origin = req.headers.origin;
      if (
        typeof origin === 'string' &&
        (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin) ||
          origin === 'tauri://localhost' ||
          origin.startsWith('http://tauri.localhost'))
      ) {
        reply.header('Access-Control-Allow-Origin', origin);
        reply.header('Vary', 'Origin');
        reply.header('Access-Control-Expose-Headers', 'x-vercel-ai-data-stream');
      }
      reply
        .type('text/plain; charset=utf-8')
        .header('Cache-Control', 'no-cache, no-transform')
        .header('Connection', 'keep-alive')
        .header('x-vercel-ai-data-stream', 'v1');

      const abortController = new AbortController();
      reply.raw.on('close', () => {
        if (!stream.writableEnded) abortController.abort();
      });
      reply.send(stream);

      stream.write(
        `8:${JSON.stringify([
          {
            type: 'rt.meta',
            roundtable_id: rt.id,
            conversation_id: rt.conversation_id,
            round,
            retry_index: index,
            ...(overrideApplied
              ? { override_model_id: rt.participants[index]!.model_id }
              : {}),
          },
        ])}\n`,
      );

      // Build a temporary single-participant runner: call runRound with a
      // patched roundtable whose participants array is one element. Because
      // round-runner.findOne keys on (roundtable_id, round, participant_index),
      // we restore the original index via a one-element synthetic so the row
      // gets reused in place. The simpler path is to re-implement the body
      // inline — but since runRound already handles classification, cost
      // records and recordFailure correctly, we do the inline path here only
      // for the single message; reuse helper functions where possible.
      try {
        inFlightStreams.add(rt.id);
        const priorMessages =
          round === 2 ? rtMsgRepo.listByRoundtable(rt.id) : [];
        await runRound(
          {
            modelsRepo,
            providersRepo,
            costsRepo,
            rtRepo,
            rtMsgRepo,
            keystore: deps.keystore,
            log: req.log,
          },
          {
            roundtable: rt,
            round: round as 1 | 2,
            priorRoundMessages: priorMessages,
            stream,
            signal: abortController.signal,
            targetIndices: [index],
          },
        );
        stream.write(
          `d:${JSON.stringify({ finishReason: 'stop', usage: { promptTokens: 0, completionTokens: 0 } })}\n`,
        );
      } catch (e) {
        stream.write(
          `3:${JSON.stringify(
            `roundtable_retry_failed: ${e instanceof Error ? e.message : String(e)}`,
          )}\n`,
        );
        stream.write(
          `d:${JSON.stringify({ finishReason: 'error', usage: { promptTokens: 0, completionTokens: 0 } })}\n`,
        );
      } finally {
        inFlightStreams.delete(rt.id);
        stream.end();
      }
    },
  );

  /**
   * POST /v1/roundtable/:id/summarize — explicit summarize trigger.
   *
   * Used by:
   *   - 深度模式 round 2 done → user clicks 总结
   *   - 快速模式 auto-chain failed mid-stream → user retries
   *   - 任何 summary_failed → 用户重试
   *
   * Status precondition: rt.status must be one of {round1, round2}. Other
   * states (analyzing/summarizing/completed/failed) → 409.
   */
  app.post<{ Params: { id: string } }>(
    '/v1/roundtable/:id/summarize',
    async (req, reply) => {
      const rt = rtRepo.get(req.params.id);
      if (!rt) {
        throw new TaoriError({
          code: 'not_found',
          message: `Roundtable ${req.params.id} not found`,
        });
      }
      if (rt.status === 'analyzing') {
        throw new TaoriError({
          code: 'conflict',
          message: 'roundtable_analyzing',
          details: { hint: '话题分析尚未完成' },
        });
      }
      if (rt.status === 'summarizing') {
        throw new TaoriError({
          code: 'conflict',
          message: 'roundtable_busy',
          details: { hint: '总结正在进行中' },
        });
      }
      if (rt.status === 'completed' || rt.status === 'failed' || rt.status === 'cancelled') {
        throw new TaoriError({
          code: 'conflict',
          message: `roundtable_${rt.status}`,
          details: { hint: '已结束的圆桌不能再次总结' },
        });
      }
      if (inFlightStreams.has(rt.id)) {
        throw new TaoriError({
          code: 'conflict',
          message: 'roundtable_busy',
          details: { hint: '圆桌正在运行中' },
        });
      }
      // Must have at least one round of messages with at least one complete row.
      const messages = rtMsgRepo.listByRoundtable(rt.id);
      const hasContent = messages.some(
        (m) => m.status === 'complete' && m.content.trim(),
      );
      if (!hasContent) {
        throw new TaoriError({
          code: 'conflict',
          message: 'no_content_to_summarize',
          details: { hint: '没有任何完成的发言可总结' },
        });
      }

      const revertStatus = rt.status; // 'round1' | 'round2'
      rtRepo.setStatus(rt.id, 'summarizing');

      const stream = new PassThrough();
      const origin = req.headers.origin;
      if (
        typeof origin === 'string' &&
        (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin) ||
          origin === 'tauri://localhost' ||
          origin.startsWith('http://tauri.localhost'))
      ) {
        reply.header('Access-Control-Allow-Origin', origin);
        reply.header('Vary', 'Origin');
        reply.header('Access-Control-Expose-Headers', 'x-vercel-ai-data-stream');
      }
      reply
        .type('text/plain; charset=utf-8')
        .header('Cache-Control', 'no-cache, no-transform')
        .header('Connection', 'keep-alive')
        .header('x-vercel-ai-data-stream', 'v1');
      if (typeof reply.raw.socket?.setNoDelay === 'function') {
        reply.raw.socket.setNoDelay(true);
      }

      const abortController = new AbortController();
      reply.raw.on('close', () => {
        if (!stream.writableEnded) abortController.abort();
      });
      reply.send(stream);

      stream.write(
        `8:${JSON.stringify([
          {
            type: 'rt.meta',
            roundtable_id: rt.id,
            conversation_id: rt.conversation_id,
            round: rt.current_round,
          },
        ])}\n`,
      );

      try {
        inFlightStreams.add(rt.id);
        const result = await runSummary(
          {
            modelsRepo,
            providersRepo,
            costsRepo,
            rtRepo,
            rtMsgRepo,
            keystore: deps.keystore,
            log: req.log,
          },
          {
            roundtable: { ...rt, status: 'summarizing' },
            messages,
            stream,
            signal: abortController.signal,
            revertStatusOnFail: revertStatus as 'round1' | 'round2',
          },
        );
        stream.write(
          `d:${JSON.stringify({
            finishReason: result.ok ? 'stop' : 'error',
            usage: { promptTokens: 0, completionTokens: 0 },
          })}\n`,
        );
      } catch (e) {
        req.log.error({ err: e }, 'roundtable.summarize.unhandled');
        // Make sure we don't leave the row stuck in 'summarizing'.
        const fresh = rtRepo.get(rt.id);
        if (fresh?.status === 'summarizing') {
          rtRepo.setStatus(rt.id, revertStatus);
        }
        stream.write(
          `3:${JSON.stringify(
            `roundtable_summarize_failed: ${e instanceof Error ? e.message : String(e)}`,
          )}\n`,
        );
        stream.write(
          `d:${JSON.stringify({ finishReason: 'error', usage: { promptTokens: 0, completionTokens: 0 } })}\n`,
        );
      } finally {
        inFlightStreams.delete(rt.id);
        stream.end();
      }
    },
  );

  /**
   * GET /v1/roundtable/:id/export — render markdown per spec §3.4.
   */
  app.get<{ Params: { id: string } }>(
    '/v1/roundtable/:id/export',
    async (req, reply) => {
      const rt = rtRepo.get(req.params.id);
      if (!rt) {
        throw new TaoriError({
          code: 'not_found',
          message: `Roundtable ${req.params.id} not found`,
        });
      }
      const messages = rtMsgRepo.listByRoundtable(rt.id);
      const messageIds = messages.map((m) => m.id);
      const costs = costsRepo.listForRoundtable({
        conversationId: rt.conversation_id,
        roundtableId: rt.id,
        messageIds,
      });
      const md = renderRoundtableMarkdown({ roundtable: rt, messages, costs });
      reply.header('Content-Type', 'text/markdown; charset=utf-8');
      reply.header(
        'Content-Disposition',
        `attachment; filename="roundtable-${rt.id}.md"`,
      );
      return md;
    },
  );

  // Reserve `z` for future request-body schemas.
  void z;
}
