/**
 * M2.1 — failure_decision annotation + memories endpoint.
 *
 * The sidecar must emit a `8:[{type:"failure_decision",...}]` annotation
 * before the `3:` error frame so renderers have everything they need
 * to render the in-stream decision card.
 *
 * We exercise the path via the dev-only `X-Test-Force-Classification`
 * header (gated by NODE_ENV !== 'production').
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { openDb } from '../src/db/index.js';
import { ControlClient } from '../src/control/client.js';
import { MemoryStore } from '../src/keystore.js';
import { ProvidersRepo, ModelsRepo } from '../src/db/repos/index.js';
import type { FastifyInstance } from 'fastify';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const bearer = 'test_bearer_m2_1';

function newApp() {
  const dbPath = path.join(os.tmpdir(), `taori-m2-1-${Date.now()}-${Math.random()}.db`);
  const db = openDb(dbPath);
  const keystore = new MemoryStore();
  const app = buildServer({
    config: { port: 0, bearer, dbPath, controlUrl: null, controlBearer: null, isDev: true, version: '0.0.0-test' },
    db,
    control: new ControlClient({ url: null, bearer: null }),
    keystore,
    startedAt: Date.now(),
  });
  return { app, db, dbPath, keystore };
}

function parseFrames(body: string): Array<{ tag: string; payload: string }> {
  return body
    .split('\n')
    .filter((l) => l.length > 0 && l.includes(':'))
    .map((l) => {
      const idx = l.indexOf(':');
      return { tag: l.slice(0, idx), payload: l.slice(idx + 1) };
    });
}

describe('M2.1 failure_decision annotation', () => {
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
  });

  async function seedProviderAndModels(): Promise<{ primaryId: string; fallbackId: string }> {
    const provRepo = new ProvidersRepo(db);
    const modRepo = new ModelsRepo(db);
    const provider = provRepo.create({
      name: 'P',
      type: 'openrouter',
      base_url: 'https://x.example/api/v1',
      api_key: 'k',
    });
    await keystore.write(provider.api_key_ref!, 'k');
    const primary = modRepo.create({
      provider_id: provider.id,
      model_name: 'primary',
      capability: 'chat',
      display_name: 'Primary',
    });
    const fallback = modRepo.create({
      provider_id: provider.id,
      model_name: 'fallback',
      capability: 'chat',
      display_name: 'Fallback',
    });
    // Set fallback order so primary -> fallback.
    modRepo.update(primary.id, { fallback_order: 1 });
    modRepo.update(fallback.id, { fallback_order: 2 });
    return { primaryId: primary.id, fallbackId: fallback.id };
  }

  it('forced rate_limit emits failure_decision BEFORE the 3: error frame', async () => {
    const { primaryId, fallbackId } = await seedProviderAndModels();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat',
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
        'x-test-force-classification': 'rate_limit',
      },
      payload: {
        model_id: primaryId,
        messages: [{ role: 'user', content: 'hi' }],
      },
    });
    expect(res.statusCode).toBe(200);

    const frames = parseFrames(res.payload);
    const idxDecision = frames.findIndex(
      (f) => f.tag === '8' && f.payload.includes('failure_decision'),
    );
    const idxError = frames.findIndex((f) => f.tag === '3');
    expect(idxDecision).toBeGreaterThanOrEqual(0);
    expect(idxError).toBeGreaterThan(idxDecision);

    const decision = JSON.parse(frames[idxDecision]!.payload)[0];
    expect(decision.type).toBe('failure_decision');
    expect(decision.classification).toBe('rate_limit');
    expect(decision.current_model_id).toBe(primaryId);
    expect(decision.recommended_model_id).toBe(fallbackId);
    expect(decision.auto_fallback_enabled).toBe(false);
  });

  it('content_filter forces recommended_model_id to null even when fallback exists', async () => {
    const { primaryId } = await seedProviderAndModels();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat',
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
        'x-test-force-classification': 'content_filter',
      },
      payload: {
        model_id: primaryId,
        messages: [{ role: 'user', content: 'hi' }],
      },
    });
    expect(res.statusCode).toBe(200);
    const decision = JSON.parse(
      parseFrames(res.payload).find((f) => f.tag === '8' && f.payload.includes('failure_decision'))!
        .payload,
    )[0];
    expect(decision.classification).toBe('content_filter');
    expect(decision.recommended_model_id).toBeNull();
  });

  it('auto_fallback_enabled flag reflects /v1/memories global value', async () => {
    const { primaryId } = await seedProviderAndModels();

    // Set the global preference via the memories endpoint.
    const put = await app.inject({
      method: 'PUT',
      url: '/v1/memories',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: { scope: 'global', key: 'auto_fallback_enabled', value: 'true' },
    });
    expect(put.statusCode).toBe(200);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat',
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
        'x-test-force-classification': 'quota',
      },
      payload: {
        model_id: primaryId,
        messages: [{ role: 'user', content: 'hi' }],
      },
    });
    const decision = JSON.parse(
      parseFrames(res.payload).find((f) => f.tag === '8' && f.payload.includes('failure_decision'))!
        .payload,
    )[0];
    expect(decision.auto_fallback_enabled).toBe(true);
  });

  it('content_filter does NOT increment failure_count_24h (DoD §7.4)', async () => {
    const { primaryId } = await seedProviderAndModels();
    const modRepo = new ModelsRepo(db);
    const before = modRepo.get(primaryId);
    expect(before?.failure_count_24h ?? 0).toBe(0);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat',
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
        'x-test-force-classification': 'content_filter',
      },
      payload: {
        model_id: primaryId,
        messages: [{ role: 'user', content: 'hi' }],
      },
    });
    expect(res.statusCode).toBe(200);

    const after = modRepo.get(primaryId);
    expect(after?.failure_count_24h ?? 0).toBe(0);
  });

  it('rate_limit DOES increment failure_count_24h (sanity check vs content_filter)', async () => {
    const { primaryId } = await seedProviderAndModels();
    const modRepo = new ModelsRepo(db);

    await app.inject({
      method: 'POST',
      url: '/v1/chat',
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
        'x-test-force-classification': 'rate_limit',
      },
      payload: {
        model_id: primaryId,
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    const after = modRepo.get(primaryId);
    expect(after?.failure_count_24h ?? 0).toBeGreaterThan(0);
  });
});

describe('M2.1 /v1/memories endpoint', () => {
  let app: FastifyInstance;
  let dbPath: string;

  beforeEach(async () => {
    ({ app, dbPath } = newApp());
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    fs.rmSync(dbPath, { force: true });
  });

  it('PUT then GET round-trips a global value', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/v1/memories',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: { scope: 'global', key: 'auto_fallback_enabled', value: 'true' },
    });
    expect(put.statusCode).toBe(200);

    const get = await app.inject({
      method: 'GET',
      url: '/v1/memories?scope=global&key=auto_fallback_enabled',
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(get.statusCode).toBe(200);
    expect(JSON.parse(get.payload).data.value).toBe('true');
  });

  it('session value overrides global in /v1/memories/effective', async () => {
    await app.inject({
      method: 'PUT',
      url: '/v1/memories',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: { scope: 'global', key: 'auto_fallback_enabled', value: 'false' },
    });
    await app.inject({
      method: 'PUT',
      url: '/v1/memories',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: { scope: 'session', scope_id: 'conv_test', key: 'auto_fallback_enabled', value: 'true' },
    });
    const eff = await app.inject({
      method: 'GET',
      url: '/v1/memories/effective?conversation_id=conv_test&key=auto_fallback_enabled',
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(JSON.parse(eff.payload).data.value).toBe('true');
  });

  it('rejects session scope without scope_id', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/v1/memories',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: { scope: 'session', key: 'foo', value: 'bar' },
    });
    expect(put.statusCode).toBe(400);
  });
});
