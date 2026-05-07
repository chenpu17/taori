/**
 * M3.A.3 — Roundtable summarizer (stage C).
 *
 * Calls `roundtable.summarizer_model_id` with a fixed prompt asking for strict
 * JSON. Validates against `SummarySchema`. On invalid JSON / schema, retries
 * once with temperature 0.1; if both attempts fail emits `rt.summary_failed`
 * with `fallback_text` (concatenation of all participant statements + manual
 * summary nudge).
 *
 * Streaming: writes `rt.summary_delta` for each chunk so the UI can render
 * the JSON arriving live (renderer parses lazily on the final `rt.summary_done`).
 *
 * Cost: writes one `cost_records` row per attempt with
 * `source_type='summarizer'`, `source_id=<roundtable.id>`,
 * `feature='roundtable'`.
 *
 * On success persists `roundtables.summary` + sets `status='completed'`.
 * On final failure leaves `summary=null` and reverts status to whatever the
 * caller set BEFORE 'summarizing' (so the user can retry).
 *
 * Spec refs: docs/product/10-m3a-roundtable-spec.md §3.4, §4.3, §7.5/7.6.
 */

import type { PassThrough } from 'node:stream';
import { streamText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import {
  SummarySchema,
  calculateCostUsd,
  type RoundtableAnnotation,
  type Model,
  type Provider,
  type RoundtableSummary,
} from '@taori/shared';
import type {
  CostsRepo,
  ModelsRepo,
  ProvidersRepo,
  RunEventInsert,
  RoundtableMessageRow,
  RoundtableMessagesRepo,
  RoundtableRow,
  RoundtablesRepo,
} from '../db/repos/index.js';
import type { KeyStore } from '../keystore.js';
import { classifyProviderError } from '../providers/registry.js';
import { normalizeOllamaOpenAiBaseUrl } from '../providers/ollama.js';

export interface SummarizerDeps {
  modelsRepo: ModelsRepo;
  providersRepo: ProvidersRepo;
  costsRepo: CostsRepo;
  rtRepo: RoundtablesRepo;
  rtMsgRepo: RoundtableMessagesRepo;
  keystore: KeyStore;
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

export interface RunSummaryArgs {
  roundtable: RoundtableRow;
  /** All round messages used to build the summarizer prompt. */
  messages: RoundtableMessageRow[];
  stream: PassThrough;
  signal: AbortSignal;
  /**
   * Status to revert to on final failure. The route sets `summarizing` before
   * calling us; if both attempts fail we restore this so the user can retry.
   */
  revertStatusOnFail: RoundtableRow['status'];
}

export interface RunSummaryResult {
  ok: boolean;
  classification?: string;
  fallbackText?: string;
}

const SYSTEM_PROMPT = `你是一个圆桌总结员。下面是 {N} 位专家的圆桌讨论，请你输出严格的 JSON 总结。

输出要求：
- 严格按 JSON 形态输出，不要任何额外文本，不要 markdown 代码块包裹
- consensus / divergence / risks / next_steps 至少各 1 条；如确无相关内容请输出空字符串项作为占位
- divergence[i].positions[j].role 必须是上文 "【角色】" 内出现过的角色名
- recommended_decision 必须是一段文字，不是数组`;

function writeAnnotation(stream: PassThrough, ann: RoundtableAnnotation[]): void {
  stream.write(`8:${JSON.stringify(ann)}\n`);
}

function buildTranscript(rt: RoundtableRow, messages: RoundtableMessageRow[]): string {
  const sorted = [...messages]
    .filter((m) => m.status === 'complete' && m.content.trim())
    .sort((a, b) => a.round - b.round || a.participant_index - b.participant_index);
  const byRound: Record<number, string[]> = {};
  for (const m of sorted) {
    const role = rt.participants[m.participant_index]?.role_label
      ?? `参与者${m.participant_index + 1}`;
    (byRound[m.round] ??= []).push(`【${role}】\n${m.content}`);
  }
  const parts: string[] = [];
  for (const r of Object.keys(byRound).map(Number).sort()) {
    parts.push(`第 ${r} 轮发言：\n\n${byRound[r]!.join('\n\n')}`);
  }
  return parts.join('\n\n---\n\n');
}

function buildUserPrompt(rt: RoundtableRow, transcript: string): string {
  const N = rt.participants.length;
  return `话题：${rt.topic}

参与者（共 ${N} 位）：
${rt.participants.map((p, i) => `- 【${p.role_label}】(${p.display_name})`).join('\n')}

讨论内容：
${transcript}

请输出 JSON：
{
  "consensus": ["…", "…"],
  "divergence": [
    { "topic": "…", "positions": [{ "role": "…", "stance": "…" }] }
  ],
  "risks": ["…"],
  "recommended_decision": "…",
  "next_steps": ["…"]
}`;
}

function tryParseJson(raw: string): unknown {
  const trimmed = raw.trim();
  const stripped = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '');
  try {
    return JSON.parse(stripped);
  } catch {
    const m = /\{[\s\S]*\}/.exec(stripped);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

function buildFallbackText(rt: RoundtableRow, messages: RoundtableMessageRow[]): string {
  const transcript = buildTranscript(rt, messages);
  return [
    `## 总结（自动总结失败）`,
    ``,
    `自动总结尝试失败两次。原始讨论内容如下，请您手动总结：`,
    ``,
    transcript || '（无可用发言）',
  ].join('\n');
}

interface AttemptOutcome {
  ok: boolean;
  parsed?: RoundtableSummary;
  classification?: string;
  message?: string;
  raw: string;
  promptTokens: number | null;
  completionTokens: number | null;
  durationMs: number;
}

async function runOneAttempt(
  deps: SummarizerDeps,
  rt: RoundtableRow,
  model: Model,
  provider: Provider,
  apiKey: string,
  system: string,
  prompt: string,
  temperature: number,
  stream: PassThrough,
  signal: AbortSignal,
): Promise<AttemptOutcome> {
  const aiProvider = createOpenAI({
    baseURL: provider.type === 'ollama'
      ? normalizeOllamaOpenAiBaseUrl(provider.base_url)
      : provider.base_url.replace(/\/$/, ''),
    apiKey,
  });
  const startedAt = Date.now();
  let accumulated = '';
  try {
    const result = await streamText({
      model: aiProvider.chat(model.model_name),
      system,
      prompt,
      maxTokens: 1200,
      temperature,
      maxRetries: 0,
      abortSignal: signal,
    });
    for await (const delta of result.textStream) {
      if (signal.aborted) break;
      accumulated += delta;
      writeAnnotation(stream, [{ type: 'rt.summary_delta', text_chunk: delta }]);
    }
    const usage = await result.usage.catch(() => undefined);
    const finishReason = await result.finishReason.catch(() => undefined);
    const durationMs = Date.now() - startedAt;
    if (finishReason === 'content-filter') {
      return {
        ok: false,
        classification: 'content_filter',
        message: '内容被供应商安全策略拦截',
        raw: accumulated,
        promptTokens: usage?.promptTokens ?? null,
        completionTokens: usage?.completionTokens ?? null,
        durationMs,
      };
    }
    const parsed = tryParseJson(accumulated);
    if (!parsed) {
      return {
        ok: false,
        classification: 'invalid_json',
        message: 'summarizer 输出非合法 JSON',
        raw: accumulated,
        promptTokens: usage?.promptTokens ?? null,
        completionTokens: usage?.completionTokens ?? null,
        durationMs,
      };
    }
    const validated = SummarySchema.safeParse(parsed);
    if (!validated.success) {
      return {
        ok: false,
        classification: 'schema_invalid',
        message: validated.error.issues
          .map((i) => `${i.path.join('.')}:${i.message}`)
          .join('; '),
        raw: accumulated,
        promptTokens: usage?.promptTokens ?? null,
        completionTokens: usage?.completionTokens ?? null,
        durationMs,
      };
    }
    return {
      ok: true,
      parsed: validated.data,
      raw: accumulated,
      promptTokens: usage?.promptTokens ?? null,
      completionTokens: usage?.completionTokens ?? null,
      durationMs,
    };
  } catch (e) {
    const status = (e as { statusCode?: number; status?: number })?.statusCode
      ?? (e as { status?: number })?.status;
    const cls = classifyProviderError({ status, err: e });
    const message = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      classification: cls.classification,
      message: cls.message || message,
      raw: accumulated,
      promptTokens: null,
      completionTokens: null,
      durationMs: Date.now() - startedAt,
    };
  }
}

function recordAttemptCost(
  deps: SummarizerDeps,
  rt: RoundtableRow,
  model: Model,
  outcome: AttemptOutcome,
  success: boolean,
): string {
  const actual = success
    ? calculateCostUsd({
        inputTokens: outcome.promptTokens ?? 0,
        outputTokens: outcome.completionTokens ?? 0,
        callCount: 1,
        priceInputPer1m: model.price_input_per_1m,
        priceOutputPer1m: model.price_output_per_1m,
        pricePerCall: model.price_per_call,
      })
    : null;
  const row = deps.costsRepo.insert({
    conversation_id: rt.conversation_id,
    source_type: 'summarizer',
    source_id: rt.id,
    feature: 'roundtable',
    model_id: model.id,
    model_name_snapshot: model.model_name,
    input_tokens: outcome.promptTokens,
    output_tokens: outcome.completionTokens,
    call_count: 1,
    price_input_per_1m_snapshot: model.price_input_per_1m,
    price_output_per_1m_snapshot: model.price_output_per_1m,
    price_per_call_snapshot: model.price_per_call,
    estimated_cost_usd: null,
    actual_cost_usd: actual,
    success,
    duration_ms: outcome.durationMs,
  });
  deps.runEvents?.append({
    kind: 'cost.recorded',
    status: success ? 'completed' : 'failed',
    label: '总结成本',
    summary: actual == null ? outcome.classification ?? null : `$${actual.toFixed(6)}`,
    payload: {
      cost_record_id: row.id,
      model_id: model.id,
      roundtable_id: rt.id,
      input_tokens: outcome.promptTokens,
      output_tokens: outcome.completionTokens,
      actual_cost_usd: actual,
      success,
      classification: outcome.classification ?? null,
      duration_ms: outcome.durationMs,
    },
  });
  return row.id;
}

export async function runSummary(
  deps: SummarizerDeps,
  args: RunSummaryArgs,
): Promise<RunSummaryResult> {
  const { roundtable: rt, messages, stream, signal, revertStatusOnFail } = args;

  const summarizerModelId = rt.summarizer_model_id;
  if (!summarizerModelId) {
    const fallbackText = buildFallbackText(rt, messages);
    writeAnnotation(stream, [
      {
        type: 'rt.summary_failed',
        classification: 'unknown',
        message: '没有可用的总结模型 (summarizer_model_id is null)',
        fallback_text: fallbackText,
        model_id: null,
      },
    ]);
    deps.rtRepo.setStatus(rt.id, revertStatusOnFail);
    deps.runEvents?.append({
      kind: 'model.failed',
      status: 'failed',
      label: '圆桌总结',
      summary: '没有可用的总结模型',
      payload: {
        model_id: null,
        roundtable_id: rt.id,
        classification: 'unknown',
      },
    });
    return { ok: false, classification: 'unknown', fallbackText };
  }
  const model = deps.modelsRepo.get(summarizerModelId);
  const provider = model?.provider_id ? deps.providersRepo.get(model.provider_id) : null;
  if (!model || !provider || (!provider.api_key_ref && provider.type !== 'ollama')) {
    const fallbackText = buildFallbackText(rt, messages);
    writeAnnotation(stream, [
      {
        type: 'rt.summary_failed',
        classification: 'unknown',
        message: 'summarizer 模型或 provider 不可用',
        fallback_text: fallbackText,
        model_id: summarizerModelId,
      },
    ]);
    deps.rtRepo.setStatus(rt.id, revertStatusOnFail);
    deps.runEvents?.append({
      kind: 'model.failed',
      status: 'failed',
      label: '圆桌总结',
      summary: 'summarizer 模型或 provider 不可用',
      payload: {
        model_id: summarizerModelId,
        roundtable_id: rt.id,
        classification: 'unknown',
      },
    });
    return { ok: false, classification: 'unknown', fallbackText };
  }
  let apiKey: string | null = null;
  if (provider.type === 'ollama') {
    apiKey = 'ollama-local';
  } else {
    try {
      apiKey = await deps.keystore.read(provider.api_key_ref as string);
    } catch (e) {
      deps.log.warn({ err: e, model_id: model.id }, 'roundtable.summarize.keystore_read_failed');
    }
  }
  if (!apiKey) {
    const fallbackText = buildFallbackText(rt, messages);
    writeAnnotation(stream, [
      {
        type: 'rt.summary_failed',
        classification: 'unknown',
        message: 'summarizer 没有 API key',
        fallback_text: fallbackText,
        model_id: model.id,
      },
    ]);
    deps.rtRepo.setStatus(rt.id, revertStatusOnFail);
    deps.runEvents?.append({
      kind: 'model.failed',
      status: 'failed',
      label: model.display_name ?? model.model_name,
      summary: 'summarizer 没有 API key',
      payload: {
        model_id: model.id,
        model_name: model.model_name,
        roundtable_id: rt.id,
        classification: 'unknown',
      },
    });
    return { ok: false, classification: 'unknown', fallbackText };
  }

  const system = SYSTEM_PROMPT.replace('{N}', String(rt.participants.length));
  const transcript = buildTranscript(rt, messages);
  const prompt = buildUserPrompt(rt, transcript);

  // Attempt 1 — temperature 0.3.
  deps.runEvents?.append({
    kind: 'model.started',
    status: 'started',
    label: `圆桌总结 · ${model.display_name ?? model.model_name}`,
    summary: '总结尝试 1',
    payload: {
      model_id: model.id,
      model_name: model.model_name,
      roundtable_id: rt.id,
      stage: 'summarizer',
      attempt: 1,
    },
  });
  const a1 = await runOneAttempt(
    deps,
    rt,
    model,
    provider,
    apiKey,
    system,
    prompt,
    0.3,
    stream,
    signal,
  );
  if (a1.ok && a1.parsed) {
    const costId = recordAttemptCost(deps, rt, model, a1, true);
    deps.modelsRepo.recordSuccess(model.id);
    deps.rtRepo.setSummary(rt.id, a1.parsed);
    deps.rtRepo.setStatus(rt.id, 'completed');
    writeAnnotation(stream, [
      { type: 'rt.summary_done', summary: a1.parsed, cost_record_id: costId },
    ]);
    deps.runEvents?.append({
      kind: 'model.completed',
      status: 'completed',
      label: `圆桌总结 · ${model.display_name ?? model.model_name}`,
      summary: '总结完成',
      payload: {
        model_id: model.id,
        model_name: model.model_name,
        roundtable_id: rt.id,
        stage: 'summarizer',
        attempt: 1,
        input_tokens: a1.promptTokens,
        output_tokens: a1.completionTokens,
        duration_ms: a1.durationMs,
        cost_record_id: costId,
      },
    });
    return { ok: true };
  }
  // Record cost on failed JSON/schema attempt as success=true (we got tokens
  // back, just couldn't parse them). Provider errors recorded as success=false.
  const a1Billed =
    a1.classification === 'invalid_json' || a1.classification === 'schema_invalid';
  recordAttemptCost(deps, rt, model, a1, a1Billed);
  if (!a1Billed && a1.classification && a1.classification !== 'content_filter') {
    deps.modelsRepo.recordFailure(model.id, a1.classification);
  }

  // Attempt 2 — temperature 0.1, only if attempt 1 was a parse/schema failure
  // OR a transient provider error. content_filter and abort are terminal.
  if (a1.classification === 'content_filter' || signal.aborted) {
    const fallbackText = buildFallbackText(rt, messages);
    writeAnnotation(stream, [
      {
        type: 'rt.summary_failed',
        classification: a1.classification ?? 'abort',
        message: a1.message ?? 'aborted',
        fallback_text: fallbackText,
        model_id: model.id,
      },
    ]);
    deps.rtRepo.setStatus(rt.id, revertStatusOnFail);
    deps.runEvents?.append({
      kind: 'model.failed',
      status: 'failed',
      label: `圆桌总结 · ${model.display_name ?? model.model_name}`,
      summary: a1.message ?? 'aborted',
      payload: {
        model_id: model.id,
        model_name: model.model_name,
        roundtable_id: rt.id,
        stage: 'summarizer',
        attempt: 1,
        classification: a1.classification ?? 'abort',
        duration_ms: a1.durationMs,
      },
    });
    return { ok: false, classification: a1.classification, fallbackText };
  }

  deps.runEvents?.append({
    kind: 'model.failed',
    status: 'failed',
    label: `圆桌总结 · ${model.display_name ?? model.model_name}`,
    summary: a1.message ?? a1.classification ?? '总结尝试失败',
    payload: {
      model_id: model.id,
      model_name: model.model_name,
      roundtable_id: rt.id,
      stage: 'summarizer',
      attempt: 1,
      classification: a1.classification ?? 'unknown',
      duration_ms: a1.durationMs,
    },
  });

  deps.runEvents?.append({
    kind: 'model.started',
    status: 'started',
    label: `圆桌总结 · ${model.display_name ?? model.model_name}`,
    summary: '总结尝试 2',
    payload: {
      model_id: model.id,
      model_name: model.model_name,
      roundtable_id: rt.id,
      stage: 'summarizer',
      attempt: 2,
    },
  });
  const a2 = await runOneAttempt(
    deps,
    rt,
    model,
    provider,
    apiKey,
    system,
    prompt,
    0.1,
    stream,
    signal,
  );
  if (a2.ok && a2.parsed) {
    const costId = recordAttemptCost(deps, rt, model, a2, true);
    deps.modelsRepo.recordSuccess(model.id);
    deps.rtRepo.setSummary(rt.id, a2.parsed);
    deps.rtRepo.setStatus(rt.id, 'completed');
    writeAnnotation(stream, [
      { type: 'rt.summary_done', summary: a2.parsed, cost_record_id: costId },
    ]);
    deps.runEvents?.append({
      kind: 'model.completed',
      status: 'completed',
      label: `圆桌总结 · ${model.display_name ?? model.model_name}`,
      summary: '总结完成',
      payload: {
        model_id: model.id,
        model_name: model.model_name,
        roundtable_id: rt.id,
        stage: 'summarizer',
        attempt: 2,
        input_tokens: a2.promptTokens,
        output_tokens: a2.completionTokens,
        duration_ms: a2.durationMs,
        cost_record_id: costId,
      },
    });
    return { ok: true };
  }
  const a2Billed =
    a2.classification === 'invalid_json' || a2.classification === 'schema_invalid';
  recordAttemptCost(deps, rt, model, a2, a2Billed);
  if (!a2Billed && a2.classification && a2.classification !== 'content_filter') {
    deps.modelsRepo.recordFailure(model.id, a2.classification);
  }

  const fallbackText = buildFallbackText(rt, messages);
  writeAnnotation(stream, [
    {
      type: 'rt.summary_failed',
      classification: a2.classification ?? 'unknown',
      message: a2.message ?? '总结失败',
      fallback_text: fallbackText,
      model_id: model.id,
    },
  ]);
  deps.rtRepo.setStatus(rt.id, revertStatusOnFail);
  deps.runEvents?.append({
    kind: 'model.failed',
    status: 'failed',
    label: `圆桌总结 · ${model.display_name ?? model.model_name}`,
    summary: a2.message ?? '总结失败',
    payload: {
      model_id: model.id,
      model_name: model.model_name,
      roundtable_id: rt.id,
      stage: 'summarizer',
      attempt: 2,
      classification: a2.classification ?? 'unknown',
      duration_ms: a2.durationMs,
    },
  });
  return { ok: false, classification: a2.classification, fallbackText };
}
