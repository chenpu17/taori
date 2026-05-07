import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { openDb } from '../src/db/index.js';
import { ControlClient } from '../src/control/client.js';
import { MemoryStore } from '../src/keystore.js';
import { CostsRepo, ProvidersRepo, ModelsRepo, MessagesRepo, MemoriesRepo } from '../src/db/repos/index.js';
import type { FastifyInstance } from 'fastify';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const bearer = 'test_bearer_costs';

describe('costs M1.3', () => {
  let app: FastifyInstance;
  let dbPath: string;
  let db: ReturnType<typeof openDb>;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `taori-costs-${Date.now()}-${Math.random()}.db`);
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

  it('GET /v1/costs/realtime returns zeros on a clean db', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/costs/realtime',
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.current_conversation_usd).toBe(0);
    expect(body.data.today_usd).toBe(0);
    expect(body.data.month_usd).toBe(0);
    expect(body.data.currency_display).toBe('USD');
  });

  it('chat → cost record written with calculated actual_cost_usd', async () => {
    // Seed a model with prices but NO api_key → mock path. Mock path emits a
    // cost annotation with input=12, output=text.length (M0 fallback values).
    const provider = new ProvidersRepo(db).create({
      name: 'Mock',
      type: 'openrouter',
      base_url: 'https://example.invalid',
      api_key: null,
    });
    const model = new ModelsRepo(db).create({
      provider_id: provider.id,
      model_name: 'mock-model',
      capability: 'chat',
      display_name: 'Mock',
      price_input_per_1m: 1.0, // $1 / 1M
      price_output_per_1m: 2.0,
    });

    const chatRes = await app.inject({
      method: 'POST',
      url: '/v1/chat',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: { model_id: model.id, messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(chatRes.statusCode).toBe(200);

    // Wait a tick for the stream-end handler to fire.
    await new Promise((r) => setImmediate(r));

    const meta = JSON.parse(chatRes.payload.split('\n').find((l) => l.startsWith('8:'))!.slice(2))[0];
    const costsRepo = new CostsRepo(db);
    const cost = costsRepo.forMessage(meta.message_id);
    expect(cost).toBeTruthy();
    expect(cost!.success).toBe(true);
    expect(cost!.feature).toBe('chat');
    expect(cost!.source_type).toBe('message');
    expect(cost!.source_id).toBe(meta.message_id);
    expect(cost!.model_id).toBe(model.id);
    expect(cost!.model_name_snapshot).toBe('mock-model');
    expect(cost!.actual_cost_usd).toBeGreaterThan(0);
    // input=12, output=mock text length. Cost = 12*1/1M + len*2/1M.
    // We just check it's < $0.001 (sanity).
    expect(cost!.actual_cost_usd).toBeLessThan(0.001);

    // realtime endpoint reflects it
    const rt = await app.inject({
      method: 'GET',
      url: `/v1/costs/realtime?conversation_id=${meta.conversation_id}`,
      headers: { authorization: `Bearer ${bearer}` },
    });
    const rtBody = rt.json();
    expect(rtBody.data.current_conversation_calls).toBe(1);
    expect(rtBody.data.current_conversation_usd).toBeGreaterThan(0);
    expect(rtBody.data.today_usd).toBeGreaterThan(0);

    const logs = await app.inject({
      method: 'GET',
      url: '/v1/costs/calls?limit=10',
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(logs.statusCode).toBe(200);
    const logsBody = logs.json() as {
      data: {
        rows: Array<{
          id: string;
          model_id: string | null;
          model_name_snapshot: string;
          provider_name: string | null;
          source_type: string;
          run_id: string | null;
          run_event_id: string | null;
          run_event_kind: string | null;
          run_event_label: string | null;
        }>;
      };
    };
    expect(logsBody.data.rows[0]?.model_id).toBe(model.id);
    expect(logsBody.data.rows[0]?.model_name_snapshot).toBe('mock-model');
    expect(logsBody.data.rows[0]?.provider_name).toBe('Mock');
    expect(logsBody.data.rows[0]?.source_type).toBe('message');
    expect(logsBody.data.rows[0]?.id).toBe(cost!.id);
    expect(logsBody.data.rows[0]?.run_id).toMatch(/^run_/);
    expect(logsBody.data.rows[0]?.run_event_id).toMatch(/^runev_/);
    expect(logsBody.data.rows[0]?.run_event_kind).toBe('cost.recorded');
    expect(logsBody.data.rows[0]?.run_event_label).toBe('成本记录');

    const focusedLogs = await app.inject({
      method: 'GET',
      url: `/v1/costs/calls?limit=10&cost_record_id=${cost!.id}`,
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(focusedLogs.statusCode).toBe(200);
    const focusedLogsBody = focusedLogs.json() as typeof logsBody;
    expect(focusedLogsBody.data.rows).toHaveLength(1);
    expect(focusedLogsBody.data.rows[0]?.id).toBe(cost!.id);
    expect(focusedLogsBody.data.rows[0]?.run_event_id).toMatch(/^runev_/);

    const events = await app.inject({
      method: 'GET',
      url: `/v1/conversations/${meta.conversation_id}/run-events`,
      headers: { authorization: `Bearer ${bearer}` },
    });
    const eventsBody = events.json() as {
      data: { events: Array<{ id: string; kind: string; payload: Record<string, unknown> | null }> };
    };
    const costEvent = eventsBody.data.events.find((event) => event.kind === 'cost.recorded');
    expect(costEvent?.payload?.cost_record_id).toBe(cost!.id);
  });

  it('POST /v1/chat blocks when hard monthly budget would be exceeded', async () => {
    const provider = new ProvidersRepo(db).create({
      name: 'Hard Budget',
      type: 'openrouter',
      base_url: 'https://example.invalid',
      api_key: null,
    });
    const model = new ModelsRepo(db).create({
      provider_id: provider.id,
      model_name: 'hard-budget-model',
      capability: 'chat',
      display_name: 'Hard Budget Model',
      price_per_call: 0.02,
    });
    const memories = new MemoriesRepo(db);
    memories.set('global', null, 'monthly_budget_usd', '0.01');
    memories.set('global', null, 'monthly_budget_hard_limit', 'true');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: { model_id: model.id, messages: [{ role: 'user', content: 'hi' }] },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json() as {
      code: string;
      details: { reason: string; blocked: boolean; hard_limit: boolean };
    };
    expect(body.code).toBe('cost_confirmation_required');
    expect(body.details.reason).toBe('budget');
    expect(body.details.blocked).toBe(true);
    expect(body.details.hard_limit).toBe(true);
  });

  it('POST /v1/roundtable blocks analyzer when hard monthly budget would be exceeded', async () => {
    const provider = new ProvidersRepo(db).create({
      name: 'Hard Budget Roundtable',
      type: 'openrouter',
      base_url: 'https://example.invalid',
      api_key: null,
    });
    new ModelsRepo(db).create({
      provider_id: provider.id,
      model_name: 'hard-budget-roundtable-model',
      capability: 'chat',
      display_name: 'Hard Budget Roundtable Model',
      price_per_call: 0.02,
      is_default_for: 'chat',
    });
    const memories = new MemoriesRepo(db);
    memories.set('global', null, 'monthly_budget_usd', '0.01');
    memories.set('global', null, 'monthly_budget_hard_limit', 'true');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/roundtable',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: { topic: 'Should we migrate the database?', mode: 'fast' },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json() as {
      code: string;
      details: { reason: string; blocked: boolean; hard_limit: boolean };
    };
    expect(body.code).toBe('cost_confirmation_required');
    expect(body.details.reason).toBe('budget');
    expect(body.details.blocked).toBe(true);
    expect(body.details.hard_limit).toBe(true);
  });
});
