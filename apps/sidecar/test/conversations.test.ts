import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

  it('POST /v1/models/:id/test returns ok=true with note when provider has no key', async () => {
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
    const body = res.json() as { ok: boolean; note?: string };
    expect(body.ok).toBe(true);
    expect(body.note).toBe('no_api_key_configured');
  });

  it('POST /v1/models/:id/test on missing model returns 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/models/mdl_missing/test',
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
  });
});
