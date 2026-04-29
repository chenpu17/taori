/**
 * M3.A — pre-flight cost estimate for a roundtable instance.
 *
 * roundtable_estimate = analyzer + sum(participants × rounds) + summarizer
 *
 * We use a fixed token budget per participant call (avg 800 input / 600 output
 * — matches §4.4 of the spec) and let the actual cost_records reconcile the
 * truth post-call. The high estimate is `low × 1.6`.
 */

import { calculateCostUsd, type Model } from '@taori/shared';

export interface RoundtableEstimateArgs {
  mode: 'fast' | 'deep';
  analyzerModel: Model | null;
  participantModels: Model[];
  summarizerModel: Model;
  topicLength: number;
}

const ANALYZER_INPUT_TOKENS = 600;
const ANALYZER_OUTPUT_TOKENS = 600;
const PARTICIPANT_INPUT_TOKENS = 800;
const PARTICIPANT_OUTPUT_TOKENS = 600;
const SUMMARIZER_INPUT_TOKENS = 1500;
const SUMMARIZER_OUTPUT_TOKENS = 800;

function safeCost(...args: Parameters<typeof calculateCostUsd>): number {
  return calculateCostUsd(...args) ?? 0;
}

export function estimateRoundtableCostRange(args: RoundtableEstimateArgs): {
  low: number;
  high: number;
} {
  const rounds = args.mode === 'deep' ? 2 : 1;
  let low = 0;
  if (args.analyzerModel) {
    low += safeCost({
      inputTokens: ANALYZER_INPUT_TOKENS,
      outputTokens: ANALYZER_OUTPUT_TOKENS,
      priceInputPer1m: args.analyzerModel.price_input_per_1m,
      priceOutputPer1m: args.analyzerModel.price_output_per_1m,
      pricePerCall: args.analyzerModel.price_per_call,
    });
  }
  for (const p of args.participantModels) {
    low +=
      rounds *
      safeCost({
        inputTokens: PARTICIPANT_INPUT_TOKENS,
        outputTokens: PARTICIPANT_OUTPUT_TOKENS,
        priceInputPer1m: p.price_input_per_1m,
        priceOutputPer1m: p.price_output_per_1m,
        pricePerCall: p.price_per_call,
      });
  }
  low += safeCost({
    inputTokens: SUMMARIZER_INPUT_TOKENS,
    outputTokens: SUMMARIZER_OUTPUT_TOKENS,
    priceInputPer1m: args.summarizerModel.price_input_per_1m,
    priceOutputPer1m: args.summarizerModel.price_output_per_1m,
    pricePerCall: args.summarizerModel.price_per_call,
  });

  // Hard floor so renderer never displays $0.0000–$0.0000 for free models.
  if (low === 0) return { low: 0, high: 0 };
  return { low, high: low * 1.6 };
}

/**
 * A5 — derive call count + wall-clock duration range for a mode.
 *
 * Calls = (analyzer ? 1 : 0) + participants × rounds + summarizer(1)
 * Duration heuristic: each call ≈ 4–8s (LLM TTFB+streaming for ~600 tokens),
 *   participants run in parallel so per-round latency = 1 slot, not N.
 *   Total seconds ≈ (analyzer + rounds + summarizer) × {4..8}
 *   For deep mode rounds=2.
 */
export function estimateRoundtableCallsAndDuration(args: {
  mode: 'fast' | 'deep';
  hasAnalyzer: boolean;
  participantCount: number;
}): { calls: number; durationSecLow: number; durationSecHigh: number } {
  const rounds = args.mode === 'deep' ? 2 : 1;
  const calls =
    (args.hasAnalyzer ? 1 : 0) + args.participantCount * rounds + 1;
  const sequentialSlots = (args.hasAnalyzer ? 1 : 0) + rounds + 1;
  return {
    calls,
    durationSecLow: sequentialSlots * 4,
    durationSecHigh: sequentialSlots * 8,
  };
}

/**
 * A5 — build a friendly Chinese sentence explaining why the analyzer chose
 * this mode. Returns null when analyzer fell back (no signal to explain).
 */
export function buildAnalyzerModeReason(args: {
  topicType: string | null;
  complexity: 'low' | 'medium' | 'high' | null;
  requestedMode: 'fast' | 'deep' | 'auto';
  chosenMode: 'fast' | 'deep';
  analyzerFallback: boolean;
}): string | null {
  if (args.analyzerFallback) return null;
  if (args.requestedMode !== 'auto') {
    return `按你指定的「${args.chosenMode === 'deep' ? '深度' : '快速'}」模式运行。`;
  }
  const tt = args.topicType;
  const cx = args.complexity;
  if (!tt || !cx) return null;
  const typeLabel: Record<string, string> = {
    business: '商业决策',
    technical: '技术抉择',
    creative: '创意发散',
    decision: '决策类',
    research: '研究类',
    other: '一般话题',
  };
  const complexityLabel: Record<string, string> = {
    low: '复杂度较低',
    medium: '复杂度适中',
    high: '复杂度较高',
  };
  const tName = typeLabel[tt] ?? '一般话题';
  const cName = complexityLabel[cx] ?? '复杂度适中';
  if (args.chosenMode === 'deep') {
    return `分析器判定这是${tName}且${cName}，建议「深度」模式：盲审 + 互见反驳能更好揭示分歧。`;
  }
  return `分析器判定这是${tName}且${cName}，「快速」模式（一轮 + 总结）已足够覆盖主要观点。`;
}
