import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../src/server.js';
import { openDb } from '../src/db/index.js';
import { ControlClient } from '../src/control/client.js';
import { MemoryStore } from '../src/keystore.js';
import type { FastifyInstance } from 'fastify';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

describe('sidecar smoke', () => {
  let app: FastifyInstance;
  const dbPath = path.join(os.tmpdir(), `taori-test-${Date.now()}.db`);
  const bearer = 'test_bearer_token_xyz';

  beforeAll(async () => {
    const db = openDb(dbPath);
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

  afterAll(async () => {
    await app.close();
    fs.rmSync(dbPath, { force: true });
  });

  it('GET /health returns ok without auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.service).toBe('taori-sidecar');
    expect(body.control_channel).toBe('unknown');
  });

  it('POST /v1/chat without bearer → 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat',
      payload: { model_id: 'mdl_x', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('unauthorized');
  });

  it('POST /v1/chat with bearer streams data-stream-protocol', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat',
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
        origin: 'http://127.0.0.1:5173',
      },
      payload: { model_id: 'mdl_test', messages: [{ role: 'user', content: 'ping' }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-vercel-ai-data-stream']).toBe('v1');
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(res.headers['access-control-allow-origin']).toBe('http://127.0.0.1:5173');
    const lines = res.payload.split('\n').filter(Boolean);
    expect(lines.some((l) => l.startsWith('8:'))).toBe(true);
    expect(lines.some((l) => l.startsWith('0:'))).toBe(true);
    expect(lines.some((l) => l.startsWith('d:'))).toBe(true);
  });

  it('POST /v1/chat invalid body → 400 validation_error', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: { model_id: 'mdl_x' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('validation_error');
  });
});
