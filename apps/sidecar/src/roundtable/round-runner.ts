/**
 * M3.A.2 — Round runner.
 *
 * Fans out a single round (1 or 2) of a roundtable in parallel:
 *   - For each participant, spawn one streamText() against its provider/model
 *   - Multiplex the deltas into one SSE response distinguished by participant_index
 *   - Each participant's lifecycle is independent — one quota error doesn't
 *     stop the others
 *   - At the end emit `rt.round_done` with completed/failed indices
 *   - If ≥⌈participants/2⌉ failed (e.g. 2/3, 3/4), set roundtable.status='failed'
 *
 * Wire format mirrors M2 chat: `8:` annotation frames carry rt.* events;
 * we don't emit `0:` text frames because the renderer associates content
 * via `participant_index`, not the message-level concat that useChat uses.
 */

import type { PassThrough } from 'node:stream';
import { streamText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import {
  calculateCostUsd,
  type Participant,
  type RoundtableAnnotation,
  type Model,
  type Provider,
} from '@taori/shared';
import type {
  CostsRepo,
  ModelsRepo,
  RoundtableMessageRow,
  RoundtableMessagesRepo,
  RoundtableRow,
  RoundtablesRepo,
  ProvidersRepo,
} from '../db/repos/index.js';
import type { KeyStore } from '../keystore.js';
import { classifyProviderError } from '../providers/registry.js';

export interface RoundRunnerDeps {
  modelsRepo: ModelsRepo;
  providersRepo: ProvidersRepo;
  costsRepo: CostsRepo;
  rtRepo: RoundtablesRepo;
  rtMsgRepo: RoundtableMessagesRepo;
  keystore: KeyStore;
  log: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
}

export interface RunRoundArgs {
  roundtable: RoundtableRow;
  round: 1 | 2;
  /** Already-existing round 1 messages — required when running round 2 (deep mode 互见). */
  priorRoundMessages: RoundtableMessageRow[];
  /** Multiplexed SSE output. Caller owns lifecycle / abort wiring. */
  stream: PassThrough;
  /** Aborted when the renderer disconnects. */
  signal: AbortSignal;
  /**
   * Optional restriction — only run participants at these indices. Used by
   * the per-participant retry route. If omitted, all participants run.
   */
  targetIndices?: number[];
}

const SYSTEM_PREAMBLE_R1 = `你正在参加一场圆桌讨论。请只用你被赋予的视角发言，不要替别人发言。
- 控制在 300 字以内
- 直接给出观点，不要复述对方
- 用中文`;

const SYSTEM_PREAMBLE_R2 = `这是圆桌的第二轮（互见反驳）。下面是第一轮各方发言；请基于这些发言，从你被赋予的视角出发，**反驳或补充**最值得讨论的点。
- 控制在 300 字以内
- 不要泛泛重复你已说过的内容
- 用中文`;

function writeAnnotation(
  stream: PassThrough,
  annotations: RoundtableAnnotation[],
): void {
  stream.write(`8:${JSON.stringify(annotations)}\n`);
}

/** Build the user-message payload for one participant of one round. */
function buildPromptForParticipant(args: {
  topic: string;
  participant: Participant;
  round: 1 | 2;
  priorRoundMessages: RoundtableMessageRow[];
  participants: Participant[];
}): { system: string; prompt: string } {
  const sys = `${args.participant.persona_prompt}\n\n${
    args.round === 1 ? SYSTEM_PREAMBLE_R1 : SYSTEM_PREAMBLE_R2
  }`;
  if (args.round === 1) {
    return { system: sys, prompt: `话题：${args.topic}` };
  }
  // round 2 — inject all round 1 contents (互见)
  const r1Lines = args.priorRoundMessages
    .filter((m) => m.round === 1 && m.status === 'complete' && m.content.trim())
    .map((m) => {
      const role =
        args.participants[m.participant_index]?.role_label ??
        `参与者${m.participant_index + 1}`;
      return `【${role}】\n${m.content}`;
    })
    .join('\n\n');
  return {
    system: sys,
    prompt: `话题：${args.topic}\n\n第一轮发言：\n${r1Lines}`,
  };
}

interface ParticipantRunResult {
  index: number;
  ok: boolean;
  classification?: string;
}

async function runOneParticipant(
  deps: RoundRunnerDeps,
  rt: RoundtableRow,
  round: 1 | 2,
  index: number,
  participant: Participant,
  participants: Participant[],
  priorRoundMessages: RoundtableMessageRow[],
  msgRow: RoundtableMessageRow,
  stream: PassThrough,
  signal: AbortSignal,
  model: Model,
  provider: Provider,
  apiKey: string,
): Promise<ParticipantRunResult> {
  const startedAt = Date.now();
  const { system, prompt } = buildPromptForParticipant({
    topic: rt.topic,
    participant,
    round,
    priorRoundMessages,
    participants,
  });

  let accumulated = '';
  try {
    deps.rtMsgRepo.update(msgRow.id, { status: 'streaming' });
    const aiProvider = createOpenAI({
      baseURL: provider.base_url.replace(/\/$/, ''),
      apiKey,
    });
    const result = await streamText({
      model: aiProvider.chat(model.model_name),
      system,
      prompt,
      maxTokens: 800,
      temperature: 0.6,
      maxRetries: 0,
      abortSignal: signal,
    });

    for await (const delta of result.textStream) {
      if (signal.aborted) break;
      accumulated += delta;
      writeAnnotation(stream, [
        {
          type: 'rt.participant_delta',
          participant_index: index,
          model_id: model.id,
          text_chunk: delta,
        },
      ]);
    }

    const usage = await result.usage.catch(() => undefined);
    const finishReason = await result.finishReason.catch(() => undefined);
    if (finishReason === 'content-filter') {
      // content_filter does NOT count toward failure_count_24h (M2 §7.5.2).
      deps.rtMsgRepo.update(msgRow.id, {
        status: 'failed',
        classification: 'content_filter',
        error_message: 'content_filter',
      });
      const cost = deps.costsRepo.insert({
        conversation_id: rt.conversation_id,
        source_type: 'roundtable_message',
        source_id: msgRow.id,
        feature: 'roundtable',
        model_id: model.id,
        model_name_snapshot: model.model_name,
        input_tokens: usage?.promptTokens ?? null,
        output_tokens: usage?.completionTokens ?? null,
        call_count: 1,
        price_input_per_1m_snapshot: model.price_input_per_1m,
        price_output_per_1m_snapshot: model.price_output_per_1m,
        price_per_call_snapshot: model.price_per_call,
        estimated_cost_usd: null,
        actual_cost_usd: null,
        success: false,
        duration_ms: Date.now() - startedAt,
      });
      writeAnnotation(stream, [
        {
          type: 'rt.participant_failed',
          participant_index: index,
          model_id: model.id,
          classification: 'content_filter',
          message: '内容被供应商安全策略拦截',
        },
      ]);
      void cost;
      return { index, ok: false, classification: 'content_filter' };
    }

    const promptTokens = usage?.promptTokens ?? null;
    const completionTokens = usage?.completionTokens ?? null;
    const actualCost = calculateCostUsd({
      inputTokens: promptTokens ?? 0,
      outputTokens: completionTokens ?? 0,
      callCount: 1,
      priceInputPer1m: model.price_input_per_1m,
      priceOutputPer1m: model.price_output_per_1m,
      pricePerCall: model.price_per_call,
    });

    deps.rtMsgRepo.update(msgRow.id, {
      status: 'complete',
      content: accumulated,
    });
    const costRow = deps.costsRepo.insert({
      conversation_id: rt.conversation_id,
      source_type: 'roundtable_message',
      source_id: msgRow.id,
      feature: 'roundtable',
      model_id: model.id,
      model_name_snapshot: model.model_name,
      input_tokens: promptTokens,
      output_tokens: completionTokens,
      call_count: 1,
      price_input_per_1m_snapshot: model.price_input_per_1m,
      price_output_per_1m_snapshot: model.price_output_per_1m,
      price_per_call_snapshot: model.price_per_call,
      estimated_cost_usd: null,
      actual_cost_usd: actualCost,
      success: true,
      duration_ms: Date.now() - startedAt,
    });
    deps.modelsRepo.recordSuccess(model.id);

    writeAnnotation(stream, [
      {
        type: 'rt.participant_done',
        participant_index: index,
        model_id: model.id,
        content: accumulated,
        cost_record_id: costRow.id,
      },
    ]);
    return { index, ok: true };
  } catch (e) {
    const status = (e as { statusCode?: number; status?: number })?.statusCode
      ?? (e as { status?: number })?.status;
    const cls = classifyProviderError({ status, err: e });
    const message = e instanceof Error ? e.message : String(e);
    deps.rtMsgRepo.update(msgRow.id, {
      status: 'failed',
      classification: cls.classification as never,
      error_message: cls.message || message,
      content: accumulated,
    });
    deps.costsRepo.insert({
      conversation_id: rt.conversation_id,
      source_type: 'roundtable_message',
      source_id: msgRow.id,
      feature: 'roundtable',
      model_id: model.id,
      model_name_snapshot: model.model_name,
      input_tokens: null,
      output_tokens: null,
      call_count: 1,
      price_input_per_1m_snapshot: model.price_input_per_1m,
      price_output_per_1m_snapshot: model.price_output_per_1m,
      price_per_call_snapshot: model.price_per_call,
      estimated_cost_usd: null,
      actual_cost_usd: null,
      success: false,
      duration_ms: Date.now() - startedAt,
    });
    if (cls.classification !== 'content_filter') {
      deps.modelsRepo.recordFailure(model.id, cls.classification);
    }
    writeAnnotation(stream, [
      {
        type: 'rt.participant_failed',
        participant_index: index,
        model_id: model.id,
        classification: cls.classification,
        message: cls.message || message,
      },
    ]);
    return { index, ok: false, classification: cls.classification };
  }
}

/**
 * Run one round to completion. Caller is responsible for opening the stream,
 * setting headers, and calling stream.end() / sending the final `d:` frame.
 */
export async function runRound(
  deps: RoundRunnerDeps,
  args: RunRoundArgs,
): Promise<{ completed: number[]; failed: number[] }> {
  const { roundtable: rt, round, priorRoundMessages, stream, signal, targetIndices } = args;
  const participants = rt.participants;
  const isRetry = !!(targetIndices && targetIndices.length > 0);
  const indicesToRun = targetIndices && targetIndices.length > 0
    ? targetIndices
    : participants.map((_, i) => i);

  // Update status & current_round only on full-round runs. Retries don't bump
  // the roundtable status — the row is already round1 / round2.
  if (!isRetry) {
    deps.rtRepo.setStatus(rt.id, round === 1 ? 'round1' : 'round2');
    deps.rtRepo.setRound(rt.id, round);
    writeAnnotation(stream, [
      {
        type: 'rt.round_start',
        round,
        participants_total: participants.length,
      },
    ]);
  }

  // Pre-create rows so retry/reconnect logic has stable ids. For retries,
  // findOne resolves the existing row; we don't insert duplicates.
  const msgRowsByIndex = new Map<number, RoundtableMessageRow>();
  for (const i of indicesToRun) {
    const p = participants[i]!;
    const existing = deps.rtMsgRepo.findOne(rt.id, round, i);
    if (existing) {
      msgRowsByIndex.set(i, existing);
    } else {
      msgRowsByIndex.set(
        i,
        deps.rtMsgRepo.insert({
          roundtable_id: rt.id,
          round,
          participant_index: i,
          model_id: p.model_id,
          status: 'pending',
          visible_to_others: true,
        }),
      );
    }
  }

  // Resolve model + key for each participant up front. If a model can't be
  // resolved we mark its row as failed immediately and skip the network call.
  const tasks = indicesToRun.map(async (i) => {
    const p = participants[i]!;
    const msgRow = msgRowsByIndex.get(i)!;
    const model = deps.modelsRepo.get(p.model_id);
    const provider = model?.provider_id
      ? deps.providersRepo.get(model.provider_id)
      : null;
    if (!model || !provider || !provider.api_key_ref) {
      deps.rtMsgRepo.update(msgRow.id, {
        status: 'failed',
        classification: 'unknown',
        error_message: 'model_or_provider_unavailable',
      });
      writeAnnotation(stream, [
        {
          type: 'rt.participant_failed',
          participant_index: i,
          model_id: p.model_id,
          classification: 'unknown',
          message: 'model_or_provider_unavailable',
        },
      ]);
      return { index: i, ok: false, classification: 'unknown' } as ParticipantRunResult;
    }
    let apiKey: string | null = null;
    try {
      apiKey = await deps.keystore.read(provider.api_key_ref);
    } catch (e) {
      deps.log.warn({ err: e, model_id: model.id }, 'roundtable.round.keystore_read_failed');
    }
    if (!apiKey) {
      deps.rtMsgRepo.update(msgRow.id, {
        status: 'failed',
        classification: 'unknown',
        error_message: 'no_api_key',
      });
      writeAnnotation(stream, [
        {
          type: 'rt.participant_failed',
          participant_index: i,
          model_id: model.id,
          classification: 'unknown',
          message: 'no_api_key',
        },
      ]);
      return { index: i, ok: false, classification: 'unknown' } as ParticipantRunResult;
    }
    return runOneParticipant(
      deps,
      rt,
      round,
      i,
      p,
      participants,
      priorRoundMessages,
      msgRow,
      stream,
      signal,
      model,
      provider,
      apiKey,
    );
  });

  const results = await Promise.all(tasks);
  const completed = results.filter((r) => r.ok).map((r) => r.index);
  const failed = results.filter((r) => !r.ok).map((r) => r.index);

  if (!isRetry) {
    writeAnnotation(stream, [
      { type: 'rt.round_done', round, completed_indices: completed, failed_indices: failed },
    ]);

    // Majority-failed → status='failed' (spec §3.2). Threshold = ceil(N/2).
    const half = Math.ceil(participants.length / 2);
    if (failed.length >= half) {
      deps.rtRepo.setStatus(rt.id, 'failed');
    }
  }

  return { completed, failed };
}
