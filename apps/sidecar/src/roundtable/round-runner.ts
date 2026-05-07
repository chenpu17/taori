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
import { streamText, tool } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';
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
  RunEventInsert,
  RoundtableMessageRow,
  RoundtableMessagesRepo,
  RoundtableRow,
  RoundtablesRepo,
  ProvidersRepo,
  MemoriesRepo,
} from '../db/repos/index.js';
import type { KeyStore } from '../keystore.js';
import { classifyProviderError } from '../providers/registry.js';
import { normalizeOllamaOpenAiBaseUrl } from '../providers/ollama.js';
import type { CapabilityBus } from '../bus/index.js';

export interface RoundRunnerDeps {
  modelsRepo: ModelsRepo;
  providersRepo: ProvidersRepo;
  costsRepo: CostsRepo;
  rtRepo: RoundtablesRepo;
  rtMsgRepo: RoundtableMessagesRepo;
  keystore: KeyStore;
  bus?: CapabilityBus | null;
  memoriesRepo?: MemoriesRepo | null;
  runEvents?: RoundtableRunEvents | null;
  log: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
}

export interface RoundtableRunEvents {
  runId: string;
  conversationId: string;
  append: (input: Omit<RunEventInsert, 'run_id' | 'conversation_id' | 'message_id'> & {
    message_id?: string | null;
  }) => void;
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

function summarizeToolValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value.slice(0, 220);
  try {
    return JSON.stringify(value).slice(0, 220);
  } catch {
    return String(value).slice(0, 220);
  }
}

function safeAiToolName(busName: string, used: Set<string>): string {
  const base = busName.replace(/^builtin\./, '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 58) || 'tool';
  let name = base;
  let i = 2;
  while (used.has(name)) {
    name = `${base.slice(0, 54)}_${i++}`;
  }
  used.add(name);
  return name;
}

function buildToolsForParticipant(args: {
  deps: RoundRunnerDeps;
  rt: RoundtableRow;
  round: 1 | 2;
  participantIndex: number;
  msgRow: RoundtableMessageRow;
  model: Model;
  stream: PassThrough;
}): { tools?: Record<string, any>; instruction: string | null } {
  const bus = args.deps.bus;
  if (!bus || !args.model.supports_tools) return { instruction: null };
  const used = new Set<string>();
  const exposed: Record<string, any> = {};
  const allowed = bus
    .list()
    .filter((item) => item.enabled)
    .filter(
      (item) =>
        item.name === 'builtin.web_search' ||
        item.name === 'builtin.web_fetch' ||
        item.source === 'mcp',
    );
  for (const item of allowed) {
    const aiName = safeAiToolName(item.name, used);
    exposed[aiName] = tool({
      description: item.description,
      parameters: z.record(z.unknown()),
      execute: async (input) => {
        const callId = `${args.msgRow.id}:${aiName}:${Date.now()}`;
        const startedAt = Date.now();
        args.deps.runEvents?.append({
          kind: 'tool.started',
          status: 'started',
          label: item.description,
          summary: item.name,
          payload: {
            tool_name: item.name,
            tool_label: item.description,
            roundtable_id: args.rt.id,
            round: args.round,
            participant_index: args.participantIndex,
            roundtable_message_id: args.msgRow.id,
            call_id: callId,
          },
        });
        writeAnnotation(args.stream, [
          {
            type: 'rt.tool_trace',
            participant_index: args.participantIndex,
            round: args.round,
            call_id: callId,
            tool: item.name,
            label: item.source === 'mcp' ? `MCP · ${item.description}` : item.description,
            event: 'start',
            input: summarizeToolValue(input),
          },
        ]);
        const result = await bus.invoke(item.name, input, {
          conversationId: args.rt.conversation_id,
          sourceMessageId: args.msgRow.id,
        });
        const output = result.ok ? result.output : result.error?.message;
        args.deps.runEvents?.append({
          kind: result.ok ? 'tool.completed' : 'tool.failed',
          status: result.ok ? 'completed' : 'failed',
          label: item.description,
          summary: summarizeToolValue(output),
          payload: {
            tool_name: item.name,
            tool_label: item.description,
            roundtable_id: args.rt.id,
            round: args.round,
            participant_index: args.participantIndex,
            roundtable_message_id: args.msgRow.id,
            call_id: callId,
            duration_ms: Date.now() - startedAt,
            ok: result.ok,
          },
        });
        writeAnnotation(args.stream, [
          {
            type: 'rt.tool_trace',
            participant_index: args.participantIndex,
            round: args.round,
            call_id: callId,
            tool: item.name,
            label: item.source === 'mcp' ? `MCP · ${item.description}` : item.description,
            event: 'finish',
            ok: result.ok,
            output: summarizeToolValue(output),
            duration_ms: Date.now() - startedAt,
          },
        ]);
        return result.ok ? result.output : { ok: false, error: result.error };
      },
    });
  }
  if (Object.keys(exposed).length === 0) return { instruction: null };
  return {
    tools: exposed,
    instruction:
      '你可以使用可用工具辅助发言。需要最新网页信息时使用 web_search/web_fetch；需要本地扩展能力时使用 MCP 工具。工具结果必须整合进你的观点，避免只复述工具输出。',
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
    deps.runEvents?.append({
      kind: 'model.started',
      status: 'started',
      label: `${participant.role_label} · ${model.display_name ?? model.model_name}`,
      summary: `第 ${round} 轮发言开始`,
      payload: {
        model_id: model.id,
        model_name: model.model_name,
        roundtable_id: rt.id,
        round,
        participant_index: index,
        roundtable_message_id: msgRow.id,
      },
    });
    const aiProvider = createOpenAI({
      baseURL: provider.type === 'ollama'
        ? normalizeOllamaOpenAiBaseUrl(provider.base_url)
        : provider.base_url.replace(/\/$/, ''),
      apiKey,
    });
    const roundtableTools = buildToolsForParticipant({
      deps,
      rt,
      round,
      participantIndex: index,
      msgRow,
      model,
      stream,
    });
    const result = await streamText({
      model: aiProvider.chat(model.model_name),
      system: roundtableTools.instruction ? `${system}\n\n${roundtableTools.instruction}` : system,
      prompt,
      maxTokens: 800,
      temperature: 0.6,
      maxRetries: 0,
      ...(roundtableTools.tools ? { tools: roundtableTools.tools, maxSteps: 3 } : {}),
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
      deps.runEvents?.append({
        kind: 'cost.recorded',
        status: 'failed',
        label: '参与者成本',
        summary: 'content_filter',
        payload: {
          cost_record_id: cost.id,
          model_id: model.id,
          roundtable_id: rt.id,
          round,
          participant_index: index,
          roundtable_message_id: msgRow.id,
          success: false,
          classification: 'content_filter',
        },
      });
      deps.runEvents?.append({
        kind: 'model.failed',
        status: 'failed',
        label: `${participant.role_label} · ${model.display_name ?? model.model_name}`,
        summary: '内容被供应商安全策略拦截',
        payload: {
          model_id: model.id,
          model_name: model.model_name,
          roundtable_id: rt.id,
          round,
          participant_index: index,
          roundtable_message_id: msgRow.id,
          classification: 'content_filter',
          duration_ms: Date.now() - startedAt,
        },
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
    deps.runEvents?.append({
      kind: 'cost.recorded',
      status: 'completed',
      label: '参与者成本',
      summary: actualCost == null ? null : `$${actualCost.toFixed(6)}`,
      payload: {
        cost_record_id: costRow.id,
        model_id: model.id,
        roundtable_id: rt.id,
        round,
        participant_index: index,
        roundtable_message_id: msgRow.id,
        input_tokens: promptTokens,
        output_tokens: completionTokens,
        actual_cost_usd: actualCost,
        success: true,
      },
    });
    deps.modelsRepo.recordSuccess(model.id);
    deps.runEvents?.append({
      kind: 'model.completed',
      status: 'completed',
      label: `${participant.role_label} · ${model.display_name ?? model.model_name}`,
      summary: accumulated.slice(0, 160),
      payload: {
        model_id: model.id,
        model_name: model.model_name,
        roundtable_id: rt.id,
        round,
        participant_index: index,
        roundtable_message_id: msgRow.id,
        input_tokens: promptTokens,
        output_tokens: completionTokens,
        duration_ms: Date.now() - startedAt,
        cost_record_id: costRow.id,
      },
    });

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
    deps.runEvents?.append({
      kind: 'cost.recorded',
      status: 'failed',
      label: '参与者成本',
      summary: cls.classification,
      payload: {
        model_id: model.id,
        roundtable_id: rt.id,
        round,
        participant_index: index,
        roundtable_message_id: msgRow.id,
        success: false,
        classification: cls.classification,
      },
    });
    deps.runEvents?.append({
      kind: 'model.failed',
      status: 'failed',
      label: `${participant.role_label} · ${model.display_name ?? model.model_name}`,
      summary: cls.message || message,
      payload: {
        model_id: model.id,
        model_name: model.model_name,
        roundtable_id: rt.id,
        round,
        participant_index: index,
        roundtable_message_id: msgRow.id,
        classification: cls.classification,
        duration_ms: Date.now() - startedAt,
      },
    });
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
    if (!model || !provider || (!provider.api_key_ref && provider.type !== 'ollama')) {
      deps.rtMsgRepo.update(msgRow.id, {
        status: 'failed',
        classification: 'unknown',
        error_message: 'model_or_provider_unavailable',
      });
      deps.runEvents?.append({
        kind: 'model.failed',
        status: 'failed',
        label: p.display_name,
        summary: 'model_or_provider_unavailable',
        payload: {
          model_id: p.model_id,
          roundtable_id: rt.id,
          round,
          participant_index: i,
          roundtable_message_id: msgRow.id,
          classification: 'unknown',
        },
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
    if (provider.type === 'ollama') {
      apiKey = 'ollama-local';
    } else {
      try {
        apiKey = await deps.keystore.read(provider.api_key_ref as string);
      } catch (e) {
        deps.log.warn({ err: e, model_id: model.id }, 'roundtable.round.keystore_read_failed');
      }
    }
    if (!apiKey) {
      deps.rtMsgRepo.update(msgRow.id, {
        status: 'failed',
        classification: 'unknown',
        error_message: 'no_api_key',
      });
      deps.runEvents?.append({
        kind: 'model.failed',
        status: 'failed',
        label: model.display_name ?? model.model_name,
        summary: 'no_api_key',
        payload: {
          model_id: model.id,
          model_name: model.model_name,
          roundtable_id: rt.id,
          round,
          participant_index: i,
          roundtable_message_id: msgRow.id,
          classification: 'unknown',
        },
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
