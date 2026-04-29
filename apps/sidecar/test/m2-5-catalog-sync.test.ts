/**
 * Catalog sync — M2.5 §F-PR.
 *
 * Proves:
 *   1. /v1/catalog/sync calls each provider's `listProviderModels`,
 *      compares to local rows, and emits diffs (`new` / `price_changed` /
 *      `unchanged`).
 *   2. `price_synced_at` is bumped even on `unchanged` rows so the UI's
 *      "last synced" affordance updates.
 *   3. When upstream prices change, `models.price_input_per_1m` is updated
 *      while user-set fields (alias, fallback_order, enabled) survive.
 *   4. Provider-level errors (bad key, network) are reported per-provider
 *      without aborting the rest of the sync.
 */

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { openDb } from '../src/db/index.js';
import { ControlClient } from '../src/control/client.js';
import { MemoryStore } from '../src/keystore.js';
import type { FastifyInstance } from 'fastify';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

describe('catalog sync (M2.5 F-PR)', () => {
  let app: FastifyInstance;
  let keystore: MemoryStore;
  const dbPath = path.join(os.tmpdir(), `taori-catalog-${Date.now()}.db`);
  const bearer = 'test_catalog_xyz';
  const auth = { authorization: `Bearer ${bearer}` };
  const authJson = {
    authorization: `Bearer ${bearer}`,
    'content-type': 'application/json',
  };

  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    keystore = new MemoryStore();
    app = buildServer({
      config: {
        port: 0,
        bearer,
        dbPath,
        controlUrl: null,
        controlBearer: null,
        isDev: false,
        version: '0.0.0-test',
      },
      db: openDb(dbPath),
      control: new ControlClient({ url: null, bearer: null }),
      keystore,
      startedAt: Date.now(),
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(dbPath, { force: true });
  });

  beforeEach(() => {
    if (fetchSpy) fetchSpy.mockRestore();
  });

  function mockOpenRouterListing(
    models: Array<{ id: string; name?: string; pricing?: { prompt?: string; completion?: string } }>,
  ): void {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.includes('/models')) {
        return new Response(JSON.stringify({ data: models }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
  }

  it('persists upstream price changes & touches price_synced_at on unchanged', async () => {
    // 1. Seed an OpenRouter provider + a model whose upstream price will change.
    mockOpenRouterListing([
      { id: 'openai/gpt-4o-mini', name: 'GPT-4o mini', pricing: { prompt: '0.00000015', completion: '0.0000006' } },
    ]);
    const provRes = await app.inject({
      method: 'POST',
      url: '/v1/providers',
      headers: authJson,
      payload: {
        name: 'OR',
        type: 'openrouter',
        base_url: 'https://openrouter.ai/api/v1',
        api_key: 'sk-or-test',
        enabled: true,
      },
    });
    expect([200, 201]).toContain(provRes.statusCode);
    const provider = provRes.json();

    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/models',
      headers: authJson,
      payload: {
        provider_id: provider.id,
        model_name: 'openai/gpt-4o-mini',
        display_name: 'GPT-4o mini',
        capability: 'chat',
        // Old, stale local price — expect sync to update both fields.
        price_input_per_1m: 0.5,
        price_output_per_1m: 2.0,
      },
    });
    expect([200, 201]).toContain(createRes.statusCode);
    const model = createRes.json();
    // User-set field that must NOT be wiped by sync.
    await app.inject({
      method: 'PATCH',
      url: `/v1/models/${model.id}`,
      headers: authJson,
      payload: { alias: 'my-fast-bot', enabled: true },
    });

    // 2. First sync — upstream says 0.15/0.6 per 1M (i.e. 0.00000015/0.0000006 per token),
    //    so syncCatalog should report `price_changed`.
    fetchSpy.mockRestore();
    mockOpenRouterListing([
      { id: 'openai/gpt-4o-mini', name: 'GPT-4o mini', pricing: { prompt: '0.00000015', completion: '0.0000006' } },
      // A new upstream model not yet imported locally — expect `new`.
      { id: 'meta-llama/llama-3.3-70b-instruct', name: 'Llama 3.3 70B', pricing: { prompt: '0.00000005', completion: '0.0000001' } },
    ]);

    const sync1 = await app.inject({
      method: 'POST',
      url: '/v1/catalog/sync',
      headers: auth,
    });
    expect(sync1.statusCode).toBe(200);
    const body1 = sync1.json();
    expect(body1.ok).toBe(true);
    expect(body1.total_providers).toBe(1);
    expect(body1.total_models).toBe(2);

    const changed = body1.diffs.find((d: { model_name: string; change: string }) =>
      d.model_name === 'openai/gpt-4o-mini',
    );
    expect(changed.change).toBe('price_changed');
    expect(changed.before.price_input_per_1m).toBeCloseTo(0.5, 5);
    expect(changed.after.price_input_per_1m).toBeCloseTo(0.15, 5);

    const newRow = body1.diffs.find((d: { model_name: string }) =>
      d.model_name === 'meta-llama/llama-3.3-70b-instruct',
    );
    expect(newRow.change).toBe('new');

    // 3. Confirm DB persisted the new prices and respected user fields.
    const after = await app.inject({ method: 'GET', url: '/v1/models', headers: auth });
    const updated = after.json().models.find((m: { model_name: string }) =>
      m.model_name === 'openai/gpt-4o-mini',
    );
    expect(updated.price_input_per_1m).toBeCloseTo(0.15, 5);
    expect(updated.price_output_per_1m).toBeCloseTo(0.6, 5);
    expect(updated.alias).toBe('my-fast-bot');
    expect(updated.enabled).toBe(true);
    expect(typeof updated.price_synced_at).toBe('number');
    const firstSyncedAt = updated.price_synced_at;
    expect(firstSyncedAt).toBeGreaterThan(0);

    // 4. Second sync — upstream prices identical → `unchanged`. We still
    //    expect `price_synced_at` to be advanced so the UI affordance refreshes.
    await new Promise((r) => setTimeout(r, 5));
    fetchSpy.mockRestore();
    mockOpenRouterListing([
      { id: 'openai/gpt-4o-mini', name: 'GPT-4o mini', pricing: { prompt: '0.00000015', completion: '0.0000006' } },
    ]);
    const sync2 = await app.inject({
      method: 'POST',
      url: '/v1/catalog/sync',
      headers: auth,
    });
    const body2 = sync2.json();
    const stillUnchanged = body2.diffs.find((d: { model_name: string }) =>
      d.model_name === 'openai/gpt-4o-mini',
    );
    expect(stillUnchanged.change).toBe('unchanged');

    const after2 = await app.inject({ method: 'GET', url: '/v1/models', headers: auth });
    const refreshed = after2.json().models.find((m: { model_name: string }) =>
      m.model_name === 'openai/gpt-4o-mini',
    );
    expect(refreshed.price_synced_at).toBeGreaterThan(firstSyncedAt);
  });

  it('reports per-provider errors without aborting other providers', async () => {
    // Two providers — one returns 401, the other is fine. Sync should
    // surface the auth error in the errors array but still process the
    // second provider's models.
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const auth = headers.authorization || headers.Authorization || '';
      if (auth.includes('bad-key')) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
      }
      if (url.includes('/models')) {
        return new Response(
          JSON.stringify({ data: [{ id: 'good/model', name: 'Good', pricing: { prompt: '0', completion: '0' } }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    // Provider B with a bad key.
    const bad = await app.inject({
      method: 'POST',
      url: '/v1/providers',
      headers: authJson,
      payload: {
        name: 'Bad',
        type: 'openrouter',
        base_url: 'https://openrouter.ai/api/v1',
        api_key: 'bad-key',
        enabled: true,
      },
    });
    expect([200, 201]).toContain(bad.statusCode);
    const badProvider = bad.json();

    const sync = await app.inject({
      method: 'POST',
      url: '/v1/catalog/sync',
      headers: auth,
    });
    const body = sync.json();
    expect(body.ok).toBe(true);
    const err = body.errors.find((e: { provider_id: string }) => e.provider_id === badProvider.id);
    expect(err).toBeDefined();
    // Other (good) provider still produced diffs.
    expect(body.diffs.length).toBeGreaterThan(0);
  });
});
