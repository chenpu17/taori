import type { CapabilityBus } from '../bus/index.js';
import type { MemoriesRepo, ModelsRepo } from '../db/repos/index.js';
import { readSessionToolEnabled } from '../routes/tools.js';

export function buildConversationToolPolicy(
  bus: CapabilityBus | null | undefined,
  memoriesRepo: MemoriesRepo,
  conversationId: string,
  opts: { skipToolName?: string | null } = {},
): Record<string, boolean> {
  if (!bus) return {};
  return bus.list().reduce<Record<string, boolean>>((acc, toolItem) => {
    const sessionEnabled = readSessionToolEnabled(
      memoriesRepo,
      conversationId,
      toolItem.name,
    );
    acc[toolItem.name] =
      toolItem.name !== opts.skipToolName &&
      toolItem.enabled &&
      sessionEnabled !== false;
    return acc;
  }, {});
}

export function pickImageToolModelId(
  modelsRepo: ModelsRepo,
  memoriesRepo: MemoriesRepo,
  conversationId: string,
): string | null {
  const now = Date.now();
  const candidates = modelsRepo
    .list()
    .filter(
      (m) =>
        m.capability === 'image' &&
        m.enabled &&
        !m.demoted &&
        !!m.provider_id &&
        !(m.disabled_until && m.disabled_until > now),
    )
    .sort(
      (a, b) =>
        modelImageSortPrice(a) - modelImageSortPrice(b) ||
        a.fallback_order - b.fallback_order,
    );
  const candidateIds = new Set(candidates.map((m) => m.id));
  const sessionModelId = memoriesRepo.get('session', conversationId, 'image_model');
  if (sessionModelId && candidateIds.has(sessionModelId)) return sessionModelId;
  const globalModelId = memoriesRepo.get('global', null, 'image_model_default');
  if (globalModelId && candidateIds.has(globalModelId)) return globalModelId;
  const defaultModel = modelsRepo.defaultFor('image');
  if (defaultModel && candidateIds.has(defaultModel.id)) return defaultModel.id;
  return candidates[0]?.id ?? null;
}

function modelImageSortPrice(model: { price_per_call?: number | null; price_per_image?: number | null }): number {
  return model.price_per_call ?? model.price_per_image ?? Number.POSITIVE_INFINITY;
}
