/**
 * M3.A.2 — Round runner + per-participant retry.
 *
 * Coverage:
 *   - POST /v1/roundtable/:id/round runs all participants in parallel; emits
 *     rt.round_start / rt.participant_delta / rt.participant_done /
 *     rt.round_done; sets status='round1' and current_round=1
 *   - Each participant writes a `roundtable_messages` row with status='complete'
 *     and the streamed content concatenated; cost_records written with
 *     source_type='roundtable_message'
 *   - When ≥ ceil(N/2) participants fail, roundtable.status='failed'
 *   - When fast mode, second POST round → 409 fast_mode_no_round_two
 *   - PUT retry replaces the in-place row, preserves participant_index
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
  RunEventsRepo,
} from '../src/db/repos/index.js';
import type { FastifyInstance } from 'fastify';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const bearer = 'test_bearer_m3a2';

interface Ctx {
  app: FastifyInstance;
  db: ReturnType<typeof openDb>;
  dbPath: string;
  providers: ProvidersRepo;
  models: ModelsRepo;
  rt: RoundtablesRepo;
  rtMsg: RoundtableMessagesRepo;
  costs: CostsRepo;
  runEvents: RunEventsRepo;
  keystore: MemoryStore;
}

async function makeCtx(): Promise<Ctx> {
  const dbPath = path.join(
    os.tmpdir(),
    `taori-m3a2-${Date.now()}-${Math.random()}.db`,
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
    runEvents: new RunEventsRepo(db),
    keystore,
  };
}

async function teardown(ctx: Ctx): Promise<void> {
  await ctx.app.close();
  fs.rmSync(ctx.dbPath, { force: true });
}

/** Build an OpenAI SSE chat stream with given chunks + finish_reason. */
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

async function seedFallbackRoundtable(
  ctx: Ctx,
  count = 3,
  mode: 'fast' | 'deep' = 'deep',
): Promise<{ id: string; modelIds: string[] }> {
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
  // Seed roundtable directly to avoid running the analyzer (which would hit
  // the upstream provider). Use fixed fallback personas — exactly the rows
  // the route's fallback path would write.
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
  const inserted = ctx.rt.insert({
    conversation_id: new ConversationsRepo(ctx.db).ensure(undefined, { type: 'roundtable' }).id,
    topic: 'should we use postgres',
    mode,
    participants,
    summarizer_model_id: modelIds[0]!,
    analyzer_fallback: true,
    status: 'analyzing',
    current_round: 0,
    estimated_cost_usd_low: 0.01,
    estimated_cost_usd_high: 0.02,
  });
  return { id: inserted.id, modelIds };
}

describe('M3.A.2 — POST /v1/roundtable/:id/round', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await makeCtx();
  });
  afterEach(async () => {
    await teardown(ctx);
    vi.restoreAllMocks();
  });

  it('streams round 1, persists messages + costs, sets status=round1', async () => {
    const { id } = await seedFallbackRoundtable(ctx, 3);

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => {
        return new Response(makeSseStream(['Hi', ' there']), {
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
    expect(fetchSpy).toHaveBeenCalledTimes(3); // 3 participants

    const text = res.payload;
    // round_start emitted
    expect(text).toContain('"rt.round_start"');
    // 3 participant_done frames
    const doneCount = (text.match(/"rt\.participant_done"/g) ?? []).length;
    expect(doneCount).toBe(3);
    // round_done with all completed
    expect(text).toContain('"rt.round_done"');

    // DB: roundtable status round1, current_round=1
    const rt = ctx.rt.get(id)!;
    expect(rt.status).toBe('round1');
    expect(rt.current_round).toBe(1);
    // 3 message rows complete
    const msgs = ctx.rtMsg.listByRoundtable(id);
    expect(msgs).toHaveLength(3);
    expect(msgs.every((m) => m.status === 'complete')).toBe(true);
    expect(msgs.every((m) => m.content === 'Hi there')).toBe(true);
    // 3 cost rows roundtable_message + 1 topic_analyzer (from creation)
    const allCosts = ctx.costs.sumSince({ since: 0 });
    expect(allCosts.calls).toBeGreaterThanOrEqual(3);

    const events = ctx.runEvents.listByConversation(rt.conversation_id, 100);
    expect(events.find((e) => e.kind === 'turn.started')?.payload).toMatchObject({
      run_kind: 'roundtable',
      roundtable_id: id,
      action: 'round',
      round: 1,
    });
    expect(events.filter((e) => e.kind === 'model.started')).toHaveLength(3);
    expect(events.filter((e) => e.kind === 'model.completed')).toHaveLength(3);
    expect(events.filter((e) => e.kind === 'cost.recorded')).toHaveLength(3);
    expect(events.at(-1)?.kind).toBe('turn.completed');

    const runs = ctx.runEvents.listRunsByConversation(rt.conversation_id, 10);
    expect(runs[0]).toMatchObject({
      kind: 'roundtable',
      status: 'completed',
      conversation_id: rt.conversation_id,
    });
  });

  it('majority failure → roundtable.status=failed', async () => {
    const { id } = await seedFallbackRoundtable(ctx, 3);

    // All three participants get rate-limited: with maxRetries=0 the streamText
    // call fails fast and the runner classifies the error as rate_limit.
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(
          JSON.stringify({ error: { message: 'rate limited' } }),
          { status: 429, headers: { 'content-type': 'application/json' } },
        ),
    );

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/roundtable/${id}/round`,
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(res.statusCode).toBe(200);
    const text = res.payload;
    expect((text.match(/"rt\.participant_failed"/g) ?? []).length).toBe(3);
    expect((text.match(/"rt\.participant_done"/g) ?? []).length).toBe(0);
    const rt = ctx.rt.get(id)!;
    expect(rt.status).toBe('failed');
  });

  it('fast mode: second round POST → 409 fast_mode_no_round_two', async () => {
    const { id } = await seedFallbackRoundtable(ctx, 3, 'fast');
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(makeSseStream(['ok']), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    );
    // round 1
    const r1 = await ctx.app.inject({
      method: 'POST',
      url: `/v1/roundtable/${id}/round`,
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(r1.statusCode).toBe(200);
    // mark status back to a non-busy state if it stayed at round1
    // The runner doesn't move status off 'round1' on success; round2 attempt
    // hits the fast_mode rule before the busy rule because mode='fast'.
    const rt = ctx.rt.get(id)!;
    // simulate idle by hand — production triggers summarizer next.
    ctx.rt.setStatus(rt.id, 'analyzing');
    const r2 = await ctx.app.inject({
      method: 'POST',
      url: `/v1/roundtable/${id}/round`,
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(r2.statusCode).toBe(409);
    const body = r2.json() as { code: string; message: string };
    expect(body.message).toBe('fast_mode_no_round_two');
  });

  it('GET unknown id → 404 on round POST too', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/roundtable/rt_nope/round',
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('M3.A.2 — PUT retry single participant', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await makeCtx();
  });
  afterEach(async () => {
    await teardown(ctx);
    vi.restoreAllMocks();
  });

  it('retry replaces row in place, preserves participant_index', async () => {
    const { id } = await seedFallbackRoundtable(ctx, 3);

    // Stateful mock: first phase fails everything, second phase (after we
    // flip `phase`) succeeds. No restoreAllMocks mid-test (ESM-spies of
    // globalThis.fetch are flaky to re-install in vitest).
    let phase: 'fail' | 'ok' = 'fail';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      if (phase === 'fail') {
        return new Response(
          JSON.stringify({ error: { message: 'rate limited' } }),
          { status: 429, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(makeSseStream(['retried-ok']), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });

    const r1 = await ctx.app.inject({
      method: 'POST',
      url: `/v1/roundtable/${id}/round`,
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(r1.statusCode).toBe(200);

    let msgs = ctx.rtMsg.listByRoundtable(id);
    expect(msgs).toHaveLength(3);
    expect(msgs.every((m) => m.status === 'failed')).toBe(true);
    const originalRowAt1 = msgs.find((m) => m.participant_index === 1)!;

    // Flip the mock to "ok" for the retry.
    phase = 'ok';

    const retryRes = await ctx.app.inject({
      method: 'PUT',
      url: `/v1/roundtable/${id}/round/1/participant/1/retry`,
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(retryRes.statusCode).toBe(200);
    expect(retryRes.payload).toContain('"rt.participant_done"');
    expect(retryRes.payload).toContain('"participant_index":1');
    // Other indices not present in the retry stream.
    expect(retryRes.payload).not.toContain('"participant_index":0');
    expect(retryRes.payload).not.toContain('"participant_index":2');

    msgs = ctx.rtMsg.listByRoundtable(id);
    expect(msgs).toHaveLength(3); // no new row inserted
    const updated = msgs.find((m) => m.participant_index === 1)!;
    expect(updated.id).toBe(originalRowAt1.id);
    expect(updated.status).toBe('complete');
    expect(updated.content).toBe('retried-ok');
  });

  it('retry with bad index → 400 validation', async () => {
    const { id } = await seedFallbackRoundtable(ctx, 3);
    const res = await ctx.app.inject({
      method: 'PUT',
      url: `/v1/roundtable/${id}/round/1/participant/99/retry`,
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it('retry before round runs → 404', async () => {
    const { id } = await seedFallbackRoundtable(ctx, 3);
    const res = await ctx.app.inject({
      method: 'PUT',
      url: `/v1/roundtable/${id}/round/1/participant/0/retry`,
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
