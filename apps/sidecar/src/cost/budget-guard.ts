import {
  calculateCostUsd,
  estimateInputTokens,
  type CostConfirmationRequiredDetails,
  type Model,
  TaoriError,
} from '@taori/shared';
import type { CostsRepo, MemoriesRepo } from '../db/repos/index.js';

export type BudgetDecisionKind = 'allow' | 'confirm' | 'block';
export type BudgetReason = 'threshold' | 'budget';
export type BudgetPeriod = 'month' | 'day';

export interface BudgetGuardInput {
  confirmed: boolean;
  conversationId: string | null;
  model: Model;
  inputText: string;
  estimatedCostUsd?: number;
  costsRepo: CostsRepo;
  memoriesRepo: MemoriesRepo;
  thresholdKey?: string;
  disabledModelsKey?: string;
  disabledConversationsKey?: string;
  monthlyBudgetKey?: string;
  hardLimitKey?: string;
  dailyBudgetKey?: string;
  dailyHardLimitKey?: string;
  defaultThresholdUsd?: number;
  defaultOutputTokens?: number;
  softBudgetEnabled?: boolean;
}

export interface BudgetDecision {
  kind: BudgetDecisionKind;
  reason: BudgetReason | null;
  /** Which period a budget breach is on. Only meaningful when reason === 'budget'. */
  period: BudgetPeriod | null;
  estimate_usd: number;
  threshold_usd: number | null;
  monthly_budget_usd: number | null;
  month_spent_usd: number;
  daily_budget_usd: number | null;
  day_spent_usd: number;
  hard_limit: boolean;
}

function parseNumber(raw: string | null, fallback: number | null): number | null {
  if (raw == null || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function parseBoolean(raw: string | null, fallback = false): boolean {
  if (raw == null || raw.trim() === '') return fallback;
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseStringArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function estimateModelCallCostUsd(input: {
  model: Model;
  inputText: string;
  outputTokens: number;
}): number {
  const inputTokens = estimateInputTokens(input.inputText);
  const cost = calculateCostUsd({
    inputTokens,
    outputTokens: input.outputTokens,
    priceInputPer1m: input.model.price_input_per_1m ?? null,
    priceOutputPer1m: input.model.price_output_per_1m ?? null,
    pricePerCall: input.model.price_per_call ?? null,
  });
  return cost ?? 0;
}

export function evaluateBudgetGuard(input: BudgetGuardInput): BudgetDecision {
  const thresholdKey = input.thresholdKey ?? 'cost_confirm_threshold_usd';
  const disabledModelsKey = input.disabledModelsKey ?? 'cost_confirm_disabled_models';
  const disabledConversationsKey =
    input.disabledConversationsKey ?? 'cost_confirm_disabled_conversations';
  const monthlyBudgetKey = input.monthlyBudgetKey ?? 'monthly_budget_usd';
  const hardLimitKey = input.hardLimitKey ?? 'monthly_budget_hard_limit';
  const dailyBudgetKey = input.dailyBudgetKey ?? 'daily_budget_usd';
  const dailyHardLimitKey = input.dailyHardLimitKey ?? 'daily_budget_hard_limit';

  const disabledModels = parseStringArray(
    input.memoriesRepo.getEffective(input.conversationId, disabledModelsKey),
  );
  const disabledConversations = parseStringArray(
    input.memoriesRepo.getEffective(input.conversationId, disabledConversationsKey),
  );
  const thresholdDisabled =
    disabledModels.includes(input.model.id) ||
    (input.conversationId != null && disabledConversations.includes(input.conversationId));

  const avgOutput = input.costsRepo.avgOutputTokens(input.model.id);
  const outputTokens = avgOutput.avg_output_tokens || (input.defaultOutputTokens ?? 800);
  const estimateUsd =
    input.estimatedCostUsd ??
    estimateModelCallCostUsd({
      model: input.model,
      inputText: input.inputText,
      outputTokens,
    });
  const thresholdUsd = parseNumber(
    input.memoriesRepo.getEffective(input.conversationId, thresholdKey),
    input.defaultThresholdUsd ?? 0.20,
  );
  const monthlyBudgetUsd = parseNumber(
    input.memoriesRepo.getEffective(null, monthlyBudgetKey),
    null,
  );
  const monthlyHardLimit = parseBoolean(input.memoriesRepo.getEffective(null, hardLimitKey), false);
  const dailyBudgetUsd = parseNumber(
    input.memoriesRepo.getEffective(null, dailyBudgetKey),
    null,
  );
  const dailyHardLimit = parseBoolean(
    input.memoriesRepo.getEffective(null, dailyHardLimitKey),
    false,
  );
  const softBudgetEnabled = input.softBudgetEnabled ?? true;
  const realtime = input.costsRepo.realtime(input.conversationId);
  const monthSpentUsd = realtime.month_usd;
  const daySpentUsd = realtime.today_usd;

  const wouldExceedMonthly =
    monthlyBudgetUsd != null &&
    monthlyBudgetUsd > 0 &&
    monthSpentUsd + estimateUsd >= monthlyBudgetUsd;
  const wouldExceedDaily =
    dailyBudgetUsd != null &&
    dailyBudgetUsd > 0 &&
    daySpentUsd + estimateUsd >= dailyBudgetUsd;

  const baseSnapshot = {
    estimate_usd: estimateUsd,
    threshold_usd: thresholdUsd,
    monthly_budget_usd: monthlyBudgetUsd,
    month_spent_usd: monthSpentUsd,
    daily_budget_usd: dailyBudgetUsd,
    day_spent_usd: daySpentUsd,
  };

  // Hard limits are enforced regardless of `confirmed`. Daily is checked first
  // because it's the tighter window — exceeding the day implicitly means we
  // also can't safely promise to honour the month.
  if (wouldExceedDaily && dailyHardLimit) {
    return {
      kind: 'block',
      reason: 'budget',
      period: 'day',
      ...baseSnapshot,
      hard_limit: true,
    };
  }
  if (wouldExceedMonthly && monthlyHardLimit) {
    return {
      kind: 'block',
      reason: 'budget',
      period: 'month',
      ...baseSnapshot,
      hard_limit: true,
    };
  }

  if (input.confirmed) {
    return {
      kind: 'allow',
      reason: null,
      period: null,
      ...baseSnapshot,
      hard_limit: monthlyHardLimit || dailyHardLimit,
    };
  }

  if (wouldExceedDaily && softBudgetEnabled) {
    return {
      kind: 'confirm',
      reason: 'budget',
      period: 'day',
      ...baseSnapshot,
      hard_limit: false,
    };
  }
  if (wouldExceedMonthly && softBudgetEnabled) {
    return {
      kind: 'confirm',
      reason: 'budget',
      period: 'month',
      ...baseSnapshot,
      hard_limit: false,
    };
  }

  if (
    !thresholdDisabled &&
    thresholdUsd != null &&
    thresholdUsd >= 0 &&
    estimateUsd > thresholdUsd
  ) {
    return {
      kind: 'confirm',
      reason: 'threshold',
      period: null,
      ...baseSnapshot,
      hard_limit: monthlyHardLimit || dailyHardLimit,
    };
  }

  return {
    kind: 'allow',
    reason: null,
    period: null,
    ...baseSnapshot,
    hard_limit: monthlyHardLimit || dailyHardLimit,
  };
}

export function throwIfBudgetBlockedOrNeedsConfirmation(
  input: BudgetGuardInput,
): BudgetDecision {
  const decision = evaluateBudgetGuard(input);
  if (decision.kind === 'allow') return decision;

  const periodLabel = decision.period === 'day' ? '今日' : '本月';
  const message =
    decision.kind === 'block'
      ? `${periodLabel}硬预算上限将被超过，请先调整预算后再继续。`
      : decision.reason === 'budget'
        ? `本次调用将达到或超过${periodLabel}预算，请确认后再继续。`
        : '本次调用预估费用超过确认阈值，请确认后再继续。';

  throw new TaoriError({
    code: 'cost_confirmation_required',
    message,
    details: {
      reason: decision.reason ?? 'threshold',
      period: decision.period ?? undefined,
      estimate_usd: decision.estimate_usd,
      model_id: input.model.id,
      model_name: input.model.display_name ?? input.model.model_name,
      conversation_id: input.conversationId,
      threshold_usd: decision.threshold_usd,
      monthly_budget_usd: decision.monthly_budget_usd,
      month_spent_usd: decision.month_spent_usd,
      daily_budget_usd: decision.daily_budget_usd,
      day_spent_usd: decision.day_spent_usd,
      hard_limit: decision.hard_limit,
      blocked: decision.kind === 'block',
    } satisfies CostConfirmationRequiredDetails & {
      hard_limit: boolean;
      blocked: boolean;
    },
  });
}
