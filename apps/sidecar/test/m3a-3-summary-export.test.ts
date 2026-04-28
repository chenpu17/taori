/**
 * M3.A.3 — Summarizer (POST /v1/roundtable/:id/summarize) + export markdown.
 *
 * Coverage:
 *   - happy path: POST /summarize streams rt.summary_delta + rt.summary_done,
 *     persists summary, status='completed', writes 1 cost record source_type='summarizer'
 *   - retry path: 1st attempt returns invalid JSON → 2 fetches; 2nd succeeds →
 *     summary_done emitted; 2 cost rows
 *   - both fail: emits rt.summary_failed with fallback_text; status reverts to round1
 *   - precondition errors: 404 on missing id; 409 on completed status; 409 on
 *     status='analyzing'
 *   - fast-mode auto-chain: POST /round in fast mode emits round_done THEN
 *     summary_* in same SSE stream; status='completed'
 *   - GET /export returns text/markdown with all sections; reflects deep mode round 2
 *   - GET /export when summary.fallback=true uses fallback section
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
  RoundtablesRepo,
  RoundtableMessagesRepo,
  CostsRepo,
} from '../src/db/repos/index.js';
import type { FastifyInstance } from 'fastify';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const bearer = 'test_bearer_m3a3';

interface Ctx {
  app: FastifyInstance;
  db: ReturnType<typeof openDb>;
  dbPath: string;
  providers: ProvidersRepo;
  models: ModelsRepo;
  rt: RoundtablesRepo;
  rtMsg: RoundtableMessagesRepo;
  costs: CostsRepo;
  conv: ConversationsRepo;
  keystore: MemoryStore;
}

async function makeCtx(): Promise<Ctx> {
  const dbPath = path.join(
    os.tmpdir(),
    `taori-m3a3-${Date.now()}-${Math.random()}.db`,
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
    rt: new RoundtablesRepo(db),
    rtMsg: new RoundtableMessagesRepo(db),
    costs: new CostsRepo(db),
    conv: new ConversationsRepo(db),
    keystore,
  };
}

async function teardown(ctx: Ctx): Promise<void> {
  await ctx.app.close();
  fs.rmSync(ctx.dbPath, { force: true });
}

function makeSseStream(chunks: string[], finishReason = 'stop'): string {
  const head = chunks
    .map(
      (c, i) =>
        `data: ${JSON.stringify({
          id: String(i),
          object: 'chat.completion.chunk',
          created: 1,
          model: 'm',
          choices: [
            {
              index: 0,
              delta:
                i === 0 ? { role: 'assistant', content: c } : { content: c },
              finish_reason: null,
            },
          ],
        })}\n\n`,
    )
    .join('');
  const tail =
    `data: ${JSON.stringify({
      id: 'final',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'm',
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })}\n\n` + `data: [DONE]\n\n`;
  return head + tail;
}

const VALID_SUMMARY_JSON = {
  consensus: ['共识 A', '共识 B'],
  divergence: [
    {
      topic: '是否使用 postgres',
      positions: [
        { role: '综合视角', stance: '推荐' },
        { role: '批判视角', stance: '风险大' },
      ],
    },
  ],
  risks: ['团队学习曲线'],
  recommended_decision: '在 staging 先试用一周，再决定生产采用',
  next_steps: ['搭建 staging', '数据迁移演练'],
};

interface SeedOpts {
  count?: number;
  mode?: 'fast' | 'deep';
  /** Pre-populate roundtable_messages so /summarize has content. */
  seedMessages?: boolean;
  status?: 'round1' | 'round2' | 'completed' | 'failed' | 'analyzing';
  summary?: unknown;
}

async function seed(ctx: Ctx, opts: SeedOpts = {}): Promise<{
  id: string;
  modelIds: string[];
  conversationId: string;
}> {
  const count = opts.count ?? 3;
  const mode = opts.mode ?? 'deep';

  const prov = ctx.providers.create({
    name: 'P',
    type: 'openai',
    base_url: 'https://api.example.com/v1',
    api_key: 'sk-test',
  });
  await ctx.keystore.write(prov.api_key_ref!, 'sk-test');

  const modelIds: string[] = [];
  for (let i = 0; i < count; i++) {
    const m = ctx.models.create({
      provider_id: prov.id,
      model_name: `m${i}`,
      capability: 'chat',
      display_name: `M${i}`,
      price_input_per_1m: 1,
      price_output_per_1m: 2,
    });
    modelIds.push(m.id);
  }

  const rolesPool = ['综合视角', '批判视角', '实践视角'];
  const personasPool = [
    'You analyse holistically.',
    'You point out risks.',
    'You focus on execution.',
  ];
  const participants = modelIds.map((mid, i) => ({
    model_id: mid,
    role_label: rolesPool[i % rolesPool.length]!,
    persona_prompt: personasPool[i % personasPool.length]!,
    display_name: `M${i}`,
  }));
  const conversationId = ctx.conv.ensure(undefined, { type: 'roundtable' }).id;
  const inserted = ctx.rt.insert({
    conversation_id: conversationId,
    topic: 'should we use postgres',
    mode,
    participants,
    summarizer_model_id: modelIds[0]!,
    analyzer_fallback: true,
    status: opts.status ?? 'round1',
    current_round: opts.status === 'analyzing' ? 0 : 1,
    estimated_cost_usd_low: 0.01,
    estimated_cost_usd_high: 0.02,
  });

  if (opts.seedMessages) {
    for (let i = 0; i < count; i++) {
      const row = ctx.rtMsg.insert({
        roundtable_id: inserted.id,
        round: 1,
        participant_index: i,
        model_id: modelIds[i]!,
        status: 'pending',
        visible_to_others: true,
      });
      ctx.rtMsg.update(row.id, {
        status: 'complete',
        content: `第${i + 1}位发言：选 postgres 因为 ${i}`,
      });
    }
  }
  if (opts.summary !== undefined) {
    ctx.rt.setSummary(inserted.id, opts.summary as never);
  }

  return { id: inserted.id, modelIds, conversationId };
}

describe('M3.A.3 — POST /v1/roundtable/:id/summarize', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await makeCtx();
  });
  afterEach(async () => {
    await teardown(ctx);
    vi.restoreAllMocks();
  });

  it('happy path: persists summary, status=completed, writes summarizer cost', async () => {
    const { id } = await seed(ctx, { seedMessages: true });

    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(makeSseStream([JSON.stringify(VALID_SUMMARY_JSON)]), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    );

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/roundtable/${id}/summarize`,
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('"rt.summary_delta"');
    expect(res.payload).toContain('"rt.summary_done"');
    expect(res.payload).not.toContain('"rt.summary_failed"');

    const fresh = ctx.rt.get(id)!;
    expect(fresh.status).toBe('completed');
    expect(fresh.summary).toMatchObject({
      consensus: ['共识 A', '共识 B'],
      recommended_decision: expect.any(String),
    });

    const sumCosts = ctx.costs
      .listForRoundtable({
        conversationId: fresh.conversation_id,
        roundtableId: id,
        messageIds: ctx.rtMsg.listByRoundtable(id).map((m) => m.id),
      })
      .filter((c) => c.source_type === 'summarizer');
    expect(sumCosts).toHaveLength(1);
    expect(sumCosts[0]!.success).toBe(true);
    expect(sumCosts[0]!.actual_cost_usd).toBeGreaterThan(0);
  });

  it('retry path: 1st attempt invalid JSON → 2nd attempt succeeds', async () => {
    const { id } = await seed(ctx, { seedMessages: true });

    let call = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      call++;
      if (call === 1) {
        return new Response(makeSseStream(['this is not json']), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      return new Response(makeSseStream([JSON.stringify(VALID_SUMMARY_JSON)]), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/roundtable/${id}/summarize`,
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('"rt.summary_done"');
    expect(call).toBe(2);

    const sumCosts = ctx.costs
      .listForRoundtable({
        conversationId: ctx.rt.get(id)!.conversation_id,
        roundtableId: id,
        messageIds: ctx.rtMsg.listByRoundtable(id).map((m) => m.id),
      })
      .filter((c) => c.source_type === 'summarizer');
    expect(sumCosts).toHaveLength(2);
  });

  it('both attempts fail → rt.summary_failed + fallback_text; status reverts to round1', async () => {
    const { id } = await seed(ctx, { seedMessages: true, status: 'round1' });

    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(makeSseStream(['nonsense output']), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    );

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/roundtable/${id}/summarize`,
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('"rt.summary_failed"');
    expect(res.payload).toContain('fallback_text');
    expect(res.payload).toContain('请您手动总结');
    expect(res.payload).not.toContain('"rt.summary_done"');

    const fresh = ctx.rt.get(id)!;
    expect(fresh.status).toBe('round1');
    expect(fresh.summary).toBeNull();
  });

  it('precondition: 404 on missing id', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/roundtable/rt_nope/summarize`,
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('precondition: 409 on status=completed', async () => {
    const { id } = await seed(ctx, { seedMessages: true, status: 'completed' });
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/roundtable/${id}/summarize`,
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.payload);
    expect(body.message).toBe('roundtable_completed');
  });

  it('precondition: 409 on status=analyzing', async () => {
    const { id } = await seed(ctx, { seedMessages: false, status: 'analyzing' });
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/roundtable/${id}/summarize`,
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.payload);
    expect(body.message).toBe('roundtable_analyzing');
  });

  it('precondition: 409 when no completed messages to summarize', async () => {
    const { id } = await seed(ctx, { seedMessages: false, status: 'round1' });
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/roundtable/${id}/summarize`,
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.payload);
    expect(body.message).toBe('no_content_to_summarize');
  });
});

describe('M3.A.3 — fast-mode auto-chain summarize via POST /round', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await makeCtx();
  });
  afterEach(async () => {
    await teardown(ctx);
    vi.restoreAllMocks();
  });

  it('fast mode round 1 success → round_done emitted then summary_*', async () => {
    const { id } = await seed(ctx, { mode: 'fast', seedMessages: false, status: 'analyzing' });
    // Reset to a clean fast-mode roundtable that hasn't run yet.
    ctx.rt.setStatus(id, 'analyzing');
    // Need conversation in the right state — keep status=analyzing then route
    // will treat as ready since current_round=0 → next=1 (rt.status check
    // allows analyzing? let's verify spec: round POST allowed when not
    // completed/failed/round1/round2/summarizing). Yes — analyzing is allowed.

    let call = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      call++;
      // First 3 calls = participants. Subsequent = summarizer attempt(s).
      if (call <= 3) {
        return new Response(makeSseStream([`p${call}-says-hello`]), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      return new Response(makeSseStream([JSON.stringify(VALID_SUMMARY_JSON)]), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/roundtable/${id}/round`,
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(res.statusCode).toBe(200);
    const text = res.payload;
    const rdIdx = text.indexOf('"rt.round_done"');
    const sdIdx = text.indexOf('"rt.summary_delta"');
    const doneIdx = text.indexOf('"rt.summary_done"');
    expect(rdIdx).toBeGreaterThan(-1);
    expect(sdIdx).toBeGreaterThan(rdIdx);
    expect(doneIdx).toBeGreaterThan(sdIdx);
    expect(call).toBe(4); // 3 participants + 1 summarizer attempt

    const fresh = ctx.rt.get(id)!;
    expect(fresh.status).toBe('completed');
    expect(fresh.summary).toMatchObject({ consensus: expect.any(Array) });
  });

  it('fast mode majority fail → no auto-summarize', async () => {
    const { id } = await seed(ctx, { mode: 'fast', seedMessages: false, status: 'analyzing' });
    ctx.rt.setStatus(id, 'analyzing');

    let call = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      call++;
      // All 3 participants 429.
      return new Response(
        JSON.stringify({ error: { message: 'rate limited' } }),
        { status: 429, headers: { 'content-type': 'application/json' } },
      );
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/roundtable/${id}/round`,
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).not.toContain('"rt.summary_delta"');
    expect(res.payload).not.toContain('"rt.summary_done"');
    expect(call).toBe(3);
    expect(ctx.rt.get(id)!.status).toBe('failed');
  });
});

describe('M3.A.3 — GET /v1/roundtable/:id/export', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await makeCtx();
  });
  afterEach(async () => {
    await teardown(ctx);
    vi.restoreAllMocks();
  });

  it('returns markdown with all sections when summary structured', async () => {
    const { id } = await seed(ctx, {
      seedMessages: true,
      status: 'completed',
      summary: VALID_SUMMARY_JSON,
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/roundtable/${id}/export`,
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/markdown/);
    expect(res.headers['content-disposition']).toContain(`roundtable-${id}.md`);
    const md = res.payload;
    expect(md).toContain('# 圆桌讨论：should we use postgres');
    expect(md).toContain('**模式：** 深度');
    expect(md).toContain('## 参与者');
    expect(md).toContain('1. **综合视角**');
    expect(md).toContain('## 第一轮发言');
    expect(md).toContain('### 综合视角');
    expect(md).toContain('## 总结');
    expect(md).toContain('### ✅ 共识');
    expect(md).toContain('- 共识 A');
    expect(md).toContain('### 🎯 推荐决策');
    expect(md).toContain('在 staging 先试用一周');
    expect(md).toContain('## 成本明细');
    expect(md).toContain('| **总计** |');
  });

  it('renders 第二轮发言 section for deep mode round 2', async () => {
    const { id, modelIds } = await seed(ctx, {
      seedMessages: true,
      status: 'completed',
      summary: VALID_SUMMARY_JSON,
      mode: 'deep',
    });
    // Bump current_round and add round 2 messages.
    ctx.rt.setRound(id, 2);
    for (let i = 0; i < 3; i++) {
      const row = ctx.rtMsg.insert({
        roundtable_id: id,
        round: 2,
        participant_index: i,
        model_id: modelIds[i]!,
        status: 'pending',
        visible_to_others: true,
      });
      ctx.rtMsg.update(row.id, {
        status: 'complete',
        content: `第二轮 P${i}：补充观点`,
      });
    }

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/roundtable/${id}/export`,
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(res.statusCode).toBe(200);
    const md = res.payload;
    expect(md).toContain('## 第一轮发言');
    expect(md).toContain('## 第二轮发言（互见反驳）');
    expect(md).toContain('第二轮 P0：补充观点');
  });

  it('renders fallback summary section when summary.fallback=true', async () => {
    const { id } = await seed(ctx, {
      seedMessages: true,
      status: 'completed',
      summary: { fallback: true, raw_text: '原始讨论内容请用户手动总结' },
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/roundtable/${id}/export`,
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(res.statusCode).toBe(200);
    const md = res.payload;
    expect(md).toContain('## 总结（自动总结失败）');
    expect(md).toContain('原始讨论内容请用户手动总结');
    expect(md).not.toContain('### ✅ 共识');
  });

  it('404 on missing id', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/roundtable/rt_nope/export`,
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
