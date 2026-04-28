/**
 * M2.2 — cost transparency L3 (stream badge) + L4 (confirm + session panel).
 *
 * Sidecar surface area:
 *   - GET /v1/costs/breakdown?scope={session|today|month} — per-(model, feature)
 *     aggregation for the session-cost panel (§3.3).
 *   - ModelsRepo.pickCheapestActive(capability, excludeId) — used by the
 *     confirm modal's "改用低成本模型" button (§3.2).
 *   - cost_confirm_* memories rely on the existing /v1/memories surface
 *     (covered by m2-1 tests) — no new endpoint required.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { openDb } from '../src/db/index.js';
import { ControlClient } from '../src/control/client.js';
import { MemoryStore } from '../src/keystore.js';
import {
  CostsRepo,
  ProvidersRepo,
  ModelsRepo,
} from '../src/db/repos/index.js';
import type { FastifyInstance } from 'fastify';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const bearer = 'test_bearer_m22';

describe('M2.2 cost L3+L4', () => {
  let app: FastifyInstance;
  let dbPath: string;
  let db: ReturnType<typeof openDb>;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `taori-m22-${Date.now()}-${Math.random()}.db`);
    db = openDb(dbPath);
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

  it('pickCheapestActive: orders by COALESCE(price_per_call, price_input_per_1m)', () => {
    const pr = new ProvidersRepo(db).create({
      name: 'P', type: 'openrouter', base_url: 'https://example.invalid', api_key: null,
    });
    const mr = new ModelsRepo(db);
    const expensive = mr.create({
      provider_id: pr.id, model_name: 'gpt-expensive', capability: 'chat',
      display_name: 'Expensive', price_input_per_1m: 10,
    });
    const cheap = mr.create({
      provider_id: pr.id, model_name: 'gpt-cheap', capability: 'chat',
      display_name: 'Cheap', price_input_per_1m: 0.5,
    });
    const flat = mr.create({
      provider_id: pr.id, model_name: 'flat-rate', capability: 'chat',
      display_name: 'Flat', price_per_call: 0.01, // way more expensive than cheap (sorted by USD/call vs USD/1m)
    });
    // pickCheapestActive: COALESCE(price_per_call, price_input_per_1m) so:
    //   cheap = 0.5, expensive = 10, flat = 0.01 → flat < cheap < expensive.
    const out = mr.pickCheapestActive('chat', expensive.id);
    expect(out?.id).toBe(flat.id);
    const out2 = mr.pickCheapestActive('chat', flat.id);
    expect(out2?.id).toBe(cheap.id);
  });

  it('pickCheapestActive: skips disabled / demoted / different-capability', () => {
    const pr = new ProvidersRepo(db).create({
      name: 'P', type: 'openrouter', base_url: 'https://example.invalid', api_key: null,
    });
    const mr = new ModelsRepo(db);
    const a = mr.create({ provider_id: pr.id, model_name: 'a', capability: 'chat', display_name: 'A', price_input_per_1m: 1 });
    const b = mr.create({ provider_id: pr.id, model_name: 'b', capability: 'chat', display_name: 'B', price_input_per_1m: 2 });
    const c = mr.create({ provider_id: pr.id, model_name: 'c', capability: 'image', display_name: 'C', price_input_per_1m: 0.1 });
    mr.update(b.id, { enabled: false });
    const r = mr.pickCheapestActive('chat', a.id);
    expect(r).toBeNull();
    expect(c).toBeTruthy();
  });

  it('GET /v1/costs/breakdown?scope=session aggregates by (model, feature)', async () => {
    const pr = new ProvidersRepo(db).create({
      name: 'P', type: 'openrouter', base_url: 'https://example.invalid', api_key: null,
    });
    const m = new ModelsRepo(db).create({
      provider_id: pr.id, model_name: 'mock', capability: 'chat', display_name: 'M',
      price_input_per_1m: 1, price_output_per_1m: 2,
    });
    // Send 3 mock chat calls in the same conversation.
    let convId: string | null = null;
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat',
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
        payload: {
          model_id: m.id,
          conversation_id: convId ?? undefined,
          messages: [{ role: 'user', content: `msg-${i}` }],
        },
      });
      expect(res.statusCode).toBe(200);
      await new Promise((r) => setImmediate(r));
      const meta = JSON.parse(res.payload.split('\n').find((l) => l.startsWith('8:'))!.slice(2))[0];
      convId = meta.conversation_id;
    }
    const r = await app.inject({
      method: 'GET',
      url: `/v1/costs/breakdown?scope=session&conversation_id=${convId}`,
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.ok).toBe(true);
    expect(body.data.scope).toBe('session');
    expect(Array.isArray(body.data.rows)).toBe(true);
    // One row: (mock, chat). Aggregated.
    const row = body.data.rows.find((x: { model_id: string; feature: string }) => x.feature === 'chat');
    expect(row).toBeTruthy();
    expect(row.count).toBe(3);
    expect(row.success_count).toBe(3);
    expect(row.billed_failure_count).toBe(0);
    expect(row.sum_usd).toBeGreaterThan(0);
  });

  it('GET /v1/costs/breakdown?scope=today returns all rows; session=null returns []', async () => {
    const pr = new ProvidersRepo(db).create({
      name: 'P', type: 'openrouter', base_url: 'https://example.invalid', api_key: null,
    });
    const m = new ModelsRepo(db).create({
      provider_id: pr.id, model_name: 'mock', capability: 'chat', display_name: 'M', price_input_per_1m: 1,
    });
    await app.inject({
      method: 'POST', url: '/v1/chat',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: { model_id: m.id, messages: [{ role: 'user', content: 'hi' }] },
    });
    await new Promise((r) => setImmediate(r));

    const today = await app.inject({
      method: 'GET', url: '/v1/costs/breakdown?scope=today',
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(today.json().data.rows.length).toBeGreaterThan(0);

    // session without conversation_id → empty rows
    const session = await app.inject({
      method: 'GET', url: '/v1/costs/breakdown?scope=session',
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(session.json().data.rows).toEqual([]);
  });

  it('breakdown rejects invalid scope', async () => {
    const r = await app.inject({
      method: 'GET', url: '/v1/costs/breakdown?scope=year',
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(r.statusCode).toBe(400);
  });
});
