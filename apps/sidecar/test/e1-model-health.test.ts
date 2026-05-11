import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { buildServer } from '../src/server.js';
import { openDb } from '../src/db/index.js';
import { ControlClient } from '../src/control/client.js';
import { MemoryStore } from '../src/keystore.js';
import { ConversationsRepo, CostsRepo, ModelsRepo, ProvidersRepo } from '../src/db/repos/index.js';
import { cost_records } from '../src/db/schema.js';

const bearer = 'test_bearer_e1';
const auth = { authorization: `Bearer ${bearer}` };

describe('E1 model health', () => {
  let app: FastifyInstance;
  let dbPath: string;
  let db: ReturnType<typeof openDb>;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `taori-e1-${Date.now()}-${Math.random()}.db`);
    db = openDb(dbPath);
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
  });

  it('GET /v1/models/health returns 24h aggregates plus zero rows for untouched models', async () => {
    const provider = new ProvidersRepo(db).create({
      name: 'Provider',
      type: 'openrouter',
      base_url: 'https://example.invalid/v1',
      api_key: null,
    });
    const models = new ModelsRepo(db);
    const alpha = models.create({
      provider_id: provider.id,
      model_name: 'alpha',
      capability: 'chat',
      display_name: 'Alpha',
    });
    const beta = models.create({
      provider_id: provider.id,
      model_name: 'beta',
      capability: 'chat',
      display_name: 'Beta',
    });
    const conv = new ConversationsRepo(db).create({ title: 'health' });
    const costs = new CostsRepo(db);

    const success = costs.insert({
      conversation_id: conv.id,
      source_type: 'message',
      source_id: 'msg_success',
      feature: 'chat',
      model_id: alpha.id,
      model_name_snapshot: alpha.display_name,
      input_tokens: 10,
      output_tokens: 20,
      price_input_per_1m_snapshot: 1,
      price_output_per_1m_snapshot: 2,
      price_per_call_snapshot: null,
      estimated_cost_usd: null,
      actual_cost_usd: 0.01,
      success: true,
      first_token_ms: 120,
      duration_ms: 900,
    });
    const failure = costs.insert({
      conversation_id: conv.id,
      source_type: 'message',
      source_id: 'msg_failure',
      feature: 'chat',
      model_id: alpha.id,
      model_name_snapshot: alpha.display_name,
      input_tokens: 8,
      output_tokens: 0,
      price_input_per_1m_snapshot: 1,
      price_output_per_1m_snapshot: 2,
      price_per_call_snapshot: null,
      estimated_cost_usd: null,
      actual_cost_usd: null,
      success: false,
      classification: 'rate_limit',
      first_token_ms: 300,
      duration_ms: 1_500,
    });
    const stale = costs.insert({
      conversation_id: conv.id,
      source_type: 'message',
      source_id: 'msg_stale',
      feature: 'chat',
      model_id: alpha.id,
      model_name_snapshot: alpha.display_name,
      input_tokens: 5,
      output_tokens: 5,
      price_input_per_1m_snapshot: 1,
      price_output_per_1m_snapshot: 2,
      price_per_call_snapshot: null,
      estimated_cost_usd: null,
      actual_cost_usd: 0.005,
      success: true,
      first_token_ms: 999,
      duration_ms: 2_000,
    });

    const now = Date.now();
    db.update(cost_records)
      .set({ created_at: now - 2 * 60 * 60 * 1000 })
      .where(eq(cost_records.id, success.id))
      .run();
    db.update(cost_records)
      .set({ created_at: now - 30 * 60 * 1000 })
      .where(eq(cost_records.id, failure.id))
      .run();
    db.update(cost_records)
      .set({ created_at: now - 26 * 60 * 60 * 1000 })
      .where(eq(cost_records.id, stale.id))
      .run();

    const res = await app.inject({
      method: 'GET',
      url: '/v1/models/health',
      headers: auth,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      rows: Array<{
        model_id: string;
        calls_24h: number;
        failures_24h: number;
        avg_first_token_ms: number | null;
        avg_duration_ms: number | null;
        last_failure_at: number | null;
        last_failure_classification: string | null;
        failure_distribution_24h: Array<{ classification: string; failures: number }>;
        failure_trend_24h: Array<{
          bucket_start: number;
          label: string;
          failures: number;
          classifications: Array<{ classification: string; failures: number }>;
        }>;
      }>;
    };

    const alphaRow = body.rows.find((row) => row.model_id === alpha.id);
    expect(alphaRow).toBeTruthy();
    expect(alphaRow).toMatchObject({
      model_id: alpha.id,
      calls_24h: 2,
      failures_24h: 1,
      last_failure_classification: 'rate_limit',
    });
    expect(alphaRow?.failure_distribution_24h).toEqual([
      { classification: 'rate_limit', failures: 1 },
    ]);
    expect(alphaRow?.avg_first_token_ms).toBe(210);
    expect(alphaRow?.avg_duration_ms).toBe(1_200);
    expect(alphaRow?.last_failure_at).toBe(now - 30 * 60 * 1000);
    expect(alphaRow?.failure_trend_24h.some((bucket) => bucket.failures === 1)).toBe(true);

    const betaRow = body.rows.find((row) => row.model_id === beta.id);
    expect(betaRow).toEqual({
      model_id: beta.id,
      calls_24h: 0,
      failures_24h: 0,
      avg_first_token_ms: null,
      avg_duration_ms: null,
      last_failure_at: null,
      last_failure_classification: null,
      failure_distribution_24h: [],
      failure_trend_24h: [],
    });
  });

  it('POST /v1/models/recommendations ranks by task, price and health with explanations', async () => {
    const provider = new ProvidersRepo(db).create({
      name: 'Provider',
      type: 'openrouter',
      base_url: 'https://example.invalid/v1',
      api_key: null,
    });
    const models = new ModelsRepo(db);
    const cheap = models.create({
      provider_id: provider.id,
      model_name: 'cheap',
      capability: 'chat',
      display_name: 'Cheap',
      price_input_per_1m: 0.1,
      price_output_per_1m: 0.2,
    });
    const coder = models.create({
      provider_id: provider.id,
      model_name: 'coder',
      capability: 'chat',
      display_name: 'Coder',
      price_input_per_1m: 2,
      price_output_per_1m: 4,
      supports_tools: true,
      supports_json: true,
      context_length: 128_000,
    });
    const flaky = models.create({
      provider_id: provider.id,
      model_name: 'flaky',
      capability: 'chat',
      display_name: 'Flaky',
      price_input_per_1m: 0.01,
      price_output_per_1m: 0.02,
    });
    const conv = new ConversationsRepo(db).create({ title: 'recommend' });
    const costs = new CostsRepo(db);
    costs.insert({
      conversation_id: conv.id,
      source_type: 'message',
      source_id: 'ok',
      feature: 'chat',
      model_id: coder.id,
      model_name_snapshot: coder.display_name,
      input_tokens: 10,
      output_tokens: 20,
      price_input_per_1m_snapshot: 2,
      price_output_per_1m_snapshot: 4,
      price_per_call_snapshot: null,
      estimated_cost_usd: null,
      actual_cost_usd: 0.01,
      success: true,
      first_token_ms: 900,
      duration_ms: 2_000,
    });
    costs.insert({
      conversation_id: conv.id,
      source_type: 'message',
      source_id: 'bad',
      feature: 'chat',
      model_id: flaky.id,
      model_name_snapshot: flaky.display_name,
      input_tokens: 10,
      output_tokens: 0,
      price_input_per_1m_snapshot: 0.01,
      price_output_per_1m_snapshot: 0.02,
      price_per_call_snapshot: null,
      estimated_cost_usd: null,
      actual_cost_usd: null,
      success: false,
      classification: 'rate_limit',
      first_token_ms: 500,
      duration_ms: 600,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/models/recommendations',
      headers: auth,
      payload: { capability: 'chat', task: 'coding', limit: 3 },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      recommended_model_id: string | null;
      recommendations: Array<{ model_id: string; score: number; reasons: string[]; tradeoffs: string[] }>;
    };
    expect(body.recommended_model_id).toBe(coder.id);
    expect(body.recommendations.map((item) => item.model_id)).toContain(cheap.id);
    expect(body.recommendations[0]?.reasons.join(' ')).toContain('工具');
    expect(body.recommendations.find((item) => item.model_id === flaky.id)?.tradeoffs.join(' ')).toContain('失败率');
  });
});
