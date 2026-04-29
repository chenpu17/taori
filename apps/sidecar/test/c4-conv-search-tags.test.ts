/**
 * C4 — sidebar pinning, tagging, and search.
 *
 * Verifies the new PATCH fields (pinned, tags) and that GET supports
 * `?q=` for title + message-content search, with pinned items sorted
 * to the top.
 */
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

const bearer = 'test_bearer_c4';
const auth = { authorization: `Bearer ${bearer}` };
const authJson = { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' };

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function newApp() {
  const dbPath = path.join(os.tmpdir(), `taori-c4-${Date.now()}-${Math.random()}.db`);
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

describe('C4 — sidebar pin / tag / search', () => {
  let app: FastifyInstance;
  let db: ReturnType<typeof openDb>;
  let dbPath: string;
  let convRepo: ConversationsRepo;
  let msgRepo: MessagesRepo;

  beforeEach(async () => {
    ({ app, db, dbPath } = newApp());
    convRepo = new ConversationsRepo(db);
    msgRepo = new MessagesRepo(db);
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    fs.rmSync(dbPath, { force: true });
  });

  it('PATCH conversations supports pinned and tags; pinned floats to top', async () => {
    const a = convRepo.create({ title: 'alpha' });
    await sleep(2);
    const b = convRepo.create({ title: 'beta' });
    await sleep(2);
    const c = convRepo.create({ title: 'gamma' });

    // Pin the OLDEST one.
    const r = await app.inject({
      method: 'PATCH',
      url: `/v1/conversations/${a.id}`,
      headers: authJson,
      payload: { pinned: true, tags: ['work', 'urgent'] },
    });
    expect(r.statusCode).toBe(200);
    const patched = JSON.parse(r.payload);
    expect(patched.pinned).toBe(true);
    expect(patched.tags).toBe(JSON.stringify(['work', 'urgent']));

    const list = await app.inject({ method: 'GET', url: '/v1/conversations', headers: auth });
    expect(list.statusCode).toBe(200);
    const items = (JSON.parse(list.payload).conversations as Array<{ id: string; pinned: boolean }>);
    expect(items[0].id).toBe(a.id);
    expect(items[0].pinned).toBe(true);
    // Non-pinned ordered by updated_at desc → c, b.
    expect(items[1].id).toBe(c.id);
    expect(items[2].id).toBe(b.id);
  });

  it('PATCH rejects more than 3 tags', async () => {
    const c = convRepo.create({ title: 'x' });
    const r = await app.inject({
      method: 'PATCH',
      url: `/v1/conversations/${c.id}`,
      headers: authJson,
      payload: { tags: ['a', 'b', 'c', 'd'] },
    });
    expect(r.statusCode).toBe(400);
  });

  it('GET /v1/conversations?q= matches title and message content', async () => {
    const a = convRepo.create({ title: 'Tokyo trip plan' });
    await sleep(2);
    const b = convRepo.create({ title: 'random' });
    msgRepo.insert({
      conversation_id: b.id,
      role: 'user',
      content: 'how do I configure SQLite WAL mode?',
      model_id: null,
      attachments: null,
    });
    await sleep(2);
    const c = convRepo.create({ title: 'unrelated' });

    const byTitle = await app.inject({
      method: 'GET',
      url: '/v1/conversations?q=tokyo',
      headers: auth,
    });
    const t = JSON.parse(byTitle.payload).conversations as Array<{ id: string }>;
    expect(t.map((x) => x.id)).toContain(a.id);
    expect(t.map((x) => x.id)).not.toContain(b.id);

    const byMsg = await app.inject({
      method: 'GET',
      url: '/v1/conversations?q=SQLite',
      headers: auth,
    });
    const m = JSON.parse(byMsg.payload).conversations as Array<{ id: string }>;
    expect(m.map((x) => x.id)).toContain(b.id);
    expect(m.map((x) => x.id)).not.toContain(a.id);

    const empty = await app.inject({
      method: 'GET',
      url: '/v1/conversations?q=zzz_nothing_here',
      headers: auth,
    });
    expect((JSON.parse(empty.payload).conversations as unknown[]).length).toBe(0);

    // c is unused but we want to ensure unrelated conv exists for ranking.
    expect(c.id).toBeTruthy();
  });
});
