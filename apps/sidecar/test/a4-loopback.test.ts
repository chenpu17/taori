/**
 * A4 — POST /v1/roundtable/:id/loopback — write summary back into the
 * original chat conversation as an assistant message.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildServer } from '../src/server.js';
import { openDb } from '../src/db/index.js';
import { ControlClient } from '../src/control/client.js';
import { MemoryStore } from '../src/keystore.js';
import {
  ProvidersRepo,
  ModelsRepo,
  ConversationsRepo,
  MessagesRepo,
  RoundtablesRepo,
} from '../src/db/repos/index.js';
import type { FastifyInstance } from 'fastify';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const bearer = 'test_bearer_a4';

interface Ctx {
  app: FastifyInstance;
  db: ReturnType<typeof openDb>;
  dbPath: string;
  providers: ProvidersRepo;
  models: ModelsRepo;
  convs: ConversationsRepo;
  msgs: MessagesRepo;
  rt: RoundtablesRepo;
  keystore: MemoryStore;
}

async function makeCtx(): Promise<Ctx> {
  const dbPath = path.join(
    os.tmpdir(),
    `taori-a4-${Date.now()}-${Math.random()}.db`,
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
    convs: new ConversationsRepo(db),
    msgs: new MessagesRepo(db),
    rt: new RoundtablesRepo(db),
    keystore,
  };
}

async function teardown(ctx: Ctx): Promise<void> {
  await ctx.app.close();
  fs.rmSync(ctx.dbPath, { force: true });
}

async function seedCompletedRoundtable(
  ctx: Ctx,
  opts: { withOrigin: boolean },
): Promise<{ id: string; originId: string | null; rtConvId: string }> {
  const prov = ctx.providers.create({
    name: 'P',
    type: 'openai',
    base_url: 'https://api.example.com/v1',
    api_key: 'sk-test',
  });
  await ctx.keystore.write(prov.api_key_ref!, 'sk-test');
  const m = ctx.models.create({
    provider_id: prov.id,
    model_name: 'm0',
    capability: 'chat',
    display_name: 'M0',
    price_input_per_1m: 1,
    price_output_per_1m: 2,
  });
  const origin = opts.withOrigin
    ? ctx.convs.create({ type: 'chat', title: '原对话' })
    : null;
  const rtConv = ctx.convs.create({ type: 'roundtable' });
  const inserted = ctx.rt.insert({
    conversation_id: rtConv.id,
    topic: '选 ORM',
    mode: 'fast',
    participants: [
      {
        model_id: m.id,
        display_name: 'M0',
        role_label: '综合',
        persona_prompt: 'persona persona persona',
      },
      {
        model_id: m.id,
        display_name: 'M0',
        role_label: '批判',
        persona_prompt: 'persona persona persona',
      },
    ],
    summarizer_model_id: m.id,
    origin_conversation_id: origin?.id ?? null,
    analyzer_fallback: true,
    status: 'analyzing',
    current_round: 0,
    estimated_cost_usd_low: 0.01,
    estimated_cost_usd_high: 0.02,
  });
  ctx.rt.setSummary(inserted.id, {
    consensus: ['用 prisma'],
    divergence: [
      {
        topic: '迁移工具',
        positions: [
          { role: '综合', stance: '用 prisma migrate' },
          { role: '批判', stance: '用 atlas' },
        ],
      },
    ],
    risks: ['学习曲线'],
    recommended_decision: 'prisma + atlas 结合',
    next_steps: ['写 PoC', '出 PRD'],
  });
  ctx.rt.setStatus(inserted.id, 'completed');
  return {
    id: inserted.id,
    originId: origin?.id ?? null,
    rtConvId: rtConv.id,
  };
}

describe('A4 — POST /v1/roundtable/:id/loopback', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await makeCtx();
  });
  afterEach(async () => {
    await teardown(ctx);
    vi.restoreAllMocks();
  });

  it('writes the summary into the origin chat conversation', async () => {
    const { id, originId } = await seedCompletedRoundtable(ctx, {
      withOrigin: true,
    });
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/roundtable/${id}/loopback`,
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { conversation_id: string; message_id: string };
    expect(body.conversation_id).toBe(originId);
    const written = ctx.msgs.listByConversation(body.conversation_id);
    expect(written).toHaveLength(2);
    expect(written[0]!.role).toBe('user');
    expect(written[0]!.content).toContain('发起圆桌讨论：选 ORM');
    expect(written[1]!.role).toBe('assistant');
    expect(written[1]!.content).toContain('🎯 推荐决策');
    expect(written[1]!.content).toContain('prisma + atlas');
    expect(written[1]!.content).toContain('来自圆桌讨论');
  });

  it('mints a fresh chat conversation when origin is null', async () => {
    const { id, rtConvId } = await seedCompletedRoundtable(ctx, {
      withOrigin: false,
    });
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/roundtable/${id}/loopback`,
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { conversation_id: string };
    expect(body.conversation_id).not.toBe(rtConvId);
    const created = ctx.convs.get(body.conversation_id);
    expect(created?.type).toBe('chat');
    expect(created?.title).toContain('圆桌结论');
    const written = ctx.msgs.listByConversation(body.conversation_id);
    expect(written.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(written[0]!.content).toContain('发起圆桌讨论：选 ORM');
  });

  it('rejects when the roundtable is not completed', async () => {
    const { id } = await seedCompletedRoundtable(ctx, { withOrigin: true });
    ctx.rt.setStatus(id, 'round1');
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/roundtable/${id}/loopback`,
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('conflict');
  });

  it('rejects when there is no summary', async () => {
    const prov = ctx.providers.create({
      name: 'P',
      type: 'openai',
      base_url: 'https://api.example.com/v1',
      api_key: 'sk-test',
    });
    const m = ctx.models.create({
      provider_id: prov.id,
      model_name: 'mm',
      capability: 'chat',
      display_name: 'MM',
      price_input_per_1m: 1,
      price_output_per_1m: 2,
    });
    const conv = ctx.convs.create({ type: 'roundtable' });
    const inserted = ctx.rt.insert({
      conversation_id: conv.id,
      topic: 't',
      mode: 'fast',
      participants: [
        {
          model_id: m.id,
          display_name: 'MM',
          role_label: 'a',
          persona_prompt: 'persona persona',
        },
        {
          model_id: m.id,
          display_name: 'MM',
          role_label: 'b',
          persona_prompt: 'persona persona',
        },
      ],
      summarizer_model_id: m.id,
      analyzer_fallback: true,
      status: 'analyzing',
      current_round: 0,
      estimated_cost_usd_low: 0,
      estimated_cost_usd_high: 0,
    });
    ctx.rt.setStatus(inserted.id, 'completed');
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/roundtable/${inserted.id}/loopback`,
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('conflict');
  });
});
