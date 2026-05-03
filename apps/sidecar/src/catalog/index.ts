/**
 * Catalog sync — M2.5 §F-PR.
 *
 * Re-fetches per-provider model metadata (prices, context length, modalities)
 * and upserts pricing into the existing `models` table without disturbing
 * user-set fields (alias, fallback_order, enabled, is_default_for).
 *
 * Trigger paths:
 *   1. Sidecar startup (best-effort, fire-and-forget)
 *   2. Periodic (every 24h) inside the same process
 *   3. Manual: POST /v1/catalog/sync
 *
 * Sync is idempotent — if prices haven't changed since last sync we report
 * `change: 'unchanged'`. New rows from upstream that aren't yet imported are
 * reported as `change: 'new'` but NOT auto-imported (the user picks them in
 * Model Center to avoid surprise charges from auto-enabled premium models).
 */

import type {
  CatalogModelDiff,
  CatalogSyncResponse,
  DiscoveredModel,
} from '@taori/shared';
import { listProviderModels } from '../providers/registry.js';
import { enrichVolcengineArkModel } from '../providers/volcengine_ark.js';
import type { KeyStore } from '../keystore.js';
import type { ModelsRepo, ProvidersRepo } from '../db/repos/index.js';

export interface CatalogSyncDeps {
  providers: ProvidersRepo;
  models: ModelsRepo;
  keystore: KeyStore;
  log?: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void };
}

const PRICE_EPSILON = 1e-9;
const SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

function priceChanged(a: number | null, b: number | null): boolean {
  if (a == null && b == null) return false;
  if (a == null || b == null) return true;
  return Math.abs(a - b) > PRICE_EPSILON;
}

function catalogPatch(dm: DiscoveredModel): Parameters<ModelsRepo['patchPricing']>[2] {
  return {
    price_input_per_1m: dm.price_input_per_1m,
    price_output_per_1m: dm.price_output_per_1m,
    price_per_image: dm.price_per_image ?? null,
    price_per_video_second: dm.price_per_video_second ?? null,
    pricing_meta: dm.pricing_meta ?? null,
    modalities: dm.modalities,
    capability: dm.capability,
    context_length: dm.context_length,
    supports_vision: dm.supports_vision,
    supports_tools: dm.supports_tools ?? false,
  };
}

function capabilityPatch(dm: DiscoveredModel): Parameters<ModelsRepo['patchPricing']>[2] {
  return {
    modalities: dm.modalities,
    capability: dm.capability,
    context_length: dm.context_length,
    supports_vision: dm.supports_vision,
    supports_tools: dm.supports_tools ?? false,
  };
}

export async function syncCatalog(
  deps: CatalogSyncDeps,
  filterProviderId?: string,
): Promise<CatalogSyncResponse> {
  const now = Date.now();
  const allProviders = deps.providers.list();
  const targets = filterProviderId
    ? allProviders.filter((p) => p.id === filterProviderId)
    : allProviders.filter((p) => p.enabled);

  const diffs: CatalogModelDiff[] = [];
  const errors: { provider_id: string; message: string }[] = [];
  let totalModels = 0;

  for (const provider of targets) {
    if (provider.type === 'volcengine_ark') {
      const existing = deps.models
        .list()
        .filter((m) => m.provider_id === provider.id);
      for (const model of existing) {
        const enriched = enrichVolcengineArkModel(model.model_name);
        if (enriched) {
          deps.models.patchPricing(provider.id, model.model_name, capabilityPatch(enriched));
        }
      }
    }

    if (!provider.api_key_ref) continue;
    let apiKey: string | null = null;
    try {
      apiKey = await deps.keystore.read(provider.api_key_ref);
    } catch (e) {
      errors.push({
        provider_id: provider.id,
        message: `keystore: ${e instanceof Error ? e.message : String(e)}`,
      });
      continue;
    }
    if (!apiKey) {
      errors.push({ provider_id: provider.id, message: 'API key missing' });
      continue;
    }

    let discovered: DiscoveredModel[];
    try {
      discovered = await listProviderModels({
        type: provider.type,
        base_url: provider.base_url,
        api_key: apiKey,
      });
    } catch (e) {
      errors.push({
        provider_id: provider.id,
        message: e instanceof Error ? e.message : String(e),
      });
      deps.log?.warn(
        { provider_id: provider.id, err: e },
        'catalog.sync_provider_failed',
      );
      continue;
    }

    totalModels += discovered.length;

    const existing = deps.models
      .list()
      .filter((m) => m.provider_id === provider.id);
    const byName = new Map(existing.map((m) => [m.model_name, m]));

    for (const dm of discovered) {
      const cur = byName.get(dm.model_name);
      if (!cur) {
        diffs.push({
          provider_id: provider.id,
          model_name: dm.model_name,
          display_name: dm.display_name,
          change: 'new',
          after: {
            price_input_per_1m: dm.price_input_per_1m,
            price_output_per_1m: dm.price_output_per_1m,
            price_per_image: dm.price_per_image ?? null,
          },
        });
        continue;
      }
      const changed =
        priceChanged(cur.price_input_per_1m, dm.price_input_per_1m) ||
        priceChanged(cur.price_output_per_1m, dm.price_output_per_1m) ||
        priceChanged(cur.price_per_image, dm.price_per_image ?? null) ||
        JSON.stringify(cur.pricing_meta ?? null) !== JSON.stringify(dm.pricing_meta ?? null);

      if (!changed) {
        diffs.push({
          provider_id: provider.id,
          model_name: dm.model_name,
          display_name: dm.display_name,
          change: 'unchanged',
        });
        // "Unchanged" only means no visible price delta. Capability metadata
        // still needs refreshing so old imports gain newly-known tool support.
        deps.models.patchPricing(provider.id, dm.model_name, catalogPatch(dm));
        continue;
      }

      diffs.push({
        provider_id: provider.id,
        model_name: dm.model_name,
        display_name: dm.display_name,
        change: 'price_changed',
        before: {
          price_input_per_1m: cur.price_input_per_1m,
          price_output_per_1m: cur.price_output_per_1m,
          price_per_image: cur.price_per_image,
        },
        after: {
          price_input_per_1m: dm.price_input_per_1m,
          price_output_per_1m: dm.price_output_per_1m,
          price_per_image: dm.price_per_image ?? null,
        },
      });
      deps.models.patchPricing(provider.id, dm.model_name, catalogPatch(dm));
    }
  }

  return {
    ok: true,
    synced_at: now,
    total_providers: targets.length,
    total_models: totalModels,
    diffs,
    errors,
  };
}

export function scheduleCatalogSync(
  deps: CatalogSyncDeps,
  intervalMs: number = SYNC_INTERVAL_MS,
): { stop: () => void } {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      await syncCatalog(deps);
    } catch (e) {
      deps.log?.warn({ err: e }, 'catalog.scheduled_sync_failed');
    }
  };
  void tick();
  const handle = setInterval(() => void tick(), intervalMs);
  return {
    stop: () => {
      stopped = true;
      clearInterval(handle);
    },
  };
}
