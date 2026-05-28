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

  it('does not emit CORS allow-origin for non-standalone requests without Origin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('standalone browser mode serves login HTML at / when password auth is enabled', async () => {
    const standaloneDbPath = path.join(os.tmpdir(), `taori-standalone-${Date.now()}.db`);
    const standaloneDb = openDb(standaloneDbPath);
    const standaloneApp = buildServer({
      config: {
        host: '0.0.0.0',
        port: 4101,
        bearer,
        dbPath: standaloneDbPath,
        controlUrl: null,
        controlBearer: null,
        isDev: false,
        standalone: true,
        standaloneAccessPassword: 'secret-pass',
        version: '0.0.0-test',
      },
      db: standaloneDb,
      control: new ControlClient({ url: null, bearer: null }),
      keystore: new MemoryStore(),
      startedAt: Date.now(),
    });
    await standaloneApp.ready();
    try {
      const res = await standaloneApp.inject({ method: 'GET', url: '/' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/html/);
      expect(res.body).toContain('Taori Browser Access');
      expect(res.body).toContain('输入访问密码');
    } finally {
      await standaloneApp.close();
      fs.rmSync(standaloneDbPath, { force: true });
    }
  });

  it('standalone browser mode explains how to enable Web UI when password is missing', async () => {
    const standaloneDbPath = path.join(os.tmpdir(), `taori-standalone-nopass-${Date.now()}.db`);
    const standaloneDb = openDb(standaloneDbPath);
    const standaloneApp = buildServer({
      config: {
        host: '0.0.0.0',
        port: 4102,
        bearer,
        dbPath: standaloneDbPath,
        controlUrl: null,
        controlBearer: null,
        isDev: false,
        standalone: true,
        standaloneAccessPassword: null,
        version: '0.0.0-test',
      },
      db: standaloneDb,
      control: new ControlClient({ url: null, bearer: null }),
      keystore: new MemoryStore(),
      startedAt: Date.now(),
    });
    await standaloneApp.ready();
    try {
      const res = await standaloneApp.inject({ method: 'GET', url: '/' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/html/);
      expect(res.body).toContain('Taori 浏览器入口未启用');
      expect(res.body).toContain('--password');
    } finally {
      await standaloneApp.close();
      fs.rmSync(standaloneDbPath, { force: true });
    }
  });
});
