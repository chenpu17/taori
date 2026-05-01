/**
 * M3.A.1 — Topic analyzer + roundtable creation.
 *
 * Coverage:
 *   - POST /v1/roundtable with no chat models → 409 conflict
 *   - POST /v1/roundtable with chat models but no analyzer key → fallback
 *     personas, analyzer_fallback=true, status=ready, estimate populated
 *   - GET /v1/roundtable/:id round-trips persisted state
 *   - pickAnalyzerModel: pinned → cheap family → first eligible
 *   - pickFallbackParticipantModels: rotates when fewer than desired
 *   - estimateRoundtableCostRange: high = low * 1.6 for fast mode
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { openDb } from '../src/db/index.js';
import { ControlClient } from '../src/control/client.js';
import { MemoryStore } from '../src/keystore.js';
import {
  ProvidersRepo,
  ModelsRepo,
  MemoriesRepo,
  ConversationsRepo,
  MessagesRepo,
  RoundtablesRepo,
} from '../src/db/repos/index.js';
import {
  pickAnalyzerModel,
  pickFallbackParticipantModels,
} from '../src/roundtable/model-pick.js';
import { estimateRoundtableCostRange } from '../src/roundtable/cost-estimate.js';
import type { FastifyInstance } from 'fastify';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const bearer = 'test_bearer_m3a1';

interface Ctx {
  app: FastifyInstance;
  db: ReturnType<typeof openDb>;
  dbPath: string;
  providers: ProvidersRepo;
  models: ModelsRepo;
  memories: MemoriesRepo;
}

async function makeCtx(): Promise<Ctx> {
  const dbPath = path.join(
    os.tmpdir(),
    `taori-m3a1-${Date.now()}-${Math.random()}.db`,
  );
  const db = openDb(dbPath);
  const keystore = new MemoryStore();
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
    keystore,
    startedAt: Date.now(),
  });
  await app.ready();
  return {
    app,
    db,
    dbPath,
    providers: new ProvidersRepo(db),
    models: new ModelsRepo(db),
    memories: new MemoriesRepo(db),
  };
}

async function teardown(ctx: Ctx): Promise<void> {
  await ctx.app.close();
  fs.rmSync(ctx.dbPath, { force: true });
}

describe('M3.A.1 — analyzer model picker', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await makeCtx();
  });
  afterEach(async () => {
    await teardown(ctx);
  });

  it('returns null when no eligible chat model exists', () => {
    expect(pickAnalyzerModel(ctx.models, ctx.memories)).toBeNull();
  });

  it('prefers cheap-family substring (haiku/mini/flash)', () => {
    const prov = ctx.providers.create({
      name: 'P',
      type: 'openai',
      base_url: 'http://x',
      api_key: 'k',
    });
    ctx.models.create({
      provider_id: prov.id,
      model_name: 'gpt-4o',
      capability: 'chat',
      display_name: 'big',
    });
    const cheap = ctx.models.create({
      provider_id: prov.id,
      model_name: 'gpt-4o-mini',
      capability: 'chat',
      display_name: 'small',
    });
    const picked = pickAnalyzerModel(ctx.models, ctx.memories);
    expect(picked?.id).toBe(cheap.id);
  });

  it('honours pinned analyzer model from memory', () => {
    const prov = ctx.providers.create({
      name: 'P',
      type: 'openai',
      base_url: 'http://x',
      api_key: 'k',
    });
    const big = ctx.models.create({
      provider_id: prov.id,
      model_name: 'gpt-4o',
      capability: 'chat',
      display_name: 'big',
    });
    ctx.models.create({
      provider_id: prov.id,
      model_name: 'haiku',
      capability: 'chat',
      display_name: 'cheap',
    });
    ctx.memories.set('global', null, 'roundtable_analyzer_model', big.id);
    expect(pickAnalyzerModel(ctx.models, ctx.memories)?.id).toBe(big.id);
  });

  it('fallback participant picker rotates when fewer than count', () => {
    const prov = ctx.providers.create({
      name: 'P',
      type: 'openai',
      base_url: 'http://x',
      api_key: 'k',
    });
    const a = ctx.models.create({
      provider_id: prov.id,
      model_name: 'gpt-4o',
      capability: 'chat',
      display_name: 'a',
    });
    const b = ctx.models.create({
      provider_id: prov.id,
      model_name: 'gpt-4o-mini',
      capability: 'chat',
      display_name: 'b',
    });
    const picked = pickFallbackParticipantModels(ctx.models, 3);
    expect(picked.map((m) => m.id)).toEqual([a.id, b.id, a.id]);
  });
});

describe('M3.A.1 — cost estimate', () => {
  it('high = low * 1.6 for fast mode', () => {
    const m = (price: number) =>
      ({
        id: 'x',
        alias: null,
        provider_id: 'p',
        model_name: 'x',
        capability: 'chat',
        display_name: 'x',
        price_input_per_1m: price,
        price_output_per_1m: price,
        price_per_call: null,
        price_currency: 'USD',
        context_length: null,
        supports_vision: false,
        is_default_for: null,
        fallback_order: 0,
        enabled: true,
        demoted: false,
        disabled_until: null,
        created_at: 0,
        updated_at: 0,
      }) as any;
    const r = estimateRoundtableCostRange({
      mode: 'fast',
      analyzerModel: m(1),
      participantModels: [m(1), m(1), m(1)],
      summarizerModel: m(1),
      topicLength: 10,
    });
    expect(r.low).toBeGreaterThan(0);
    expect(r.high).toBeCloseTo(r.low * 1.6, 6);
  });

  it('returns 0/0 when all models are free', () => {
    const m = () =>
      ({
        price_input_per_1m: null,
        price_output_per_1m: null,
        price_per_call: null,
      }) as any;
    const r = estimateRoundtableCostRange({
      mode: 'fast',
      analyzerModel: m(),
      participantModels: [m()],
      summarizerModel: m(),
      topicLength: 10,
    });
    expect(r.low).toBe(0);
    expect(r.high).toBe(0);
  });
});

describe('M3.A.1 — POST /v1/roundtable', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await makeCtx();
  });
  afterEach(async () => {
    await teardown(ctx);
  });

  async function post(body: unknown) {
    return ctx.app.inject({
      method: 'POST',
      url: '/v1/roundtable',
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
      },
      payload: JSON.stringify(body),
    });
  }

  it('rejects when no chat models available (409 conflict)', async () => {
    const res = await post({ topic: 'test topic', mode: 'auto' });
    expect(res.statusCode).toBe(409);
    const body = res.json() as { code: string; message: string };
    expect(body.code).toBe('conflict');
    expect(body.message).toBe('no_available_chat_models');
  });

  it('uses fallback personas when analyzer has no key, persists state', async () => {
    const prov = ctx.providers.create({
      name: 'P',
      type: 'openai',
      base_url: 'http://x',
      api_key: 'placeholder',
    });
    // We never write the secret to the keystore → keystore.read returns null →
    // analyzer takes the no_key branch, route falls back to fixed personas.
    void prov;

    ctx.models.create({
      provider_id: prov.id,
      model_name: 'gpt-4o-mini',
      capability: 'chat',
      display_name: 'Mini',
      price_input_per_1m: 0.5,
      price_output_per_1m: 1.5,
    });
    ctx.models.create({
      provider_id: prov.id,
      model_name: 'gpt-4o',
      capability: 'chat',
      display_name: 'Big',
      price_input_per_1m: 5,
      price_output_per_1m: 15,
    });

    const res = await post({ topic: 'whether to migrate to postgres', mode: 'auto' });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      id: string;
      analyzer_fallback: boolean;
      status: string;
      participants: { role_label: string }[];
      mode: string;
      estimated_cost_usd_low: number | null;
    };
    expect(body.analyzer_fallback).toBe(true);
    expect(body.status).toBe('analyzing');
    expect(body.participants).toHaveLength(3);
    expect(body.mode).toBe('fast'); // 'auto' resolves to 'fast' in fallback
    expect(body.estimated_cost_usd_low).toBeGreaterThan(0);

    // P0-#3: even in no_key fallback path, an analyzer cost_record must be
    // written for audit trail (success=false, actual_cost_usd=null).
    const { cost_records } = await import('../src/db/schema.js');
    const costRows = ctx.db.select().from(cost_records).all();
    const analyzerRow = costRows.find(
      (r: any) => r.source_type === 'topic_analyzer' && r.source_id === body.id,
    );
    expect(analyzerRow).toBeDefined();
    expect((analyzerRow as any).success).toBe(false);

    // P0-#2: the auto-created conversation must be of type='roundtable'.
    const { conversations } = await import('../src/db/schema.js');
    const convRow = ctx.db
      .select()
      .from(conversations)
      .all()
      .find((c: any) => c.id === (body as any).conversation_id);
    expect(convRow).toBeDefined();
    expect((convRow as any).type).toBe('roundtable');

    // Round-trip via GET
    const getRes = await ctx.app.inject({
      method: 'GET',
      url: `/v1/roundtable/${body.id}`,
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(getRes.statusCode).toBe(200);
    const got = getRes.json() as {
      roundtable: { id: string; topic: string; analyzer_fallback: boolean };
      messages: unknown[];
    };
    expect(got.roundtable.id).toBe(body.id);
    expect(got.roundtable.topic).toBe('whether to migrate to postgres');
    expect(got.roundtable.analyzer_fallback).toBe(true);
    expect(got.messages).toEqual([]);
  });

  it('does not reuse an existing chat conversation as the roundtable conversation', async () => {
    const prov = ctx.providers.create({
      name: 'P',
      type: 'openai',
      base_url: 'http://x',
      api_key: 'k',
    });
    for (let i = 0; i < 3; i++) {
      ctx.models.create({
        provider_id: prov.id,
        model_name: `gpt-${i}`,
        capability: 'chat',
        display_name: `Chat ${i}`,
      });
    }
    const convs = new ConversationsRepo(ctx.db);
    const origin = convs.create({ type: 'chat', title: 'origin chat' });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/roundtable',
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
      },
      payload: {
        conversation_id: origin.id,
        topic: 'compare two launch plans',
        mode: 'fast',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      id: string;
      conversation_id: string;
    };
    expect(body.conversation_id).not.toBe(origin.id);
    expect(convs.get(body.conversation_id)?.type).toBe('roundtable');

    const gotRes = await ctx.app.inject({
      method: 'GET',
      url: `/v1/roundtable/${body.id}`,
      headers: { authorization: `Bearer ${bearer}` },
    });
    const got = gotRes.json() as {
      roundtable: { origin_conversation_id: string | null };
    };
    expect(got.roundtable.origin_conversation_id).toBe(origin.id);
  });

  it('roundtable loopback is idempotent per roundtable id', async () => {
    const convs = new ConversationsRepo(ctx.db);
    const roundtables = new RoundtablesRepo(ctx.db);
    const messages = new MessagesRepo(ctx.db);
    const origin = convs.create({ type: 'chat', title: 'origin chat' });
    const rtConv = convs.create({ type: 'roundtable', title: 'rt' });
    const rt = roundtables.insert({
      id: 'rt_loopback_once',
      conversation_id: rtConv.id,
      topic: '产品路线选择',
      mode: 'fast',
      participants: [],
      summarizer_model_id: null,
      origin_conversation_id: origin.id,
      analyzer_fallback: false,
      status: 'analyzing',
      estimated_cost_usd_low: null,
      estimated_cost_usd_high: null,
    });
    roundtables.setSummary(rt.id, {
      consensus: ['先做核心路径'],
      divergence: [],
      risks: [],
      recommended_decision: '选择小范围灰度。',
      next_steps: ['补齐验证指标'],
    });
    roundtables.setStatus(rt.id, 'completed');

    const first = await ctx.app.inject({
      method: 'POST',
      url: `/v1/roundtable/${rt.id}/loopback`,
      headers: { authorization: `Bearer ${bearer}` },
    });
    const second = await ctx.app.inject({
      method: 'POST',
      url: `/v1/roundtable/${rt.id}/loopback`,
      headers: { authorization: `Bearer ${bearer}` },
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.json()).toEqual(second.json());
    const rows = messages.listByConversation(origin.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.id).toBe('message_roundtable_topic_rt_loopback_once');
    expect(rows[0]!.role).toBe('user');
    expect(rows[0]!.content).toContain('发起圆桌讨论：产品路线选择');
    expect(rows[1]!.id).toBe('message_roundtable_loopback_rt_loopback_once');
    expect(rows[1]!.content).toContain('来自圆桌讨论');
  });

  it('GET unknown id → 404', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/roundtable/rt_doesnotexist',
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
