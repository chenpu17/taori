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
import { estimateRoundtableCostRange } from '../roundtable/cost-estimate.js';
import { runRound } from '../roundtable/round-runner.js';

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

    const inserted = rtRepo.insert({
      id: pendingId,
      conversation_id: conv.id,
      topic: body.topic,
      mode: analyzerOutput.suggested_mode,
      participants: analyzerOutput.participants,
      summarizer_model_id: analyzerOutput.summarizer_model_id,
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
    return { roundtable: rt, messages };
  });

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
      if (rt.status === 'round1' || rt.status === 'round2' || rt.status === 'summarizing') {
        throw new TaoriError({
          code: 'conflict',
          message: 'roundtable_busy',
          details: { hint: '圆桌正在运行中' },
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
            type: 'meta',
            roundtable_id: rt.id,
            conversation_id: rt.conversation_id,
            round: next,
          },
        ])}\n`,
      );

      try {
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
        stream.write(
          `d:${JSON.stringify({
            finishReason:
              result.failed.length >= Math.ceil(rt.participants.length / 2)
                ? 'error'
                : 'stop',
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
        stream.end();
      }
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
  }>(
    '/v1/roundtable/:id/round/:round/participant/:index/retry',
    async (req, reply) => {
      const rt = rtRepo.get(req.params.id);
      if (!rt) {
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
        index >= rt.participants.length
      ) {
        throw new TaoriError({
          code: 'validation_error',
          message: 'participant index out of range',
        });
      }
      const existing = rtMsgRepo.findOne(rt.id, round, index);
      if (!existing) {
        throw new TaoriError({
          code: 'not_found',
          message: 'roundtable message row not found — run the round first',
        });
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
            type: 'meta',
            roundtable_id: rt.id,
            conversation_id: rt.conversation_id,
            round,
            retry_index: index,
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
        stream.end();
      }
    },
  );

  // M3.A.1 placeholder so future pieces have a stable shape — quiet TS unused-var.
  void z;
}
