/**
 * M3.A — Topic Analyzer (stage A).
 *
 * Calls a low-cost chat model with a structured prompt, parses JSON, and
 * validates against AnalyzerOutputSchema. On any failure (no key, network,
 * malformed JSON, schema violation) the caller falls back to fixed personas
 * via buildFallbackOutput.
 *
 * Returns { result, costInsert } so the route can persist a cost_record
 * inside the same DB transaction it inserts the roundtable in.
 */

import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import {
  AnalyzerOutputSchema,
  calculateCostUsd,
  type AnalyzerOutput,
  type Model,
  type Provider,
} from '@taori/shared';
import type { KeyStore } from '../keystore.js';
import type { CostInsert } from '../db/repos/index.js';
import { FALLBACK_PERSONAS } from './fallback-personas.js';

export interface AnalyzerDeps {
  keystore: KeyStore;
  log: { warn: (...a: unknown[]) => void; info: (...a: unknown[]) => void };
}

export interface AnalyzerInput {
  topic: string;
  /** Suggested mode from user. 'auto' lets the analyzer decide. */
  requestedMode: 'fast' | 'deep' | 'auto';
  /** Catalog of enabled chat models the analyzer may pick from. */
  candidateModels: Pick<Model, 'id' | 'display_name' | 'model_name'>[];
  analyzerModel: Model;
  analyzerProvider: Provider;
}

export interface AnalyzerSuccess {
  ok: true;
  output: AnalyzerOutput;
  costInsert: CostInsert;
}

export interface AnalyzerFailure {
  ok: false;
  reason: 'no_key' | 'invalid_json' | 'schema_invalid' | 'upstream_error';
  message: string;
  costInsert: CostInsert | null;
}

const SYSTEM_PROMPT = `你是一个"圆桌主持人"。用户提出了一个话题，请分析它，并安排一组 AI 专家进行圆桌讨论。

要求：
- 角色之间视角差异化，避免同质化
- 至少包含一个"风险/反对"视角
- 选模型时考虑能力匹配（技术话题优先选擅长推理的）
- 严格按指定 JSON 形态输出，不要任何额外文本
- 不要使用 markdown 代码块包裹 JSON`;

function buildUserPrompt(input: AnalyzerInput): string {
  const modelLines = input.candidateModels
    .map((m) => `- ${m.id}: ${m.display_name} (${m.model_name})`)
    .join('\n');

  const modeHint =
    input.requestedMode === 'auto'
      ? '由你判断 suggested_mode（简单话题 fast，重要决策 deep）'
      : `用户已指定 suggested_mode="${input.requestedMode}"`;

  return `【话题】${input.topic}

【可用聊天模型】
${modelLines}

【模式提示】${modeHint}

请输出 JSON：
{
  "topic_type": "business" | "technical" | "creative" | "decision" | "research" | "other",
  "complexity": "low" | "medium" | "high",
  "suggested_mode": "fast" | "deep",
  "participant_count": 2 | 3 | 4,
  "participants": [
    {
      "model_id": "<必须来自上方列表>",
      "display_name": "<对应的 display_name>",
      "role_label": "<8字以内中文>",
      "persona_prompt": "<以你是开头的中文角色 prompt，控制 300 字以内>"
    }
  ],
  "summarizer_model_id": "<从上方列表选一个>"
}`;
}

/** Try to extract valid JSON from a noisy LLM output. */
function tryParseJson(raw: string): unknown {
  const trimmed = raw.trim();
  // strip markdown fences if present
  const stripped = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '');
  try {
    return JSON.parse(stripped);
  } catch {
    // fall back: extract first {...} block
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

function makeCostInsert(
  conversationId: string,
  roundtableId: string,
  model: Model,
  inputTokens: number | null,
  outputTokens: number | null,
  success: boolean,
  durationMs: number,
): CostInsert {
  const actual = success
    ? calculateCostUsd({
        inputTokens: inputTokens ?? 0,
        outputTokens: outputTokens ?? 0,
        callCount: 1,
        priceInputPer1m: model.price_input_per_1m,
        priceOutputPer1m: model.price_output_per_1m,
        pricePerCall: model.price_per_call,
      })
    : null;
  return {
    conversation_id: conversationId,
    source_type: 'topic_analyzer',
    source_id: roundtableId,
    feature: 'roundtable',
    model_id: model.id,
    model_name_snapshot: model.model_name,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    call_count: 1,
    price_input_per_1m_snapshot: model.price_input_per_1m,
    price_output_per_1m_snapshot: model.price_output_per_1m,
    price_per_call_snapshot: model.price_per_call,
    estimated_cost_usd: null,
    actual_cost_usd: actual,
    success,
    duration_ms: durationMs,
  };
}

function isReservedInvalidBaseUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase().endsWith('.invalid');
  } catch {
    return false;
  }
}

export async function runAnalyzer(
  deps: AnalyzerDeps,
  input: AnalyzerInput,
  pendingRoundtableId: string,
  conversationId: string,
): Promise<AnalyzerSuccess | AnalyzerFailure> {
  if (!input.analyzerProvider.api_key_ref) {
    return {
      ok: false,
      reason: 'no_key',
      message: 'analyzer model provider has no api key',
      costInsert: makeCostInsert(
        conversationId,
        pendingRoundtableId,
        input.analyzerModel,
        null,
        null,
        false,
        0,
      ),
    };
  }
  let apiKey: string | null = null;
  try {
    apiKey = await deps.keystore.read(input.analyzerProvider.api_key_ref);
  } catch (e) {
    deps.log.warn({ err: e }, 'roundtable.analyzer.keystore_read_failed');
  }
  if (!apiKey) {
    return {
      ok: false,
      reason: 'no_key',
      message: 'keystore returned empty key',
      costInsert: makeCostInsert(
        conversationId,
        pendingRoundtableId,
        input.analyzerModel,
        null,
        null,
        false,
        0,
      ),
    };
  }
  if (isReservedInvalidBaseUrl(input.analyzerProvider.base_url)) {
    return {
      ok: false,
      reason: 'upstream_error',
      message: 'analyzer provider base_url uses reserved .invalid host',
      costInsert: makeCostInsert(
        conversationId,
        pendingRoundtableId,
        input.analyzerModel,
        null,
        null,
        false,
        0,
      ),
    };
  }

  const provider = createOpenAI({
    baseURL: input.analyzerProvider.base_url.replace(/\/$/, ''),
    apiKey,
  });
  const startedAt = Date.now();

  try {
    const result = await generateText({
      model: provider.chat(input.analyzerModel.model_name),
      system: SYSTEM_PROMPT,
      prompt: buildUserPrompt(input),
      temperature: 0.4,
      maxTokens: 1200,
    });
    const durationMs = Date.now() - startedAt;
    const usage = result.usage;
    const text = result.text ?? '';
    const parsed = tryParseJson(text);
    if (!parsed) {
      return {
        ok: false,
        reason: 'invalid_json',
        message: 'analyzer returned non-JSON output',
        costInsert: makeCostInsert(
          conversationId,
          pendingRoundtableId,
          input.analyzerModel,
          usage?.promptTokens ?? null,
          usage?.completionTokens ?? null,
          true,
          durationMs,
        ),
      };
    }
    const validated = AnalyzerOutputSchema.safeParse(parsed);
    if (!validated.success) {
      return {
        ok: false,
        reason: 'schema_invalid',
        message: validated.error.issues.map((i) => `${i.path.join('.')}:${i.message}`).join('; '),
        costInsert: makeCostInsert(
          conversationId,
          pendingRoundtableId,
          input.analyzerModel,
          usage?.promptTokens ?? null,
          usage?.completionTokens ?? null,
          true,
          durationMs,
        ),
      };
    }
    // belt-and-braces: ensure every participant.model_id is in the candidate
    // list; otherwise the analyzer hallucinated and we should fall back.
    const candidateIds = new Set(input.candidateModels.map((m) => m.id));
    const allValid = validated.data.participants.every((p) => candidateIds.has(p.model_id));
    if (!allValid) {
      return {
        ok: false,
        reason: 'schema_invalid',
        message: 'analyzer picked unknown model_id',
        costInsert: makeCostInsert(
          conversationId,
          pendingRoundtableId,
          input.analyzerModel,
          usage?.promptTokens ?? null,
          usage?.completionTokens ?? null,
          true,
          durationMs,
        ),
      };
    }
    if (!candidateIds.has(validated.data.summarizer_model_id)) {
      // fix up: use first candidate
      validated.data.summarizer_model_id = input.candidateModels[0]?.id ?? validated.data.participants[0]!.model_id;
    }
    return {
      ok: true,
      output: validated.data,
      costInsert: makeCostInsert(
        conversationId,
        pendingRoundtableId,
        input.analyzerModel,
        usage?.promptTokens ?? null,
        usage?.completionTokens ?? null,
        true,
        durationMs,
      ),
    };
  } catch (e) {
    const durationMs = Date.now() - startedAt;
    const message = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      reason: 'upstream_error',
      message,
      costInsert: makeCostInsert(
        conversationId,
        pendingRoundtableId,
        input.analyzerModel,
        null,
        null,
        false,
        durationMs,
      ),
    };
  }
}

/** Compose a deterministic AnalyzerOutput when analyzer fails. */
export function buildFallbackOutput(args: {
  participantModels: Model[];
  summarizerModelId: string;
  requestedMode: 'fast' | 'deep' | 'auto';
}): AnalyzerOutput {
  const personas = FALLBACK_PERSONAS;
  const participants = personas.map((p, i) => {
    const m = args.participantModels[i % args.participantModels.length]!;
    return {
      model_id: m.id,
      display_name: m.display_name,
      role_label: p.role_label,
      persona_prompt: p.persona_prompt,
    };
  });
  return {
    topic_type: 'other' as const,
    complexity: 'medium' as const,
    suggested_mode: args.requestedMode === 'auto' ? 'fast' : args.requestedMode,
    participant_count: participants.length as 3,
    participants,
    summarizer_model_id: args.summarizerModelId,
  };
}
