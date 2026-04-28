import { describe, it, expect, beforeAll, afterAll, vi, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { openDb } from '../src/db/index.js';
import { ControlClient } from '../src/control/client.js';
import { MemoryStore } from '../src/keystore.js';
import type { FastifyInstance } from 'fastify';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

describe('providers + models', () => {
  let app: FastifyInstance;
  let keystore: MemoryStore;
  const dbPath = path.join(os.tmpdir(), `taori-providers-${Date.now()}.db`);
  const bearer = 'test_bearer_xyz';
  const auth = { authorization: `Bearer ${bearer}` };
  const authJson = { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' };

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

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockOpenRouterModels(items: unknown[]): void {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (typeof url === 'string' && url.includes('/models')) {
        return new Response(JSON.stringify({ data: items }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
  }

  it('POST /v1/providers/test ok → returns sample_count', async () => {
    mockOpenRouterModels([{ id: 'a/b' }, { id: 'c/d' }]);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/providers/test',
      headers: authJson,
      payload: {
        type: 'openrouter',
        base_url: 'https://openrouter.ai/api/v1',
        api_key: 'sk-or-test',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.sample_count).toBe(2);
  });

  it('POST /v1/providers/test 401 from upstream → ok=false with classification', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('unauth', { status: 401 }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/v1/providers/test',
      headers: authJson,
      payload: {
        type: 'openrouter',
        base_url: 'https://openrouter.ai/api/v1',
        api_key: 'sk-bad',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.error.classification).toBe('auth');
  });

  it('full CRUD cycle: create provider with key → list → discover → create model → set default → delete', async () => {
    mockOpenRouterModels([
      {
        id: 'openai/gpt-4o-mini',
        name: 'GPT-4o mini',
        context_length: 128000,
        pricing: { prompt: '0.00000015', completion: '0.0000006' },
        architecture: { input_modalities: ['text', 'image'] },
      },
      {
        id: 'meta/llama',
        context_length: 8192,
        pricing: { prompt: '0', completion: '0' },
        architecture: { input_modalities: ['text'] },
      },
    ]);

    // 1. create provider
    let res = await app.inject({
      method: 'POST',
      url: '/v1/providers',
      headers: authJson,
      payload: {
        name: 'OpenRouter',
        type: 'openrouter',
        base_url: 'https://openrouter.ai/api/v1',
        api_key: 'sk-or-test',
      },
    });
    expect(res.statusCode).toBe(201);
    const provider = res.json();
    expect(provider.id).toMatch(/^prov_/);
    expect(provider.api_key_ref).toBe(`provider:${provider.id}`);
    expect(await keystore.read(provider.api_key_ref)).toBe('sk-or-test');

    // 2. list providers
    res = await app.inject({ method: 'GET', url: '/v1/providers', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().providers).toHaveLength(1);

    // 3. discover models
    res = await app.inject({
      method: 'GET',
      url: `/v1/providers/${provider.id}/discover`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const discovery = res.json();
    expect(discovery.models).toHaveLength(2);
    expect(discovery.recommended.chat).toBe('openai/gpt-4o-mini');
    expect(discovery.recommended.vision).toBe('openai/gpt-4o-mini');
    expect(discovery.models[0].supports_vision).toBe(true);
    expect(discovery.models[0].price_input_per_1m).toBeCloseTo(0.15, 5);

    // 4. create model
    res = await app.inject({
      method: 'POST',
      url: '/v1/models',
      headers: authJson,
      payload: {
        provider_id: provider.id,
        model_name: 'openai/gpt-4o-mini',
        capability: 'chat',
        display_name: 'GPT-4o mini',
        price_input_per_1m: 0.15,
        price_output_per_1m: 0.6,
        supports_vision: true,
        is_default_for: 'chat',
      },
    });
    expect(res.statusCode).toBe(201);
    const model = res.json();
    expect(model.is_default_for).toBe('chat');

    // 5. duplicate create → 409 conflict
    res = await app.inject({
      method: 'POST',
      url: '/v1/models',
      headers: authJson,
      payload: {
        provider_id: provider.id,
        model_name: 'openai/gpt-4o-mini',
        capability: 'chat',
        display_name: 'dup',
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('conflict');

    // 6. delete model
    res = await app.inject({
      method: 'DELETE',
      url: `/v1/models/${model.id}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(204);

    // 7. delete provider also clears keystore
    res = await app.inject({
      method: 'DELETE',
      url: `/v1/providers/${provider.id}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(204);
    expect(await keystore.read(`provider:${provider.id}`)).toBeNull();
  });

  it('POST /v1/providers with invalid body → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/providers',
      headers: authJson,
      payload: { name: '', type: 'openrouter', base_url: 'not a url' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('PATCH unknown provider → 404', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/providers/provider_nonexistent',
      headers: authJson,
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(404);
  });

  // ───────────────────────────── MC-3 reorder ─────────────────────────────
  it('POST /v1/models/reorder updates fallback_order in submitted order', async () => {
    // 1. seed a provider with three chat models. We bypass discovery and
    // directly POST /v1/models to keep the test focused on the reorder route.
    let res = await app.inject({
      method: 'POST',
      url: '/v1/providers',
      headers: authJson,
      payload: {
        name: 'P-MC3',
        type: 'openrouter',
        base_url: 'https://openrouter.ai/api/v1',
      },
    });
    expect(res.statusCode).toBe(201);
    const prov = res.json();

    const ids: string[] = [];
    for (const name of ['m-a', 'm-b', 'm-c']) {
      res = await app.inject({
        method: 'POST',
        url: '/v1/models',
        headers: authJson,
        payload: {
          provider_id: prov.id,
          model_name: name,
          capability: 'chat',
          display_name: name.toUpperCase(),
        },
      });
      expect(res.statusCode).toBe(201);
      ids.push(res.json().id);
    }

    // Reorder: c, a, b → fallback_order = 0, 1, 2 respectively.
    res = await app.inject({
      method: 'POST',
      url: '/v1/models/reorder',
      headers: authJson,
      payload: { capability: 'chat', ordered_ids: [ids[2], ids[0], ids[1]] },
    });
    expect(res.statusCode).toBe(200);
    const reordered = res.json().models as { id: string; fallback_order: number }[];
    expect(reordered.map((m) => m.id)).toEqual([ids[2], ids[0], ids[1]]);
    expect(reordered.map((m) => m.fallback_order)).toEqual([0, 1, 2]);

    // GET /v1/models reflects the new order within the chat capability.
    res = await app.inject({ method: 'GET', url: '/v1/models', headers: auth });
    const all = res.json().models as { id: string; capability: string; fallback_order: number }[];
    const chatOrder = all.filter((m) => m.capability === 'chat').map((m) => m.id);
    expect(chatOrder).toEqual([ids[2], ids[0], ids[1]]);
  });

  it('POST /v1/models/reorder rejects unknown id → 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/models/reorder',
      headers: authJson,
      payload: { capability: 'chat', ordered_ids: ['mdl_does_not_exist'] },
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /v1/models/reorder rejects mixed-capability set → 400', async () => {
    // Reuse models from previous tests; just need at least one chat model.
    const list = (await app.inject({ method: 'GET', url: '/v1/models', headers: auth })).json()
      .models as { id: string; capability: string }[];
    const someChat = list.find((m) => m.capability === 'chat');
    expect(someChat).toBeTruthy();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/models/reorder',
      headers: authJson,
      // image capability with chat id → should fail capability_mismatch.
      payload: { capability: 'image', ordered_ids: [someChat!.id] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/capability/i);
  });

  it('POST /v1/models/reorder rejects duplicate ids → 400', async () => {
    const list = (await app.inject({ method: 'GET', url: '/v1/models', headers: auth })).json()
      .models as { id: string; capability: string }[];
    const someChat = list.find((m) => m.capability === 'chat');
    expect(someChat).toBeTruthy();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/models/reorder',
      headers: authJson,
      payload: { capability: 'chat', ordered_ids: [someChat!.id, someChat!.id] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/duplicate/i);
  });

  it('POST /v1/models/reorder rejects subset (set_mismatch) → 400', async () => {
    // Only submitting one of the three seeded chat models is a partial set;
    // the route must reject so we never persist a gapped fallback_order.
    const list = (await app.inject({ method: 'GET', url: '/v1/models', headers: auth })).json()
      .models as { id: string; capability: string }[];
    const chats = list.filter((m) => m.capability === 'chat');
    expect(chats.length).toBeGreaterThanOrEqual(2);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/models/reorder',
      headers: authJson,
      payload: { capability: 'chat', ordered_ids: [chats[0].id] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/every model/i);
  });
});
