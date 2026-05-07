import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db/index.js';
import { StructuredMemoriesRepo } from '../src/db/repos/index.js';
import { buildServer } from '../src/server.js';
import { ControlClient } from '../src/control/client.js';
import { MemoryStore } from '../src/keystore.js';
import type { FastifyInstance } from 'fastify';

describe('StructuredMemoriesRepo', () => {
  let dbPath: string;
  let db: ReturnType<typeof openDb>;
  let repo: StructuredMemoriesRepo;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `taori-structured-memories-${Date.now()}-${Math.random()}.db`);
    db = openDb(dbPath);
    repo = new StructuredMemoriesRepo(db);
  });

  afterEach(() => {
    fs.rmSync(dbPath, { force: true });
  });

  it('stores visible memories with source metadata and supports disable/delete/touch', () => {
    const created = repo.insert({
      scope: 'global',
      type: 'preference',
      content: '用户偏好简短回答',
      source_conversation_id: null,
      source_message_id: null,
    });

    expect(created.id).toMatch(/^mem_/);
    expect(created.enabled).toBe(true);
    expect(created.deleted_at).toBeNull();
    expect(repo.list({ scope: 'global' }).map((row) => row.id)).toEqual([created.id]);

    const disabled = repo.setEnabled(created.id, false);
    expect(disabled?.enabled).toBe(false);
    expect(repo.list({ scope: 'global' })).toEqual([]);
    expect(repo.list({ scope: 'global', includeDisabled: true })).toHaveLength(1);

    repo.markUsed([created.id], 12345);
    const touched = repo.list({ scope: 'global', includeDisabled: true })[0]!;
    expect(touched.last_used_at).toBe(12345);

    const deleted = repo.softDelete(created.id);
    expect(deleted?.deleted_at).toBeTruthy();
    expect(repo.list({ scope: 'global', includeDisabled: true })).toEqual([]);
    expect(repo.list({ scope: 'global', includeDisabled: true, includeDeleted: true })).toHaveLength(1);
  });
});

describe('structured memories routes', () => {
  const bearer = 'test_bearer_structured_memories';
  let app: FastifyInstance;
  let dbPath: string;
  let db: ReturnType<typeof openDb>;
  let repo: StructuredMemoriesRepo;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `taori-structured-memories-route-${Date.now()}-${Math.random()}.db`);
    db = openDb(dbPath);
    repo = new StructuredMemoriesRepo(db);
    app = buildServer({
      config: { port: 0, bearer, dbPath, controlUrl: null, controlBearer: null, isDev: false, version: '0.0.0-test' },
      db,
      control: new ControlClient({ url: null, bearer: null }),
      keystore: new MemoryStore(),
      startedAt: Date.now(),
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    fs.rmSync(dbPath, { force: true });
  });

  it('lists, disables, and deletes structured memories for the drawer', async () => {
    const created = repo.insert({
      scope: 'global',
      type: 'project_fact',
      content: '项目使用 Tauri + React',
      source_conversation_id: null,
      source_message_id: null,
    });

    const listRes = await app.inject({
      method: 'GET',
      url: '/v1/structured-memories?include_disabled=true',
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().data.memories).toHaveLength(1);
    expect(listRes.json().data.memories[0].id).toBe(created.id);

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/v1/structured-memories/${created.id}`,
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: { enabled: false },
    });
    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json().data.enabled).toBe(false);

    const deleteRes = await app.inject({
      method: 'DELETE',
      url: `/v1/structured-memories/${created.id}`,
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(deleteRes.statusCode).toBe(200);
    expect(repo.list({ includeDisabled: true })).toEqual([]);
  });
});
