import { eq, and, isNotNull, asc, sql } from 'drizzle-orm';
import { type Db } from '../index.js';
import { isChatCapable } from '@taori/shared';
import { models } from '../schema.js';
import type { Model, ModelCapability, ModelCreate, ModelUpdate } from '@taori/shared';
import { makeId } from '@taori/shared';
import { toModel, stringifyPricingMeta } from './mappers.js';
import { pickDefined } from './shared.js';

export class ModelsRepo {
  constructor(private db: Db) {}

  list(): Model[] {
    return this.db
      .select()
      .from(models)
      .orderBy(asc(models.capability), asc(models.fallback_order))
      .all()
      .map(toModel);
  }

  listByProvider(providerId: string): Model[] {
    return this.db
      .select()
      .from(models)
      .where(eq(models.provider_id, providerId))
      .all()
      .map(toModel);
  }

  get(id: string): Model | null {
    const row = this.db.select().from(models).where(eq(models.id, id)).get();
    return row ? toModel(row) : null;
  }

  /**
   * Find the default model for a given capability among enabled models.
   * Used by /v1/chat in M1.2 to resolve "use default chat model".
   * Excludes demoted models and any whose `disabled_until` is still active —
   * the spec §7.5.2 requires automatic short-window suspension after repeated
   * `quota` / `rate_limit` failures.
   */
  defaultFor(capability: ModelCapability): Model | null {
    const now = Date.now();
    const row = this.db
      .select()
      .from(models)
      .where(
        and(
          eq(models.is_default_for, capability),
          eq(models.enabled, true),
          eq(models.demoted, false),
          isNotNull(models.provider_id),
          sql`(${models.disabled_until} IS NULL OR ${models.disabled_until} < ${now})`,
        ),
      )
      .get();
    return row ? toModel(row) : null;
  }

  /**
   * Pick the next eligible model in the same capability class, ordered by
   * `fallback_order` ascending. Excludes the calling model (so chat.ts can
   * use this after a primary failure) and respects demote/disable flags.
   */
  nextFallback(currentId: string, capability: ModelCapability): Model | null {
    const now = Date.now();
    const row = this.db
      .select()
      .from(models)
      .where(
        and(
          eq(models.capability, capability),
          eq(models.enabled, true),
          eq(models.demoted, false),
          isNotNull(models.provider_id),
          sql`${models.id} != ${currentId}`,
          sql`(${models.disabled_until} IS NULL OR ${models.disabled_until} < ${now})`,
        ),
      )
      .orderBy(asc(models.fallback_order))
      .get();
    return row ? toModel(row) : null;
  }

  /**
   * M2.2 §3.2 — pick the cheapest-active model for the given capability,
   * skipping `excludeId`. Ordering: COALESCE(price_per_call, price_input_per_1m, +Inf)
   * ascending, then `fallback_order` as a tie-breaker. Demoted, disabled
   * and providerless rows are excluded — same eligibility rules as
   * `nextFallback`. Returns null if no eligible model exists.
   *
   * NB: semantically distinct from `nextFallback` (which sorts by
   * `fallback_order` only). The two coexist; spec §3.2 calls this out.
   */
  pickCheapestActive(capability: ModelCapability, excludeId: string): Model | null {
    const now = Date.now();
    const row = this.db
      .select()
      .from(models)
      .where(
        and(
          eq(models.capability, capability),
          eq(models.enabled, true),
          eq(models.demoted, false),
          isNotNull(models.provider_id),
          sql`${models.id} != ${excludeId}`,
          sql`(${models.disabled_until} IS NULL OR ${models.disabled_until} < ${now})`,
        ),
      )
      .orderBy(
        // Treat NULL prices as +Inf so unpriced models sort to the bottom.
        sql`COALESCE(${models.price_per_call}, ${models.price_input_per_1m}, 1e18) ASC`,
        asc(models.fallback_order),
      )
      .get();
    return row ? toModel(row) : null;
  }

  create(input: ModelCreate): Model {
    const now = Date.now();
    const id = makeId('model');
    const row = this.db
      .insert(models)
      .values({
        id,
        alias: input.alias ?? null,
        provider_id: input.provider_id,
        model_name: input.model_name,
        capability: input.capability,
        display_name: input.display_name,
        price_input_per_1m: input.price_input_per_1m ?? null,
        price_output_per_1m: input.price_output_per_1m ?? null,
        price_per_call: input.price_per_call ?? null,
        price_per_image: input.price_per_image ?? null,
        price_per_video_second: input.price_per_video_second ?? null,
        price_currency: input.price_currency ?? 'USD',
        pricing_meta: stringifyPricingMeta(input.pricing_meta) ?? null,
        price_synced_at: null,
        modalities: input.modalities
          ? JSON.stringify(input.modalities)
          : null,
        context_length: input.context_length ?? null,
        supports_vision: input.supports_vision ?? false,
        supports_tools: input.supports_tools ?? isChatCapable(input.capability),
        supports_json: input.supports_json ?? false,
        thinking_enabled: input.thinking_enabled ?? null,
        is_default_for: input.enabled === false ? null : (input.is_default_for ?? null),
        fallback_order: 0,
        user_rating: null,
        failure_count_24h: 0,
        demoted: false,
        disabled_until: null,
        enabled: input.enabled ?? true,
        created_at: now,
        updated_at: now,
      })
      .returning()
      .get();
    return toModel(row);
  }

  /**
   * M2.5 catalog-sync helper. Updates pricing/modalities for a model identified
   * by (provider_id, model_name) — does not touch user-set fields like alias,
   * display_name, fallback_order, enabled. Sets `price_synced_at` to now.
   */
  patchPricing(
    providerId: string,
    modelName: string,
    patch: {
      price_input_per_1m?: number | null;
      price_output_per_1m?: number | null;
      price_per_call?: number | null;
      price_per_image?: number | null;
      price_per_video_second?: number | null;
      modalities?: string[];
      capability?: ModelCapability;
      context_length?: number | null;
      supports_vision?: boolean;
      supports_tools?: boolean;
      pricing_meta?: Model['pricing_meta'];
    },
  ): Model | null {
    const now = Date.now();
    const basePatch = pickDefined(patch, [
      'price_input_per_1m',
      'price_output_per_1m',
      'price_per_call',
      'price_per_image',
      'price_per_video_second',
      'capability',
      'context_length',
      'supports_vision',
      'supports_tools',
    ]);
    const row = this.db
      .update(models)
      .set({
        ...basePatch,
        ...(patch.pricing_meta !== undefined && {
          pricing_meta: stringifyPricingMeta(patch.pricing_meta) ?? null,
        }),
        ...(patch.modalities !== undefined && {
          modalities: JSON.stringify(patch.modalities),
        }),
        price_synced_at: now,
        updated_at: now,
      })
      .where(
        and(eq(models.provider_id, providerId), eq(models.model_name, modelName)),
      )
      .returning()
      .get();
    return row ? toModel(row) : null;
  }

  update(id: string, patch: ModelUpdate): Model | null {
    const existing = this.get(id);
    if (!existing) return null;
    const nextEnabled = patch.enabled ?? existing.enabled;
    const nextDefault =
      nextEnabled === false
        ? existing.is_default_for || patch.is_default_for !== undefined
          ? null
          : undefined
        : patch.is_default_for !== undefined
          ? patch.is_default_for
          : undefined;
    const basePatch = pickDefined(patch, [
      'alias',
      'display_name',
      'capability',
      'enabled',
      'fallback_order',
      'price_input_per_1m',
      'price_output_per_1m',
      'price_per_call',
      'price_per_image',
      'price_per_video_second',
      'price_currency',
      'context_length',
      'supports_vision',
      'supports_tools',
      'supports_json',
      'thinking_enabled',
    ]);
    const row = this.db
      .update(models)
      .set({
        ...basePatch,
        ...(nextDefault !== undefined && { is_default_for: nextDefault }),
        ...(patch.pricing_meta !== undefined && {
          pricing_meta: stringifyPricingMeta(patch.pricing_meta) ?? null,
        }),
        ...(patch.modalities !== undefined && {
          modalities: JSON.stringify(patch.modalities),
        }),
        updated_at: Date.now(),
      })
      .where(eq(models.id, id))
      .returning()
      .get();
    return toModel(row);
  }

  /**
   * MC-3 — bulk reorder ALL models for a capability. Sets `fallback_order = i`
   * for each `orderedIds[i]`. Requires the caller to submit the FULL set of
   * model ids for the capability (no subset reorder) so we never leave gaps
   * or duplicate fallback_order values, both of which would break
   * `nextFallback()` ordering.
   *
   * Validation + writes happen inside a single SQLite transaction so concurrent
   * reorder requests for the same capability cannot interleave: better-sqlite3
   * serializes transactions on a single thread, so the second tx observes the
   * first's writes (or fails with set_mismatch if the membership shifted).
   *
   * Throws Error('not_found' | 'capability_mismatch' | 'duplicate_ids' |
   * 'set_mismatch') for the renderer to surface.
   */
  reorder(capability: ModelCapability, orderedIds: string[]): Model[] {
    const seen = new Set<string>();
    for (const id of orderedIds) {
      if (seen.has(id)) throw new Error('duplicate_ids');
      seen.add(id);
    }
    const now = Date.now();
    this.db.transaction((tx) => {
      const existing = tx
        .select()
        .from(models)
        .where(eq(models.capability, capability))
        .all();
      const existingIds = new Set(existing.map((r) => r.id));
      for (const id of orderedIds) {
        if (!existingIds.has(id)) {
          // Either the id doesn't exist at all OR it belongs to another
          // capability. Distinguish for a clearer renderer message.
          const any = tx.select().from(models).where(eq(models.id, id)).get();
          if (!any) throw new Error('not_found');
          throw new Error('capability_mismatch');
        }
      }
      if (existing.length !== orderedIds.length) {
        throw new Error('set_mismatch');
      }
      orderedIds.forEach((id, idx) => {
        tx
          .update(models)
          .set({ fallback_order: idx, updated_at: now })
          .where(eq(models.id, id))
          .run();
      });
    });
    return this.db
      .select()
      .from(models)
      .where(eq(models.capability, capability))
      .orderBy(asc(models.fallback_order))
      .all()
      .map(toModel);
  }

  /**
   * Record an upstream failure for a model and apply demote/disable per
   * docs/product/08-m1-spec.md §7.5.2:
   *   - 3 consecutive strikes → `demoted = true`
   *   - 5 consecutive strikes → `disabled_until = now + 24h`
   * Strike-counting set per docs/product/09-m2-spec.md §7.2 / §11.2:
   * `quota`, `rate_limit`, `network`, `auth`, and `unknown` all count as
   * strikes (a model that's repeatedly misconfigured or unreachable should
   * be demoted just like one that's rate-limited). `content_filter` is
   * excluded — that's a per-prompt user-side policy issue, not a model
   * health signal.
   *
   * Note: `failure_count_24h` is a *consecutive* failure run, not a true
   * 24h sliding window. If the last failure was >24h ago the counter resets
   * to 1; otherwise it increments. This means a gap of >24h breaks the
   * streak even if there were earlier failures within the window.
   */
  recordFailure(modelId: string, classification: string): Model | null {
    const STRIKE_KINDS = new Set([
      'quota',
      'rate_limit',
      'network',
      'auth',
      'unknown',
    ]);
    if (!STRIKE_KINDS.has(classification)) return this.get(modelId);
    const existing = this.get(modelId);
    if (!existing) return null;
    const row = this.db.select().from(models).where(eq(models.id, modelId)).get();
    if (!row) return null;
    const now = Date.now();
    const lastFailureAt = row.last_failure_at ?? null;
    const within24h = lastFailureAt != null && now - lastFailureAt < 86_400_000;
    const nextCount = within24h ? row.failure_count_24h + 1 : 1;
    const demoted = nextCount >= 3 || row.demoted;
    const disabledUntil =
      nextCount >= 5 ? now + 86_400_000 : row.disabled_until;
    const next = this.db
      .update(models)
      .set({
        failure_count_24h: nextCount,
        last_failure_at: now,
        demoted,
        disabled_until: disabledUntil,
        updated_at: now,
      })
      .where(eq(models.id, modelId))
      .returning()
      .get();
    return toModel(next);
  }

  /**
   * Reset failure counters after a successful call. Demoted/disabled flags
   * are NOT auto-cleared — operators must re-enable explicitly via PATCH —
   * but the rolling counter resets so the next strike starts from zero.
   */
  recordSuccess(modelId: string): void {
    this.db
      .update(models)
      .set({ failure_count_24h: 0, updated_at: Date.now() })
      .where(eq(models.id, modelId))
      .run();
  }

  resetHealth(modelId: string): Model | null {
    const next = this.db
      .update(models)
      .set({
        failure_count_24h: 0,
        last_failure_at: null,
        demoted: false,
        disabled_until: null,
        updated_at: Date.now(),
      })
      .where(eq(models.id, modelId))
      .returning()
      .get();
    return next ? toModel(next) : null;
  }

  /**
   * Promote a model to be THE default for a capability. Demotes any other
   * model currently flagged as default for that same capability. Idempotent.
   */
  setDefaultFor(modelId: string, capability: ModelCapability): Model | null {
    const target = this.get(modelId);
    if (!target) return null;
    if (!target.enabled) return null;
    this.db.transaction((tx) => {
      tx.update(models)
        .set({ is_default_for: null, updated_at: Date.now() })
        .where(eq(models.is_default_for, capability))
        .run();
      tx.update(models)
        .set({ is_default_for: capability, updated_at: Date.now() })
        .where(eq(models.id, modelId))
        .run();
    });
    return this.get(modelId);
  }

  delete(id: string): boolean {
    const res = this.db.delete(models).where(eq(models.id, id)).run();
    return res.changes > 0;
  }
}
