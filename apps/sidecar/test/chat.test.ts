import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildServer } from '../src/server.js';
import { openDb } from '../src/db/index.js';
import { ControlClient } from '../src/control/client.js';
import { MemoryStore } from '../src/keystore.js';
import { ConversationsRepo, MessagesRepo, ProvidersRepo, ModelsRepo } from '../src/db/repos/index.js';
import type { FastifyInstance } from 'fastify';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const bearer = 'test_bearer_chat';

function newApp() {
  const dbPath = path.join(os.tmpdir(), `taori-chat-${Date.now()}-${Math.random()}.db`);
  const db = openDb(dbPath);
  const keystore = new MemoryStore();
  const app = buildServer({
    config: { port: 0, bearer, dbPath, controlUrl: null, controlBearer: null, isDev: false, version: '0.0.0-test' },
    db,
    control: new ControlClient({ url: null, bearer: null }),
    keystore,
    startedAt: Date.now(),
  });
  return { app, db, dbPath, keystore };
}

describe('chat M1.2', () => {
  let app: FastifyInstance;
  let dbPath: string;
  let db: ReturnType<typeof openDb>;
  let keystore: MemoryStore;

  beforeEach(async () => {
    ({ app, db, dbPath, keystore } = newApp());
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    fs.rmSync(dbPath, { force: true });
    vi.restoreAllMocks();
  });

  it('mock-path: persists user + assistant messages and conversation', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: { model_id: 'mdl_unknown', messages: [{ role: 'user', content: 'hello taori' }] },
    });
    expect(res.statusCode).toBe(200);
    // Extract conversation_id from the meta annotation.
    const metaLine = res.payload.split('\n').find((l) => l.startsWith('8:'));
    expect(metaLine).toBeTruthy();
    const metaArr = JSON.parse(metaLine!.slice(2)) as Array<{ type: string; conversation_id?: string; message_id?: string }>;
    const meta = metaArr.find((m) => m.type === 'meta');
    expect(meta?.conversation_id).toMatch(/^conv_/);
    expect(meta?.message_id).toMatch(/^msg_/);

    const convRepo = new ConversationsRepo(db);
    const msgRepo = new MessagesRepo(db);
    const conv = convRepo.get(meta!.conversation_id!);
    expect(conv).toBeTruthy();
    const msgs = msgRepo.listByConversation(meta!.conversation_id!);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.role).toBe('user');
    expect(msgs[0]!.content).toBe('hello taori');
    expect(msgs[0]!.status).toBe('complete');
    expect(msgs[1]!.role).toBe('assistant');
    expect(msgs[1]!.status).toBe('complete');
    expect(msgs[1]!.content).toContain('hello taori');
  });

  it('reuses existing conversation_id on follow-up turn', async () => {
    const r1 = await app.inject({
      method: 'POST',
      url: '/v1/chat',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: { model_id: 'mdl_x', messages: [{ role: 'user', content: 'first' }] },
    });
    const meta1 = JSON.parse(r1.payload.split('\n').find((l) => l.startsWith('8:'))!.slice(2))[0];
    const convId = meta1.conversation_id;

    const r2 = await app.inject({
      method: 'POST',
      url: '/v1/chat',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: {
        conversation_id: convId,
        model_id: 'mdl_x',
        messages: [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'reply1' },
          { role: 'user', content: 'second' },
        ],
      },
    });
    expect(r2.statusCode).toBe(200);
    const msgs = new MessagesRepo(db).listByConversation(convId);
    // user1 + assistant1 + user2 + assistant2
    expect(msgs).toHaveLength(4);
    expect(msgs.filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['first', 'second']);
  });

  it('upstream-path: uses keystore key + streamText (mocked fetch)', async () => {
    // Seed a real provider + model + key.
    const provRepo = new ProvidersRepo(db);
    const modRepo = new ModelsRepo(db);
    const provider = provRepo.create({
      name: 'OpenRouter',
      type: 'openrouter',
      base_url: 'https://openrouter.example.com/api/v1',
      api_key: 'sk-test-xyz',
    });
    await keystore.write(provider.api_key_ref!, 'sk-test-xyz');
    const model = modRepo.create({
      provider_id: provider.id,
      model_name: 'meta/llama-3-8b',
      capability: 'chat',
      display_name: 'Llama 3 8B',
    });

    // Mock the upstream OpenAI-compat /chat/completions stream response.
    const sseBody =
      `data: ${JSON.stringify({ id: '1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello' }, finish_reason: null }] })}\n\n` +
      `data: ${JSON.stringify({ id: '1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { content: ' world' }, finish_reason: null }] })}\n\n` +
      `data: ${JSON.stringify({ id: '1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })}\n\n` +
      `data: [DONE]\n\n`;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      expect(String(url)).toContain('openrouter.example.com');
      return new Response(sseBody, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: { model_id: model.id, messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res.statusCode).toBe(200);
    expect(fetchSpy).toHaveBeenCalled();
    const text = res.payload;
    expect(text).toContain('"Hello"');
    expect(text).toContain('" world"');
    // assistant message persisted with full content
    const meta = JSON.parse(text.split('\n').find((l) => l.startsWith('8:'))!.slice(2))[0];
    const msgs = new MessagesRepo(db).listByConversation(meta.conversation_id);
    const asst = msgs.find((m) => m.role === 'assistant')!;
    expect(asst.content).toBe('Hello world');
    expect(asst.status).toBe('complete');
    expect(asst.model_id).toBe(model.id);
  });

  it('upstream-path: classifies upstream error and persists assistant as failed', async () => {
    const provRepo = new ProvidersRepo(db);
    const modRepo = new ModelsRepo(db);
    const provider = provRepo.create({
      name: 'OR',
      type: 'openrouter',
      base_url: 'https://openrouter.example.com/api/v1',
      api_key: 'sk-bad',
    });
    await keystore.write(provider.api_key_ref!, 'sk-bad');
    const model = modRepo.create({
      provider_id: provider.id,
      model_name: 'meta/llama',
      capability: 'chat',
      display_name: 'Llama',
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'invalid key' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: { model_id: model.id, messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res.statusCode).toBe(200);
    const lines = res.payload.split('\n').filter(Boolean);
    // either an error line `3:` or a finish-reason error in `d:`
    expect(lines.some((l) => l.startsWith('3:') || /finishReason":"error"/.test(l))).toBe(true);
    // Assistant row should be marked failed (or incomplete if abort timing)
    const meta = JSON.parse(lines.find((l) => l.startsWith('8:'))!.slice(2))[0];
    const msgs = new MessagesRepo(db).listByConversation(meta.conversation_id);
    const asst = msgs.find((m) => m.role === 'assistant')!;
    expect(['failed', 'complete']).toContain(asst.status);
  });

  it('rejects image attachment for non-vision model with validation_error', async () => {
    const provRepo = new ProvidersRepo(db);
    const modRepo = new ModelsRepo(db);
    const provider = provRepo.create({
      name: 'OR',
      type: 'openrouter',
      base_url: 'https://openrouter.example.com/api/v1',
    });
    const model = modRepo.create({
      provider_id: provider.id,
      model_name: 'text-only',
      capability: 'chat',
      display_name: 'Text-only',
      supports_vision: false,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: {
        model_id: model.id,
        messages: [{ role: 'user', content: 'describe this' }],
        attachments: [{ kind: 'image', mime: 'image/png', data_b64: 'iVBOR' }],
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { code: string; message: string };
    expect(body.code).toBe('validation_error');
    expect(body.message).toMatch(/视觉|vision/);
  });

  it('accepts image attachment for vision-capable model and persists it on user row', async () => {
    const provRepo = new ProvidersRepo(db);
    const modRepo = new ModelsRepo(db);
    const provider = provRepo.create({
      name: 'OR',
      type: 'openrouter',
      base_url: 'https://openrouter.example.com/api/v1',
    });
    const model = modRepo.create({
      provider_id: provider.id,
      model_name: 'vision',
      capability: 'chat',
      display_name: 'Vision',
      supports_vision: true,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: {
        model_id: model.id,
        messages: [{ role: 'user', content: 'see this' }],
        attachments: [{ kind: 'image', mime: 'image/png', data_b64: 'iVBORw0K', name: 'a.png' }],
      },
    });
    expect(res.statusCode).toBe(200);
    const meta = JSON.parse(res.payload.split('\n').find((l) => l.startsWith('8:'))!.slice(2))[0];
    const msgs = new MessagesRepo(db).listByConversation(meta.conversation_id);
    const userRow = msgs.find((m) => m.role === 'user')!;
    expect(userRow.attachments).toBeTruthy();
    const parsed = JSON.parse(userRow.attachments!);
    expect(parsed[0].kind).toBe('image');
    expect(parsed[0].name).toBe('a.png');
  });

  it('accepts generated-image sized vision attachments instead of failing at the HTTP parser', async () => {
    const provRepo = new ProvidersRepo(db);
    const modRepo = new ModelsRepo(db);
    const provider = provRepo.create({
      name: 'OR',
      type: 'openrouter',
      base_url: 'https://openrouter.example.com/api/v1',
    });
    const model = modRepo.create({
      provider_id: provider.id,
      model_name: 'vision-large',
      capability: 'multimodal',
      display_name: 'Vision Large',
      supports_vision: true,
    });
    const largeB64 = 'a'.repeat(1_500_000);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        model_id: model.id,
        messages: [{ role: 'user', content: '请理解这张图片' }],
        attachments: [{ kind: 'image', mime: 'image/png', data_b64: largeB64, name: 'generated.png' }],
      }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('"message_id":"msg_');
    expect(res.payload).not.toContain('"code":"internal"');
  });
});
