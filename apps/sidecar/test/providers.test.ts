import { describe, it, expect, beforeAll, afterAll, vi, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { openDb } from '../src/db/index.js';
import { ModelsRepo } from '../src/db/repos/index.js';
import { ControlClient } from '../src/control/client.js';
import { MemoryStore, type KeyStore } from '../src/keystore.js';
import type { FastifyInstance } from 'fastify';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

describe('providers + models', () => {
  let app: FastifyInstance;
  let keystore: MemoryStore;
  let modelsRepo: ModelsRepo;
  const dbPath = path.join(os.tmpdir(), `taori-providers-${Date.now()}.db`);
  const bearer = 'test_bearer_xyz';
  const auth = { authorization: `Bearer ${bearer}` };
  const authJson = { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' };

  beforeAll(async () => {
    keystore = new MemoryStore();
    const db = openDb(dbPath);
    modelsRepo = new ModelsRepo(db);
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
      db,
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
      if (typeof url === 'string' && url.includes('/key')) {
        return new Response(JSON.stringify({ data: { label: 'test key' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (typeof url === 'string' && url.includes('/models')) {
        return new Response(JSON.stringify({ data: items }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
  }

  it('GET /v1/providers/key-status requires explicit confirmation before reading Keychain', async () => {
    const keychainDbPath = path.join(os.tmpdir(), `taori-providers-keychain-${Date.now()}.db`);
    const secrets = new Map<string, string>();
    const keychain: KeyStore = {
      kind: 'keychain',
      write: vi.fn(async (account: string, secret: string) => {
        secrets.set(account, secret);
      }),
      read: vi.fn(async (account: string) => secrets.get(account) ?? null),
      delete: vi.fn(async (account: string) => {
        secrets.delete(account);
      }),
    };
    const keychainApp = buildServer({
      config: {
        port: 0,
        bearer,
        dbPath: keychainDbPath,
        controlUrl: null,
        controlBearer: null,
        isDev: false,
        version: '0.0.0-test',
      },
      db: openDb(keychainDbPath),
      control: new ControlClient({ url: null, bearer: null }),
      keystore: keychain,
      startedAt: Date.now(),
    });
    await keychainApp.ready();

    try {
      const created = await keychainApp.inject({
        method: 'POST',
        url: '/v1/providers',
        headers: authJson,
        payload: {
          name: 'Keychain Provider',
          type: 'custom',
          base_url: 'https://example.invalid/v1',
          api_key: 'sk-keychain-test',
        },
      });
      expect(created.statusCode).toBe(201);
      const provider = created.json() as { id: string };
      expect(keychain.write).toHaveBeenCalledTimes(1);

      const withoutConfirmation = await keychainApp.inject({
        method: 'GET',
        url: '/v1/providers/key-status',
        headers: auth,
      });
      expect(withoutConfirmation.statusCode).toBe(400);
      expect(withoutConfirmation.json()).toMatchObject({
        code: 'validation_error',
        details: {
          requires_keychain_confirmation: true,
          keystore_kind: 'keychain',
        },
      });
      expect(keychain.read).not.toHaveBeenCalled();

      const withConfirmation = await keychainApp.inject({
        method: 'GET',
        url: '/v1/providers/key-status?confirm_keychain=1',
        headers: auth,
      });
      expect(withConfirmation.statusCode).toBe(200);
      expect(keychain.read).toHaveBeenCalledTimes(1);
      expect(withConfirmation.json().statuses).toContainEqual({
        provider_id: provider.id,
        key_available: true,
      });
    } finally {
      await keychainApp.close();
      fs.rmSync(keychainDbPath, { force: true });
    }
  });

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

  it('POST /v1/providers/test supports provider_id for saved providers', async () => {
    mockOpenRouterModels([{ id: 'a/b' }, { id: 'c/d' }, { id: 'e/f' }]);
    const create = await app.inject({
      method: 'POST',
      url: '/v1/providers',
      headers: authJson,
      payload: {
        name: 'Saved OpenRouter',
        type: 'openrouter',
        base_url: 'https://openrouter.ai/api/v1',
        api_key: 'sk-or-saved',
      },
    });
    expect(create.statusCode).toBe(201);
    const provider = create.json() as { id: string };

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/providers/test',
        headers: authJson,
        payload: {
          provider_id: provider.id,
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.sample_count).toBe(3);
    } finally {
      await app.inject({
        method: 'DELETE',
        url: `/v1/providers/${provider.id}`,
        headers: auth,
      });
    }
  });

  it('Ollama provider test works without an API key and normalizes /v1 for native tags', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ models: [{ name: 'llama3.2:latest' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/v1/providers/test',
      headers: authJson,
      payload: {
        type: 'ollama',
        base_url: 'http://127.0.0.1:11434/v1',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, sample_count: 1 });
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:11434/api/tags',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('Ollama discovery imports local no-key models with local pricing and heuristics', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          models: [
            { name: 'llama3.2:latest' },
            { name: 'nomic-embed-text:latest' },
            { name: 'llava:latest' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    let res = await app.inject({
      method: 'POST',
      url: '/v1/providers',
      headers: authJson,
      payload: {
        name: 'Local Ollama',
        type: 'ollama',
        base_url: 'http://127.0.0.1:11434',
      },
    });
    expect(res.statusCode).toBe(201);
    const provider = res.json();
    expect(provider.api_key_ref).toBeNull();

    res = await app.inject({
      method: 'GET',
      url: `/v1/providers/${provider.id}/discover`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const models = body.models as Array<{
      model_name: string;
      capability: string;
      price_input_per_1m: number;
      price_output_per_1m: number;
      supports_vision: boolean;
      supports_tools: boolean;
    }>;
    expect(body.recommended.chat).toBe('llama3.2:latest');
    expect(models.find((m) => m.model_name === 'llama3.2:latest')).toMatchObject({
      capability: 'chat',
      price_input_per_1m: 0,
      price_output_per_1m: 0,
      supports_tools: true,
    });
    expect(models.find((m) => m.model_name === 'nomic-embed-text:latest')?.capability).toBe(
      'embedding',
    );
    expect(models.find((m) => m.model_name === 'llava:latest')).toMatchObject({
      capability: 'multimodal',
      supports_vision: true,
      supports_tools: true,
    });

    res = await app.inject({
      method: 'DELETE',
      url: `/v1/providers/${provider.id}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(204);
  });

  it('POST /v1/providers/test 401 from upstream → ok=false with classification', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
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
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('/key');
  });

  it('OpenRouter discovery validates API key and requests all output modalities', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const raw = String(url);
      if (raw.includes('/key')) {
        return new Response(JSON.stringify({ data: { label: 'ok' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (raw.includes('/models')) {
        expect(raw).toContain('output_modalities=all');
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'openai/gpt-image-1',
                name: 'GPT Image 1',
                pricing: { image: '0.04' },
                architecture: { input_modalities: ['text'], output_modalities: ['image'] },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    let res = await app.inject({
      method: 'POST',
      url: '/v1/providers',
      headers: authJson,
      payload: {
        name: 'OpenRouter image',
        type: 'openrouter',
        base_url: 'https://openrouter.ai/api/v1',
        api_key: 'sk-or-test',
      },
    });
    expect(res.statusCode).toBe(201);
    const provider = res.json() as { id: string };

    res = await app.inject({
      method: 'GET',
      url: `/v1/providers/${provider.id}/discover`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const models = res.json().models as Array<{
      model_name: string;
      capability: string;
      price_per_image: number | null;
      modalities: string[];
    }>;
    expect(models[0]).toMatchObject({
      model_name: 'openai/gpt-image-1',
      capability: 'image',
      price_per_image: 0.04,
      modalities: ['image'],
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/models?output_modalities=all',
      expect.objectContaining({ method: 'GET' }),
    );

    res = await app.inject({
      method: 'DELETE',
      url: `/v1/providers/${provider.id}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(204);
  });

  it('OpenAI-compatible discovery reads real /models and infers gpt-image as image', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { id: 'gpt-4o-mini', object: 'model' },
            { id: 'gpt-image-1', object: 'model' },
            {
              id: 'gpt-4o',
              object: 'model',
              architecture: { input_modalities: ['text', 'image'] },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    let res = await app.inject({
      method: 'POST',
      url: '/v1/providers',
      headers: authJson,
      payload: {
        name: 'PackyAPI',
        type: 'openai',
        base_url: 'https://api.packy.example/v1',
        api_key: 'sk-packy',
      },
    });
    expect(res.statusCode).toBe(201);
    const provider = res.json();

    res = await app.inject({
      method: 'GET',
      url: `/v1/providers/${provider.id}/discover`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const models = res.json().models as Array<{
      model_name: string;
      capability: string;
      modalities: string[];
      supports_vision: boolean;
      supports_tools: boolean;
    }>;
    expect(models.find((m) => m.model_name === 'gpt-image-1')).toMatchObject({
      capability: 'image',
      modalities: ['image'],
      supports_vision: false,
      supports_tools: false,
    });
    expect(models.find((m) => m.model_name === 'gpt-4o')).toMatchObject({
      capability: 'multimodal',
      supports_vision: true,
      supports_tools: true,
    });

    res = await app.inject({
      method: 'DELETE',
      url: `/v1/providers/${provider.id}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(204);
  });

  it('custom OpenAI-compatible discovery also exposes image models', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { id: 'packy-chat', object: 'model' },
            { id: 'packy-gpt-image', object: 'model' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    let res = await app.inject({
      method: 'POST',
      url: '/v1/providers',
      headers: authJson,
      payload: {
        name: 'Custom PackyAPI',
        type: 'custom',
        base_url: 'https://packy.example/v1',
        api_key: 'sk-packy',
      },
    });
    expect(res.statusCode).toBe(201);
    const provider = res.json();

    res = await app.inject({
      method: 'GET',
      url: `/v1/providers/${provider.id}/discover`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const models = res.json().models as Array<{ model_name: string; capability: string }>;
    expect(models.find((m) => m.model_name === 'packy-gpt-image')?.capability).toBe('image');

    res = await app.inject({
      method: 'DELETE',
      url: `/v1/providers/${provider.id}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(204);
  });

  it('PackyAPI discovery surfaces gpt-image-2 even when /models omits it', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(
        JSON.stringify({
          data: [
            { id: 'packy-chat', object: 'model' },
            { id: 'gpt-image-1', object: 'model' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    let res = await app.inject({
      method: 'POST',
      url: '/v1/providers/test',
      headers: authJson,
      payload: {
        type: 'packyapi',
        base_url: 'https://www.packyapi.com/v1',
        api_key: 'sk-packy-test',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, sample_count: 2 });

    res = await app.inject({
      method: 'POST',
      url: '/v1/providers',
      headers: authJson,
      payload: {
        name: 'PackyAPI',
        type: 'packyapi',
        base_url: 'https://www.packyapi.com/v1',
        api_key: 'sk-packy-test',
      },
    });
    expect(res.statusCode).toBe(201);
    const provider = res.json();

    res = await app.inject({
      method: 'GET',
      url: `/v1/providers/${provider.id}/discover`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const models = res.json().models as Array<{
      model_name: string;
      capability: string;
      display_name: string;
      modalities: string[];
      supports_tools: boolean;
    }>;
    expect(models[0]).toMatchObject({
      model_name: 'gpt-image-2',
      display_name: 'GPT Image 2',
      capability: 'image',
      modalities: ['image'],
      supports_tools: false,
    });
    expect(models.find((m) => m.model_name === 'gpt-image-1')?.capability).toBe('image');

    res = await app.inject({
      method: 'DELETE',
      url: `/v1/providers/${provider.id}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(204);
  });

  it('PackyAPI discovery falls back to documented gpt-image-2 when /models is unavailable', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('not found', { status: 404 }));

    let res = await app.inject({
      method: 'POST',
      url: '/v1/providers',
      headers: authJson,
      payload: {
        name: 'PackyAPI image-only',
        type: 'packyapi',
        base_url: 'https://www.packyapi.com/v1',
        api_key: 'sk-packy-test',
      },
    });
    expect(res.statusCode).toBe(201);
    const provider = res.json();

    res = await app.inject({
      method: 'GET',
      url: `/v1/providers/${provider.id}/discover`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().models).toEqual([
      expect.objectContaining({
        model_name: 'gpt-image-2',
        capability: 'image',
      }),
    ]);

    res = await app.inject({
      method: 'DELETE',
      url: `/v1/providers/${provider.id}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(204);
  });

  it('SiliconFlow discovery infers chat, vision and image capabilities', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(
        JSON.stringify({
          data: [
            { id: 'deepseek-ai/DeepSeek-V3', object: 'model' },
            {
              id: 'Qwen/Qwen2.5-VL-72B-Instruct',
              object: 'model',
              input_modalities: ['text', 'image'],
            },
            { id: 'black-forest-labs/FLUX.1-schnell', object: 'model' },
            { id: 'BAAI/bge-m3', object: 'model' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    let res = await app.inject({
      method: 'POST',
      url: '/v1/providers/test',
      headers: authJson,
      payload: {
        type: 'siliconflow',
        base_url: 'https://api.siliconflow.cn/v1',
        api_key: 'sk-sf-test',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, sample_count: 4 });

    res = await app.inject({
      method: 'POST',
      url: '/v1/providers',
      headers: authJson,
      payload: {
        name: 'SiliconFlow',
        type: 'siliconflow',
        base_url: 'https://api.siliconflow.cn/v1',
        api_key: 'sk-sf-test',
      },
    });
    expect(res.statusCode).toBe(201);
    const provider = res.json();

    res = await app.inject({
      method: 'GET',
      url: `/v1/providers/${provider.id}/discover`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const models = res.json().models as Array<{
      model_name: string;
      capability: string;
      supports_tools: boolean;
      supports_vision: boolean;
    }>;
    expect(models.find((m) => m.model_name === 'deepseek-ai/DeepSeek-V3')).toMatchObject({
      capability: 'chat',
      supports_tools: true,
    });
    expect(models.find((m) => m.model_name === 'Qwen/Qwen2.5-VL-72B-Instruct')).toMatchObject({
      capability: 'multimodal',
      supports_vision: true,
    });
    expect(models.find((m) => m.model_name === 'black-forest-labs/FLUX.1-schnell')).toMatchObject({
      capability: 'image',
      supports_tools: false,
    });
    expect(models.find((m) => m.model_name === 'BAAI/bge-m3')?.capability).toBe('embedding');

    res = await app.inject({
      method: 'DELETE',
      url: `/v1/providers/${provider.id}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(204);
  });

  it('DeepSeek official discovery imports official chat models with tools enabled', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      expect(String(url)).toBe('https://api.deepseek.com/models');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer sk-deepseek-test');
      return new Response(
        JSON.stringify({
          data: [
            { id: 'deepseek-v4-flash', object: 'model' },
            { id: 'deepseek-v4-pro', object: 'model' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    let res = await app.inject({
      method: 'POST',
      url: '/v1/providers/test',
      headers: authJson,
      payload: {
        type: 'deepseek',
        base_url: 'https://api.deepseek.com',
        api_key: 'sk-deepseek-test',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, sample_count: 2 });

    res = await app.inject({
      method: 'POST',
      url: '/v1/providers',
      headers: authJson,
      payload: {
        name: 'DeepSeek 官方',
        type: 'deepseek',
        base_url: 'https://api.deepseek.com',
        api_key: 'sk-deepseek-test',
      },
    });
    expect(res.statusCode).toBe(201);
    const provider = res.json();

    res = await app.inject({
      method: 'GET',
      url: `/v1/providers/${provider.id}/discover`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      recommended: { chat: string | null };
      models: Array<{
        model_name: string;
        display_name: string;
        capability: string;
        modalities: string[];
        supports_vision: boolean;
        supports_tools: boolean;
      }>;
    };
    expect(body.recommended.chat).toBe('deepseek-v4-flash');
    expect(body.models).toEqual([
      expect.objectContaining({
        model_name: 'deepseek-v4-flash',
        display_name: 'DeepSeek V4 Flash',
        capability: 'chat',
        modalities: ['text'],
        supports_vision: false,
        supports_tools: true,
      }),
      expect.objectContaining({
        model_name: 'deepseek-v4-pro',
        display_name: 'DeepSeek V4 Pro',
        capability: 'chat',
        supports_tools: true,
      }),
    ]);

    res = await app.inject({
      method: 'DELETE',
      url: `/v1/providers/${provider.id}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(204);
  });

  it('Huawei MaaS provider test reports missing /models as config error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('not found', { status: 404 }));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/providers/test',
      headers: authJson,
      payload: {
        type: 'huawei_maas',
        base_url: 'https://api.modelarts-maas.com/openai/v1',
        api_key: 'hw-test-key',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.error.classification).toBe('config_error');
  });

  it('Huawei MaaS discovery tries OpenAI-compatible then MaaS model-list URL and fails on auth errors', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('method not allowed', { status: 405 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: 'qwen-image', name: 'Qwen Image' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }));

    let res = await app.inject({
      method: 'POST',
      url: '/v1/providers',
      headers: authJson,
      payload: {
        name: 'Huawei MaaS test',
        type: 'huawei_maas',
        base_url: 'https://api.modelarts-maas.com/openai/v1',
        api_key: 'hw-test-key',
      },
    });
    expect(res.statusCode).toBe(201);
    const provider = res.json();

    res = await app.inject({
      method: 'GET',
      url: `/v1/providers/${provider.id}/discover`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const discovery = res.json();
    expect(discovery.models.some((m: { model_name: string }) => m.model_name === 'qwen-image')).toBe(true);
    expect(discovery.models).toHaveLength(1);
    expect(fetchSpy).toHaveBeenNthCalledWith(
      1,
      'https://api.modelarts-maas.com/openai/v1/models',
      expect.objectContaining({
        method: 'GET',
        headers: { Authorization: 'Bearer hw-test-key' },
      }),
    );
    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      'https://api.modelarts-maas.com/v2/models',
      expect.objectContaining({
        method: 'GET',
        headers: { Authorization: 'Bearer hw-test-key' },
      }),
    );

    res = await app.inject({
      method: 'GET',
      url: `/v1/providers/${provider.id}/discover`,
      headers: auth,
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().code).toBe('provider_error');
    expect(res.json().message).toMatch(/无权限|无效/);

    res = await app.inject({
      method: 'DELETE',
      url: `/v1/providers/${provider.id}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(204);
  });

  it('Huawei MaaS discovery infers multimodal, image and video capabilities from model ids', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { id: 'deepseek-v3.2', name: 'DeepSeek V3.2' },
            { id: 'qwen2.5-vl-72b', name: 'Qwen2.5 VL 72B' },
            { id: 'qwen-image', name: 'Qwen Image' },
            { id: 'Wan2.2-T2V-A14B', name: 'Wan2.2 T2V A14B' },
            { id: 'Wan2.2-I2V-A14B', name: 'Wan2.2 I2V A14B' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    let res = await app.inject({
      method: 'POST',
      url: '/v1/providers',
      headers: authJson,
      payload: {
        name: 'Huawei MaaS capabilities',
        type: 'huawei_maas',
        base_url: 'https://api.modelarts-maas.com/openai/v1',
        api_key: 'hw-test-key',
      },
    });
    expect(res.statusCode).toBe(201);
    const provider = res.json();

    res = await app.inject({
      method: 'GET',
      url: `/v1/providers/${provider.id}/discover`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const models = res.json().models as Array<{ model_name: string; capability: string; modalities: string[]; supports_vision: boolean; supports_tools: boolean }>;
    expect(models.find((m) => m.model_name === 'qwen2.5-vl-72b')).toMatchObject({
      capability: 'multimodal',
      supports_vision: true,
      modalities: ['text', 'image'],
      supports_tools: false,
    });
    expect(models.find((m) => m.model_name === 'deepseek-v3.2')).toMatchObject({
      capability: 'chat',
      supports_tools: true,
    });
    expect(models.find((m) => m.model_name === 'qwen-image')).toMatchObject({
      capability: 'image',
      modalities: ['image'],
    });
    expect(models.find((m) => m.model_name === 'Wan2.2-T2V-A14B')).toMatchObject({
      capability: 'video',
      modalities: ['text', 'video'],
    });
    expect(models.find((m) => m.model_name === 'Wan2.2-I2V-A14B')).toMatchObject({
      capability: 'video',
      modalities: ['text', 'image', 'video'],
    });

    expect(models.find((m) => m.model_name === 'glm-5.1')).toBeUndefined();

    res = await app.inject({
      method: 'DELETE',
      url: `/v1/providers/${provider.id}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(204);
  });

  it('Huawei MaaS discovery keeps unknown chat models non-tool-capable unless metadata says so', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { id: 'glm-5.1', name: 'GLM 5.1' },
            { id: 'glm-tools', name: 'GLM Tools', supports_tools: true },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    let res = await app.inject({
      method: 'POST',
      url: '/v1/providers',
      headers: authJson,
      payload: {
        name: 'Huawei GLM',
        type: 'huawei_maas',
        base_url: 'https://api.modelarts-maas.com/openai/v1',
        api_key: 'hw-test-key',
      },
    });
    expect(res.statusCode).toBe(201);
    const provider = res.json();

    res = await app.inject({
      method: 'GET',
      url: `/v1/providers/${provider.id}/discover`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const models = res.json().models as Array<{ model_name: string; capability: string; supports_tools: boolean }>;
    expect(models.find((m) => m.model_name === 'glm-5.1')).toMatchObject({
      model_name: 'glm-5.1',
      capability: 'chat',
      supports_tools: false,
    });
    expect(models.find((m) => m.model_name === 'glm-tools')).toMatchObject({
      model_name: 'glm-tools',
      capability: 'chat',
      supports_tools: true,
    });

    res = await app.inject({
      method: 'DELETE',
      url: `/v1/providers/${provider.id}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(204);
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

  it('DELETE /v1/providers/:id deletes managed models instead of leaving providerless rows', async () => {
    let res = await app.inject({
      method: 'POST',
      url: '/v1/providers',
      headers: authJson,
      payload: {
        name: 'Provider to delete',
        type: 'custom',
        base_url: 'https://example.invalid/v1',
        api_key: 'sk-delete-test',
      },
    });
    expect(res.statusCode).toBe(201);
    const provider = res.json() as { id: string };

    res = await app.inject({
      method: 'POST',
      url: '/v1/models',
      headers: authJson,
      payload: {
        provider_id: provider.id,
        model_name: 'delete-me',
        capability: 'chat',
        display_name: 'Delete Me',
        is_default_for: 'chat',
      },
    });
    expect(res.statusCode).toBe(201);
    const model = res.json() as { id: string };

    res = await app.inject({
      method: 'DELETE',
      url: `/v1/providers/${provider.id}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(204);

    res = await app.inject({ method: 'GET', url: '/v1/models', headers: auth });
    expect(res.statusCode).toBe(200);
    const rows = res.json().models as Array<{ id: string; provider_id: string | null }>;
    expect(rows.find((m) => m.id === model.id)).toBeUndefined();
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

  it('PATCH /v1/models/:id enabled=false clears stale default binding', async () => {
    const pr = await app.inject({
      method: 'POST',
      url: '/v1/providers',
      headers: authJson,
      payload: {
        name: 'disable-default-provider',
        type: 'openai',
        base_url: 'https://api.openai.com/v1',
        api_key: 'sk-test-disable-default',
      },
    });
    expect(pr.statusCode).toBe(201);
    const provider = pr.json() as { id: string };
    const mr = await app.inject({
      method: 'POST',
      url: '/v1/models',
      headers: authJson,
      payload: {
        provider_id: provider.id,
        model_name: 'disable-default-model',
        capability: 'chat',
        display_name: 'Disable default model',
        is_default_for: 'chat',
        enabled: true,
      },
    });
    expect(mr.statusCode).toBe(201);
    const model = mr.json() as { id: string; is_default_for: string | null };
    expect(model.is_default_for).toBe('chat');

    const patch = await app.inject({
      method: 'PATCH',
      url: `/v1/models/${model.id}`,
      headers: authJson,
      payload: { enabled: false },
    });
    expect(patch.statusCode).toBe(200);
    const updated = patch.json() as { enabled: boolean; is_default_for: string | null };
    expect(updated.enabled).toBe(false);
    expect(updated.is_default_for).toBeNull();
  });

  it('rejects assigning disabled models as defaults', async () => {
    const pr = await app.inject({
      method: 'POST',
      url: '/v1/providers',
      headers: authJson,
      payload: {
        name: 'disabled-default-provider',
        type: 'openai',
        base_url: 'https://api.openai.com/v1',
        api_key: 'sk-test-disabled-default',
      },
    });
    expect(pr.statusCode).toBe(201);
    const provider = pr.json() as { id: string };

    const createDisabledDefault = await app.inject({
      method: 'POST',
      url: '/v1/models',
      headers: authJson,
      payload: {
        provider_id: provider.id,
        model_name: 'disabled-default-on-create',
        capability: 'chat',
        display_name: 'Disabled default on create',
        is_default_for: 'chat',
        enabled: false,
      },
    });
    expect(createDisabledDefault.statusCode).toBe(400);
    expect(createDisabledDefault.json().message).toMatch(/disabled models cannot be set as default/i);

    const disabledModel = await app.inject({
      method: 'POST',
      url: '/v1/models',
      headers: authJson,
      payload: {
        provider_id: provider.id,
        model_name: 'disabled-default-existing',
        capability: 'chat',
        display_name: 'Disabled default existing',
        enabled: false,
      },
    });
    expect(disabledModel.statusCode).toBe(201);
    const model = disabledModel.json() as { id: string };

    const setDefault = await app.inject({
      method: 'POST',
      url: `/v1/models/${model.id}/default`,
      headers: authJson,
      payload: { capability: 'chat' },
    });
    expect(setDefault.statusCode).toBe(400);
    expect(setDefault.json().message).toMatch(/disabled models cannot be set as default/i);
  });

  it('POST /v1/models/:id/reset-health clears automatic demotion and suspension', async () => {
    const pr = await app.inject({
      method: 'POST',
      url: '/v1/providers',
      headers: authJson,
      payload: {
        name: 'reset-health-provider',
        type: 'openai',
        base_url: 'https://api.openai.com/v1',
        api_key: 'sk-test-reset-health',
      },
    });
    expect(pr.statusCode).toBe(201);
    const provider = pr.json() as { id: string };

    const mr = await app.inject({
      method: 'POST',
      url: '/v1/models',
      headers: authJson,
      payload: {
        provider_id: provider.id,
        model_name: 'reset-health-model',
        capability: 'chat',
        display_name: 'Reset health model',
      },
    });
    expect(mr.statusCode).toBe(201);
    const model = mr.json() as { id: string };

    modelsRepo.recordFailure(model.id, 'quota');
    modelsRepo.recordFailure(model.id, 'quota');
    modelsRepo.recordFailure(model.id, 'quota');
    modelsRepo.recordFailure(model.id, 'quota');
    modelsRepo.recordFailure(model.id, 'quota');

    const reset = await app.inject({
      method: 'POST',
      url: `/v1/models/${model.id}/reset-health`,
      headers: authJson,
      payload: {},
    });
    expect(reset.statusCode).toBe(200);
    const body = reset.json() as {
      failure_count_24h: number;
      demoted: boolean;
      disabled_until: number | null;
    };
    expect(body.failure_count_24h).toBe(0);
    expect(body.demoted).toBe(false);
    expect(body.disabled_until).toBeNull();
  });
});
