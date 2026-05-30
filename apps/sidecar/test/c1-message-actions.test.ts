/**
 * C1 — message-level actions: edit-and-truncate + branch.
 *
 * Verified end-to-end against the real route + repos so the renderer can
 * trust the same response shape.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { openDb } from '../src/db/index.js';
import { messages } from '../src/db/schema.js';
import { ControlClient } from '../src/control/client.js';
import { MemoryStore } from '../src/keystore.js';
import {
  ConversationsRepo,
  MessagesRepo,
} from '../src/db/repos/index.js';
import type { FastifyInstance } from 'fastify';
import { inArray } from 'drizzle-orm';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const bearer = 'test_bearer_c1';

interface Ctx {
  app: FastifyInstance;
  db: ReturnType<typeof openDb>;
  dbPath: string;
  convs: ConversationsRepo;
  msgs: MessagesRepo;
}

async function makeCtx(): Promise<Ctx> {
  const dbPath = path.join(os.tmpdir(), `taori-c1-${Date.now()}-${Math.random()}.db`);
  const db = openDb(dbPath);
  const app = buildServer({
    config: {
      port: 0,
      bearer,
      dbPath,
      controlUrl: null,
      controlBearer: null,
      isDev: true,
      version: '0.0.0-test',
    },
    db,
    control: new ControlClient({ url: null, bearer: null }),
    keystore: new MemoryStore(),
    startedAt: Date.now(),
  });
  await app.ready();
  return {
    app,
    db,
    dbPath,
    convs: new ConversationsRepo(db),
    msgs: new MessagesRepo(db),
  };
}

async function teardown(ctx: Ctx): Promise<void> {
  await ctx.app.close();
  fs.rmSync(ctx.dbPath, { force: true });
}

async function seedConversationWithMessages(ctx: Ctx) {
  const conv = ctx.convs.create({ type: 'chat', title: '测试' });
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const u1 = ctx.msgs.insert({ conversation_id: conv.id, role: 'user', content: 'hello', status: 'complete' });
  await sleep(2);
  const a1 = ctx.msgs.insert({ conversation_id: conv.id, role: 'assistant', content: 'hi there', status: 'complete' });
  await sleep(2);
  const u2 = ctx.msgs.insert({ conversation_id: conv.id, role: 'user', content: 'follow up', status: 'complete' });
  await sleep(2);
  const a2 = ctx.msgs.insert({ conversation_id: conv.id, role: 'assistant', content: 'sure', status: 'complete' });
  return { conv, u1, a1, u2, a2 };
}

describe('C1 — message edit + branch', () => {
  let ctx: Ctx;
  beforeEach(async () => { ctx = await makeCtx(); });
  afterEach(async () => { await teardown(ctx); });

  it('PATCH user message updates content and deletes everything after it', async () => {
    const { conv, u2 } = await seedConversationWithMessages(ctx);
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/conversations/${conv.id}/messages/${u2.id}`,
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ content: 'rewritten follow up' }),
    });
    expect(res.statusCode).toBe(200);
    const remaining = ctx.msgs.listByConversation(conv.id);
    expect(remaining.map((m) => ({ role: m.role, content: m.content }))).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
      { role: 'user', content: 'rewritten follow up' },
    ]);
  });

  it('PATCH truncates messages inserted in the same millisecond after the edited user turn', async () => {
    const conv = ctx.convs.create({ type: 'chat', title: 'same-ms' });
    const now = Date.now();
    const u1 = ctx.msgs.insert({ conversation_id: conv.id, role: 'user', content: 'same ms user', status: 'complete' });
    const a1 = ctx.msgs.insert({ conversation_id: conv.id, role: 'assistant', content: 'same ms assistant', status: 'complete' });
    ctx.db.update(messages).set({ created_at: now }).where(inArray(messages.id, [u1.id, a1.id])).run();

    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/conversations/${conv.id}/messages/${u1.id}`,
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ content: 'same ms edited' }),
    });

    expect(res.statusCode).toBe(200);
    const remaining = ctx.msgs.listByConversation(conv.id);
    expect(remaining.map((m) => ({ role: m.role, content: m.content }))).toEqual([
      { role: 'user', content: 'same ms edited' },
    ]);
  });

  it('PATCH on assistant message returns 400 (validation_error)', async () => {
    const { conv, a1 } = await seedConversationWithMessages(ctx);
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/conversations/${conv.id}/messages/${a1.id}`,
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ content: 'nope' }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('validation_error');
  });

  it('PATCH on missing message returns 404', async () => {
    const { conv } = await seedConversationWithMessages(ctx);
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/conversations/${conv.id}/messages/msg_nope`,
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ content: 'x' }),
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /branch clones every message up to and including the pivot into a new chat conv', async () => {
    const { conv, a1 } = await seedConversationWithMessages(ctx);
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/conversations/${conv.id}/messages/${a1.id}/branch`,
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.copied_messages).toBe(2);
    expect(body.conversation.type).toBe('chat');
    expect(body.conversation.id).not.toBe(conv.id);
    const cloned = ctx.msgs.listByConversation(body.conversation.id);
    expect(cloned.map((m) => ({ role: m.role, content: m.content }))).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ]);
    // Original conversation untouched.
    expect(ctx.msgs.listByConversation(conv.id)).toHaveLength(4);
  });

  it('POST /branch on a missing message returns 404', async () => {
    const { conv } = await seedConversationWithMessages(ctx);
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/conversations/${conv.id}/messages/msg_nope/branch`,
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(404);
  });
});
