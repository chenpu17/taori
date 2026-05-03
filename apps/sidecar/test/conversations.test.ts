import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildServer } from '../src/server.js';
import { openDb } from '../src/db/index.js';
import { ControlClient } from '../src/control/client.js';
import { MemoryStore } from '../src/keystore.js';
import { ConversationsRepo, MessagesRepo } from '../src/db/repos/index.js';
import type { FastifyInstance } from 'fastify';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const bearer = 'test_bearer_conv';
const auth = { authorization: `Bearer ${bearer}` };
const authJson = { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' };

function newApp() {
  const dbPath = path.join(os.tmpdir(), `taori-conv-${Date.now()}-${Math.random()}.db`);
  const db = openDb(dbPath);
  const keystore = new MemoryStore();
  const app = buildServer({
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
  return { app, db, dbPath, keystore };
}

describe('conversations route', () => {
  let app: FastifyInstance;
  let db: ReturnType<typeof openDb>;
  let dbPath: string;

  beforeEach(async () => {
    ({ app, db, dbPath } = newApp());
    await app.ready();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
    fs.rmSync(dbPath, { force: true });
  });

  it('chat seeds a titled conversation, then GET /v1/conversations lists it', async () => {
    const chat = await app.inject({
      method: 'POST',
      url: '/v1/chat',
      headers: authJson,
      payload: {
        model_id: 'mdl_unknown',
        messages: [{ role: 'user', content: 'Plan a 2-day Tokyo trip with kids' }],
      },
    });
    expect(chat.statusCode).toBe(200);

    const list = await app.inject({ method: 'GET', url: '/v1/conversations', headers: auth });
    expect(list.statusCode).toBe(200);
    const body = list.json() as { conversations: Array<{ id: string; title: string | null }> };
    expect(body.conversations.length).toBe(1);
    expect(body.conversations[0]!.title).toMatch(/Plan a 2-day Tokyo trip/);
  });

  it('GET /v1/conversations/:id/messages returns user + assistant rows without raw attachments', async () => {
    const chat = await app.inject({
      method: 'POST',
      url: '/v1/chat',
      headers: authJson,
      payload: { model_id: 'mdl_x', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(chat.statusCode).toBe(200);
    const conv = new ConversationsRepo(db).list()[0]!;

    const res = await app.inject({
      method: 'GET',
      url: `/v1/conversations/${conv.id}/messages`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      conversation: { id: string };
      messages: Array<{ role: string; attachments_count: number; content: string | null }>;
    };
    expect(body.conversation.id).toBe(conv.id);
    expect(body.messages.length).toBe(2);
    expect(body.messages[0]!.role).toBe('user');
    expect(body.messages[1]!.role).toBe('assistant');
    expect(body.messages[0]!.attachments_count).toBe(0);
  });

  it('PATCH /v1/conversations/:id renames the conversation', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/chat',
      headers: authJson,
      payload: { model_id: 'm', messages: [{ role: 'user', content: 'first message' }] },
    });
    const conv = new ConversationsRepo(db).list()[0]!;

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/conversations/${conv.id}`,
      headers: authJson,
      payload: { title: 'Renamed Topic' },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { title: string }).title).toBe('Renamed Topic');
  });

  it('PATCH /v1/conversations/:id supports archived flag (R5 m-2)', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/chat',
      headers: authJson,
      payload: { model_id: 'm', messages: [{ role: 'user', content: 'msg' }] },
    });
    const conv = new ConversationsRepo(db).list()[0]!;

    const archive = await app.inject({
      method: 'PATCH',
      url: `/v1/conversations/${conv.id}`,
      headers: authJson,
      payload: { archived: true },
    });
    expect(archive.statusCode).toBe(200);
    expect((archive.json() as { archived: boolean }).archived).toBe(true);

    // Archived conversations are excluded from the default list().
    const list1 = await app.inject({
      method: 'GET',
      url: '/v1/conversations',
      headers: authJson,
    });
    expect(
      (list1.json() as { conversations: { id: string }[] }).conversations.find(
        (c) => c.id === conv.id,
      ),
    ).toBeUndefined();

    // Un-archive restores it.
    const restore = await app.inject({
      method: 'PATCH',
      url: `/v1/conversations/${conv.id}`,
      headers: authJson,
      payload: { archived: false },
    });
    expect((restore.json() as { archived: boolean }).archived).toBe(false);
  });

  it('DELETE /v1/conversations/:id cascades to messages', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/chat',
      headers: authJson,
      payload: { model_id: 'm', messages: [{ role: 'user', content: 'will be gone' }] },
    });
    const convRepo = new ConversationsRepo(db);
    const msgRepo = new MessagesRepo(db);
    const conv = convRepo.list()[0]!;
    expect(msgRepo.listByConversation(conv.id).length).toBe(2);

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/conversations/${conv.id}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(204);
    expect(convRepo.get(conv.id)).toBeNull();
    expect(msgRepo.listByConversation(conv.id).length).toBe(0);
  });

  it('PATCH on missing id returns 404', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/conversations/conv_does_not_exist',
      headers: authJson,
      payload: { title: 'x' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /v1/conversations/:id/messages persists a system note (M2 §1.4)', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/chat',
      headers: authJson,
      payload: { model_id: 'm', messages: [{ role: 'user', content: 'hello' }] },
    });
    const convRepo = new ConversationsRepo(db);
    const msgRepo = new MessagesRepo(db);
    const conv = convRepo.list()[0]!;

    const ok = await app.inject({
      method: 'POST',
      url: `/v1/conversations/${conv.id}/messages`,
      headers: authJson,
      payload: { role: 'system', content: '已自动切换到「Backup Model」并重试。' },
    });
    expect(ok.statusCode).toBe(201);
    const body = ok.json() as { message: { role: string; content: string } };
    expect(body.message.role).toBe('system');

    const all = msgRepo.listByConversation(conv.id);
    expect(all.some((m) => m.role === 'system' && m.content?.includes('自动切换'))).toBe(true);

    const bad = await app.inject({
      method: 'POST',
      url: `/v1/conversations/${conv.id}/messages`,
      headers: authJson,
      payload: { role: 'user', content: 'should reject' },
    });
    expect(bad.statusCode).toBe(400);

    const missing = await app.inject({
      method: 'POST',
      url: '/v1/conversations/conv_nope/messages',
      headers: authJson,
      payload: { role: 'system', content: 'x' },
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe('models test endpoint (MC-4)', () => {
  let app: FastifyInstance;
  let db: ReturnType<typeof openDb>;
  let dbPath: string;

  beforeEach(async () => {
    ({ app, db, dbPath } = newApp());
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    fs.rmSync(dbPath, { force: true });
  });

  it('POST /v1/models/:id/test returns ok=false with key_missing when provider has no key', async () => {
    const provider = await app.inject({
      method: 'POST',
      url: '/v1/providers',
      headers: authJson,
      // No api_key → keyless dev provider
      payload: { name: 'dev', type: 'custom', base_url: 'http://localhost:9' },
    });
    const providerId = (provider.json() as { id: string }).id;
    const model = await app.inject({
      method: 'POST',
      url: '/v1/models',
      headers: authJson,
      payload: {
        provider_id: providerId,
        model_name: 'mock-1',
        capability: 'chat',
        display_name: 'Mock 1',
      },
    });
    const modelId = (model.json() as { id: string }).id;

    const res = await app.inject({
      method: 'POST',
      url: `/v1/models/${modelId}/test`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; note?: string; error?: { classification: string } };
    expect(body.ok).toBe(false);
    expect(body.note).toBe('no_api_key_configured');
    expect(body.error?.classification).toBe('key_missing');
  });

  it('POST /v1/models/:id/test on missing model returns 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/models/mdl_missing/test',
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /v1/models/:id/test probes tools support and enables it when accepted', async () => {
    const provider = await app.inject({
      method: 'POST',
      url: '/v1/providers',
      headers: authJson,
      payload: {
        name: 'compat',
        type: 'custom',
        base_url: 'https://compat.example.com/v1',
        api_key: 'sk-test',
      },
    });
    const providerId = (provider.json() as { id: string }).id;
    const model = await app.inject({
      method: 'POST',
      url: '/v1/models',
      headers: authJson,
      payload: {
        provider_id: providerId,
        model_name: 'kimi-k2.6',
        capability: 'chat',
        display_name: 'Kimi K2.6',
        supports_tools: false,
      },
    });
    const modelId = (model.json() as { id: string }).id;
    let calls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      calls++;
      const raw = typeof init?.body === 'string' ? init.body : String(init?.body ?? '{}');
      const body = JSON.parse(raw) as { tools?: unknown[] };
      if (calls === 2) expect(Array.isArray(body.tools)).toBe(true);
      return new Response(
        JSON.stringify({
          id: `chatcmpl-${calls}`,
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/models/${modelId}/test`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; tools_probe?: { supported: boolean; updated: boolean } };
    expect(body.ok).toBe(true);
    expect(body.tools_probe).toMatchObject({ supported: true, updated: true });

    const listed = await app.inject({ method: 'GET', url: '/v1/models', headers: auth });
    const saved = (listed.json() as { models: Array<{ id: string; supports_tools: boolean }> }).models
      .find((m) => m.id === modelId);
    expect(saved?.supports_tools).toBe(true);
  });

  it('POST /v1/models/:id/test disables tools when the provider rejects tools payload', async () => {
    const provider = await app.inject({
      method: 'POST',
      url: '/v1/providers',
      headers: authJson,
      payload: {
        name: 'compat',
        type: 'custom',
        base_url: 'https://compat.example.com/v1',
        api_key: 'sk-test',
      },
    });
    const providerId = (provider.json() as { id: string }).id;
    const model = await app.inject({
      method: 'POST',
      url: '/v1/models',
      headers: authJson,
      payload: {
        provider_id: providerId,
        model_name: 'kimi-k2.6',
        capability: 'chat',
        display_name: 'Kimi K2.6',
        supports_tools: true,
      },
    });
    const modelId = (model.json() as { id: string }).id;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const raw = typeof init?.body === 'string' ? init.body : String(init?.body ?? '{}');
      const body = JSON.parse(raw) as { tools?: unknown[] };
      if (Array.isArray(body.tools)) {
        return new Response(
          JSON.stringify({ error: { message: 'This model does not support tools parameter' } }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-ping',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/models/${modelId}/test`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; tools_probe?: { supported: boolean; updated: boolean } };
    expect(body.ok).toBe(true);
    expect(body.tools_probe).toMatchObject({ supported: false, updated: true });

    const listed = await app.inject({ method: 'GET', url: '/v1/models', headers: auth });
    const saved = (listed.json() as { models: Array<{ id: string; supports_tools: boolean }> }).models
      .find((m) => m.id === modelId);
    expect(saved?.supports_tools).toBe(false);
  });
});
