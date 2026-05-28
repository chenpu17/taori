import { eq, asc } from 'drizzle-orm';
import { type Db } from '../index.js';
import { providers } from '../schema.js';
import type { Provider, ProviderCreate, ProviderUpdate } from '@taori/shared';
import { makeId } from '@taori/shared';
import { toProvider } from './mappers.js';
import { pickDefined } from './shared.js';

export class ProvidersRepo {
  constructor(private db: Db) {}

  list(): Provider[] {
    return this.db.select().from(providers).all().map(toProvider);
  }

  get(id: string): Provider | null {
    const row = this.db
      .select()
      .from(providers)
      .where(eq(providers.id, id))
      .get();
    return row ? toProvider(row) : null;
  }

  create(input: ProviderCreate): Provider {
    const now = Date.now();
    const id = makeId('provider');
    const apiKeyRef = input.api_key ? `provider:${id}` : null;
    const row = this.db
      .insert(providers)
      .values({
        id,
        name: input.name,
        type: input.type,
        base_url: input.base_url,
        api_key_ref: apiKeyRef,
        enabled: true,
        created_at: now,
        updated_at: now,
      })
      .returning()
      .get();
    return toProvider(row);
  }

  /**
   * Apply mutable fields. Returns the updated record or null if id missing.
   * If a new api_key is given, the api_key_ref is created/refreshed.
   * Caller is responsible for actually writing to the keystore.
   */
  update(
    id: string,
    patch: ProviderUpdate,
  ): { provider: Provider; api_key_ref_changed: boolean } | null {
    const existing = this.get(id);
    if (!existing) return null;
    const apiKeyRef =
      patch.api_key !== undefined && existing.api_key_ref == null
        ? `provider:${id}`
        : existing.api_key_ref;
    const next = this.db
      .update(providers)
      .set({
        ...pickDefined(patch, ['name', 'base_url', 'enabled']),
        api_key_ref: apiKeyRef,
        updated_at: Date.now(),
      })
      .where(eq(providers.id, id))
      .returning()
      .get();
    return {
      provider: toProvider(next),
      api_key_ref_changed: patch.api_key !== undefined,
    };
  }

  delete(id: string): boolean {
    const res = this.db.delete(providers).where(eq(providers.id, id)).run();
    return res.changes > 0;
  }
}
