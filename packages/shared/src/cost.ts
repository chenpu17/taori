import { countInputTokens } from './tokens.js';

/**
 * Cost-related pure helpers — shared by sidecar (cost calculation) and
 * renderer (price badge + estimate text). No DB / no fetch / no DOM.
 *
 * Tier thresholds (from docs/product/08-m1-spec.md §5.1, MC-6): based on
 * input price per 1M tokens. Three badges as specified by the product
 * acceptance criteria — 💰 / 💰💰 / 💰💰💰. Models priced at ≥ $15/1M input
 * fall under the highest tier rather than introducing a fourth badge.
 *
 *   cheap   <  $0.5 per 1M input → 💰
 *   mid     <  $5   per 1M input → 💰💰
 *   premium ≥  $5   per 1M input → 💰💰💰
 *   unknown (no price data)      → –
 */

export type PriceTier = 'cheap' | 'mid' | 'premium' | 'unknown';

export function priceTier(inputPricePer1m: number | null | undefined): PriceTier {
  if (inputPricePer1m == null) return 'unknown';
  if (inputPricePer1m < 0.5) return 'cheap';
  if (inputPricePer1m < 5) return 'mid';
  return 'premium';
}

export const PRICE_TIER_LABEL: Record<PriceTier, string> = {
  cheap: '💰',
  mid: '💰💰',
  premium: '💰💰💰',
  unknown: '–',
};

export interface CostInput {
  inputTokens: number;
  outputTokens: number;
  callCount?: number;
  priceInputPer1m?: number | null;
  priceOutputPer1m?: number | null;
  pricePerCall?: number | null;
}

/**
 * Returns USD cost rounded to 6 decimal places. Returns null if no usable
 * price data is provided (so callers can decide whether to display "—").
 */
export function calculateCostUsd(input: CostInput): number | null {
  const calls = input.callCount ?? 1;
  let total = 0;
  let usable = false;
  if (input.priceInputPer1m != null && input.inputTokens > 0) {
    total += (input.inputTokens / 1_000_000) * input.priceInputPer1m;
    usable = true;
  }
  if (input.priceOutputPer1m != null && input.outputTokens > 0) {
    total += (input.outputTokens / 1_000_000) * input.priceOutputPer1m;
    usable = true;
  }
  if (input.pricePerCall != null && calls > 0) {
    total += input.pricePerCall * calls;
    usable = true;
  }
  if (!usable) return null;
  return Math.round(total * 1_000_000) / 1_000_000;
}

/** Compact display, e.g. $0.0123 or $0.000045. */
export function formatUsd(usd: number | null | undefined): string {
  if (usd == null) return '—';
  if (usd === 0) return '$0';
  if (Math.abs(usd) < 0.0001) return `$${usd.toExponential(1)}`;
  if (Math.abs(usd) < 0.01) return `$${usd.toFixed(5)}`;
  if (Math.abs(usd) < 1) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function estimateInputTokens(text: string): number {
  return countInputTokens(text);
}

/**
 * Pre-send cost estimate. When `sampleCount` is small (<5) we surface a
 * range so the renderer can show "$0.0001 – $0.0005" — see §5.1
 * "样本<5 时显示区间". The lower bound assumes ~30% of the rolling avg
 * (short replies); the upper bound assumes 1.5× (long replies). When the
 * sample is healthy we just return a single point.
 */
export interface EstimateCostArgs {
  inputTokens: number;
  avgOutputTokens: number;
  sampleCount: number;
  priceInputPer1m: number | null | undefined;
  priceOutputPer1m: number | null | undefined;
  pricePerCall?: number | null;
}
export function estimateCostUsd(args: EstimateCostArgs): {
  point: number | null;
  low: number | null;
  high: number | null;
} {
  const point = calculateCostUsd({
    inputTokens: args.inputTokens,
    outputTokens: args.avgOutputTokens || 0,
    priceInputPer1m: args.priceInputPer1m ?? null,
    priceOutputPer1m: args.priceOutputPer1m ?? null,
    pricePerCall: args.pricePerCall ?? null,
  });
  if (point == null) return { point: null, low: null, high: null };
  if (args.sampleCount >= 5 || args.avgOutputTokens === 0) {
    return { point, low: point, high: point };
  }
  const low = calculateCostUsd({
    inputTokens: args.inputTokens,
    outputTokens: Math.round(args.avgOutputTokens * 0.3),
    priceInputPer1m: args.priceInputPer1m ?? null,
    priceOutputPer1m: args.priceOutputPer1m ?? null,
    pricePerCall: args.pricePerCall ?? null,
  });
  const high = calculateCostUsd({
    inputTokens: args.inputTokens,
    outputTokens: Math.round(args.avgOutputTokens * 1.5),
    priceInputPer1m: args.priceInputPer1m ?? null,
    priceOutputPer1m: args.priceOutputPer1m ?? null,
    pricePerCall: args.pricePerCall ?? null,
  });
  return { point, low, high };
}
