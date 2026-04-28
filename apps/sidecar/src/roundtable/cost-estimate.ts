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
