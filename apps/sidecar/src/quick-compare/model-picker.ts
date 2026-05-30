import type { Model, Provider } from '@taori/shared';
import { TaoriError } from '@taori/shared';

export type QuickCompareCandidateRole = 'current' | 'cheap' | 'quality' | 'fallback';

export interface QuickCompareModelCandidate {
  model: Model;
  role: QuickCompareCandidateRole;
  reason: string;
}

export interface PickQuickCompareModelsArgs {
  models: Model[];
  providers?: Provider[];
  currentModelId?: string | null;
  requestedModelIds?: string[];
  now?: number;
}

function isEligibleChatModel(
  model: Model,
  providerById: Map<string, Provider>,
  enforceProviderState: boolean,
  now: number,
): boolean {
  const provider = model.provider_id ? providerById.get(model.provider_id) : null;
  return (
    (model.capability === 'chat' || model.capability === 'multimodal') &&
    model.enabled &&
    !model.demoted &&
    Boolean(model.provider_id) &&
    (!enforceProviderState || provider?.enabled === true) &&
    (model.disabled_until == null || model.disabled_until < now)
  );
}

function unitPrice(model: Model): number {
  // Normalize to comparable $/1M-input-tokens basis.
  // Token-priced models compared directly; per-call models estimated at
  // ~1000 input tokens/call so a $0.001/call model ≈ $1/1M tokens.
  if (model.price_input_per_1m != null) return model.price_input_per_1m;
  if (model.price_output_per_1m != null) return model.price_output_per_1m;
  if (model.price_per_call != null) return model.price_per_call * 1000;
  return Number.POSITIVE_INFINITY;
}

function qualityScore(model: Model): number {
  const contextScore = model.context_length ?? 0;
  const toolScore = model.supports_tools ? 500_000 : 0;
  const jsonScore = model.supports_json ? 100_000 : 0;
  const healthPenalty = model.failure_count_24h * 250_000;
  return contextScore + toolScore + jsonScore - healthPenalty;
}

function pushUnique(
  out: QuickCompareModelCandidate[],
  candidate: QuickCompareModelCandidate | null,
): void {
  if (!candidate) return;
  if (out.some((item) => item.model.id === candidate.model.id)) return;
  if (out.length >= 3) return;
  out.push(candidate);
}

function validationError(message: string): TaoriError {
  return new TaoriError({
    code: 'validation_error',
    message,
    can_retry: false,
  });
}

function modelLabel(model: Model | undefined, fallbackId: string): string {
  return model?.alias ?? model?.display_name ?? model?.model_name ?? fallbackId;
}

function ineligibleModelMessage(
  model: Model | undefined,
  id: string,
  providerById: Map<string, Provider>,
  enforceProviderState: boolean,
  currentModelId?: string | null,
): string {
  if (!model) {
    return '所选模型当前不可用于 Quick Compare。请重新选择启用中的聊天或多模态模型。';
  }
  const provider = model.provider_id ? providerById.get(model.provider_id) : null;
  if (enforceProviderState && !provider) {
    return `模型「${modelLabel(model, id)}」所属服务商不存在，当前不可用于 Quick Compare。`;
  }
  if (provider && !provider.enabled) {
    return `模型「${modelLabel(model, id)}」所属服务商「${provider.name}」已停用，当前不可用于 Quick Compare。`;
  }
  if (id === currentModelId) {
    return '当前会话模型暂不可用于 Quick Compare。请切换到启用中的聊天或多模态模型后重试。';
  }
  return `模型「${modelLabel(model, id)}」当前不可用于 Quick Compare。请确认它已启用、未降级且未被临时停用。`;
}

export function pickQuickCompareModels({
  models,
  providers,
  currentModelId,
  requestedModelIds,
  now = Date.now(),
}: PickQuickCompareModelsArgs): QuickCompareModelCandidate[] {
  const providerById = new Map((providers ?? []).map((provider) => [provider.id, provider]));
  const enforceProviderState = providers != null;
  const eligible = models.filter((model) => isEligibleChatModel(model, providerById, enforceProviderState, now));
  const byId = new Map(eligible.map((model) => [model.id, model]));
  const allById = new Map(models.map((model) => [model.id, model]));

  if (requestedModelIds && requestedModelIds.length > 0) {
    const ids = [...new Set(requestedModelIds)];
    if (ids.length < 2 || ids.length > 3) {
      throw validationError('Quick Compare 需要选择 2-3 个可用聊天模型。');
    }
    return ids.map((id, index) => {
      const model = byId.get(id);
      if (!model) {
        throw validationError(ineligibleModelMessage(allById.get(id), id, providerById, enforceProviderState, currentModelId));
      }
      return {
        model,
        role: index === 0 && id === currentModelId ? 'current' : 'fallback',
        reason: index === 0 && id === currentModelId
          ? '当前会话模型'
          : '用户指定对比模型',
      };
    });
  }

  const selected: QuickCompareModelCandidate[] = [];
  const current = currentModelId ? byId.get(currentModelId) ?? null : null;
  pushUnique(selected, current ? {
    model: current,
    role: 'current',
    reason: '当前会话模型',
  } : null);

  const cheapest = [...eligible]
    .filter((model) => model.id !== currentModelId)
    .sort((a, b) => unitPrice(a) - unitPrice(b) || a.fallback_order - b.fallback_order)[0] ?? null;
  pushUnique(selected, cheapest ? {
    model: cheapest,
    role: 'cheap',
    reason: '当前可用的低成本候选',
  } : null);

  const quality = [...eligible]
    .filter((model) => !selected.some((item) => item.model.id === model.id))
    .sort((a, b) => qualityScore(b) - qualityScore(a) || unitPrice(a) - unitPrice(b))[0] ?? null;
  pushUnique(selected, quality ? {
    model: quality,
    role: 'quality',
    reason: '上下文/工具能力更强的候选',
  } : null);

  for (const model of eligible.sort((a, b) => a.fallback_order - b.fallback_order)) {
    pushUnique(selected, {
      model,
      role: 'fallback',
      reason: '按备用顺序补足候选',
    });
  }

  if (selected.length < 2) {
    throw validationError('至少需要 2 个可用聊天模型才能启动 Quick Compare。');
  }
  return selected;
}
