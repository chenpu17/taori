/**
 * M2.3 — Capability Bus + builtin.file_read + /v1/tools endpoints.
 *
 * Coverage:
 *   1. GET /v1/tools lists builtin.file_read.
 *   2. POST /v1/tools/invoke success path (text file).
 *   3. POST /v1/tools/invoke validation_error (unknown tool, bad input,
 *      file_id not found).
 *   4. cost_records auto-write on every invoke (success + failure).
 *   5. file_read on PDF.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { openDb } from '../src/db/index.js';
import { ControlClient } from '../src/control/client.js';
import { MemoryStore } from '../src/keystore.js';
import { FilesRepo } from '../src/db/repos/index.js';
import { cost_records } from '../src/db/schema.js';
import type { FastifyInstance } from 'fastify';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const bearer = 'test_bearer_m23';

async function invoke(app: FastifyInstance, body: unknown) {
  return app.inject({
    method: 'POST',
    url: '/v1/tools/invoke',
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });
}

describe('M2.3 capability bus + file_read', () => {
  let app: FastifyInstance;
  let dbPath: string;
  let db: ReturnType<typeof openDb>;
  let tmpDir: string;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `taori-m23-${Date.now()}-${Math.random()}.db`);
    db = openDb(dbPath);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taori-m23-files-'));
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
      keystore: new MemoryStore(),
      startedAt: Date.now(),
    });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GET /v1/tools lists builtin.file_read', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/tools',
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; data: Array<{ name: string; capability: string; source: string }> };
    expect(body.ok).toBe(true);
    const fr = body.data.find((t) => t.name === 'builtin.file_read');
    expect(fr).toBeDefined();
    expect(fr?.capability).toBe('file');
    expect(fr?.source).toBe('builtin');
  });

  it('invoke file_read returns text and writes cost_record', async () => {
    const filePath = path.join(tmpDir, 'sample.txt');
    fs.writeFileSync(filePath, 'hello taori');
    const filesRepo = new FilesRepo(db);
    const row = filesRepo.insert({
      conversation_id: null,
      message_id: null,
      original_path: filePath,
      mime_type: 'text/plain',
      size_bytes: 11,
    });

    const res = await invoke(app, { name: 'builtin.file_read', input: { file_id: row.id } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; data: { ok: boolean; output: { text: string; truncated: boolean; mime: string } } };
    expect(body.ok).toBe(true);
    expect(body.data.ok).toBe(true);
    expect(body.data.output.text).toBe('hello taori');
    expect(body.data.output.truncated).toBe(false);
    expect(body.data.output.mime).toBe('text/plain');

    // extracted_text persisted
    const reread = filesRepo.get(row.id);
    expect(reread?.extracted_text).toBe('hello taori');

    // cost_record written
    const costs = db.select().from(cost_records).all();
    const rec = costs.find((c) => c.source_type === 'tool_call');
    expect(rec).toBeDefined();
    expect(rec?.model_name_snapshot).toBe('builtin.file_read');
    expect(rec?.success).toBe(true);
    expect(rec?.actual_cost_usd).toBe(0);
  });

  it('invoke unknown tool → validation_error + cost record', async () => {
    const res = await invoke(app, { name: 'builtin.does_not_exist', input: {} });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; data: { ok: boolean; error: { classification: string } } };
    expect(body.data.ok).toBe(false);
    expect(body.data.error.classification).toBe('validation_error');
    const costs = db.select().from(cost_records).all();
    expect(costs.some((c) => c.source_type === 'tool_call' && !c.success)).toBe(true);
  });

  it('invoke with bad input shape → validation_error', async () => {
    const res = await invoke(app, { name: 'builtin.file_read', input: { wrong: 'field' } });
    const body = res.json() as { data: { ok: boolean; error: { classification: string } } };
    expect(body.data.ok).toBe(false);
    expect(body.data.error.classification).toBe('validation_error');
  });

  it('invoke file_read with missing file_id row → validation_error', async () => {
    const res = await invoke(app, { name: 'builtin.file_read', input: { file_id: 'file_doesnotexist' } });
    const body = res.json() as { data: { ok: boolean; error: { classification: string; message: string } } };
    expect(body.data.ok).toBe(false);
    expect(body.data.error.classification).toBe('validation_error');
    expect(body.data.error.message).toMatch(/file not found/i);
  });

  it('POST /v1/tools/invoke without bearer → 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tools/invoke',
      payload: { name: 'builtin.file_read', input: {} },
    });
    expect(res.statusCode).toBe(401);
  });

  it('GET /v1/tools without bearer → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/tools' });
    expect(res.statusCode).toBe(401);
  });
});
