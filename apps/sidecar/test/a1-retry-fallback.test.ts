/**
 * A1 — Roundtable retry-with-fallback.
 *
 * Verifies:
 *   - GET /participant/:i/retry-candidates returns the candidate set
 *     ordered with current/recommended on top, demoted/disabled flagged
 *   - PUT /retry with body { model_id } switches the participant's model,
 *     persists it on participants[i].model_id and on the message row
 *   - PUT /retry with an invalid model_id rejects (validation_error)
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
} from '../src/db/repos/index.js';
import type { FastifyInstance } from 'fastify';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const bearer = 'test_bearer_a1';

interface Ctx {
  app: FastifyInstance;
  db: ReturnType<typeof openDb>;
  dbPath: string;
  providers: ProvidersRepo;
  models: ModelsRepo;
  rt: RoundtablesRepo;
  rtMsg: RoundtableMessagesRepo;
  keystore: MemoryStore;
}

async function makeCtx(): Promise<Ctx> {
  const dbPath = path.join(
    os.tmpdir(),
    `taori-a1-${Date.now()}-${Math.random()}.db`,
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
    keystore,
  };
}

async function teardown(ctx: Ctx): Promise<void> {
  await ctx.app.close();
  fs.rmSync(ctx.dbPath, { force: true });
}

function sseStream(text: string, finishReason = 'stop'): string {
  return (
    `data: ${JSON.stringify({
      id: '1',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'm',
      choices: [
        { index: 0, delta: { role: 'assistant', content: text }, finish_reason: null },
      ],
    })}\n\n` +
    `data: ${JSON.stringify({
      id: '2',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'm',
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })}\n\n` +
    `data: [DONE]\n\n`
  );
}

async function seedRoundtable(ctx: Ctx): Promise<{
  id: string;
  modelIds: string[];
}> {
  const prov = ctx.providers.create({
    name: 'P',
    type: 'openai',
    base_url: 'https://api.example.com/v1',
    api_key: 'sk-test',
  });
  await ctx.keystore.write(prov.api_key_ref!, 'sk-test');
  const modelIds: string[] = [];
  for (let i = 0; i < 4; i++) {
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
  // Use only first 3 as participants — m3 is the spare candidate.
  const participants = modelIds.slice(0, 3).map((mid, i) => ({
    model_id: mid,
    role_label: ['综合', '批判', '实践'][i]!,
    persona_prompt: 'persona',
    display_name: `M${i}`,
  }));
  const conv = new ConversationsRepo(ctx.db).ensure(undefined, {
    type: 'roundtable',
  });
  const inserted = ctx.rt.insert({
    conversation_id: conv.id,
    topic: 'topic',
    mode: 'fast',
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

describe('A1 — retry candidates + model override', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await makeCtx();
  });
  afterEach(async () => {
    await teardown(ctx);
    vi.restoreAllMocks();
  });

  it('GET /retry-candidates lists all chat models with current first', async () => {
    const { id, modelIds } = await seedRoundtable(ctx);
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/roundtable/${id}/participant/0/retry-candidates`,
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      current_model_id: string;
      recommended_model_id: string | null;
      candidates: { model_id: string; is_current: boolean; recommended: boolean }[];
    };
    expect(body.current_model_id).toBe(modelIds[0]);
    expect(body.candidates).toHaveLength(4);
    expect(body.candidates[0]!.is_current).toBe(true);
    expect(body.candidates[0]!.model_id).toBe(modelIds[0]);
    // recommended is the next non-current chat model in fallback_order
    expect(body.recommended_model_id).toBe(modelIds[1]);
    expect(body.candidates.find((c) => c.model_id === modelIds[1])!.recommended).toBe(true);
  });

  it('flags demoted models', async () => {
    const { id, modelIds } = await seedRoundtable(ctx);
    // Force-demote m3 (the spare) — write directly since ModelUpdate
    // schema doesn't expose `demoted` (set internally by recordFailure).
    ctx.db.run(
      `UPDATE models SET demoted = 1 WHERE id = '${modelIds[3]!}'`,
    );
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/roundtable/${id}/participant/0/retry-candidates`,
      headers: { authorization: `Bearer ${bearer}` },
    });
    const body = res.json() as {
      candidates: { model_id: string; demoted: boolean }[];
    };
    const m3 = body.candidates.find((c) => c.model_id === modelIds[3])!;
    expect(m3.demoted).toBe(true);
  });

  it('PUT /retry with model_id swaps participant model and msg row', async () => {
    const { id, modelIds } = await seedRoundtable(ctx);
    // Pre-create a failed message row at round 1, index 0.
    ctx.rtMsg.insert({
      roundtable_id: id,
      round: 1,
      participant_index: 0,
      model_id: modelIds[0]!,
      status: 'pending',
    });
    const existing = ctx.rtMsg.findOne(id, 1, 0)!;
    ctx.rtMsg.update(existing.id, {
      status: 'failed',
      error_message: 'rate_limit',
      classification: 'rate_limit',
    });

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(sseStream('ok answer'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });

    const res = await ctx.app.inject({
      method: 'PUT',
      url: `/v1/roundtable/${id}/round/1/participant/0/retry`,
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
      },
      payload: { model_id: modelIds[3]! },
    });
    expect(res.statusCode).toBe(200);
    // The stream body should include rt.meta with override_model_id.
    expect(res.body).toContain('override_model_id');
    expect(res.body).toContain(modelIds[3]!);

    const after = ctx.rt.get(id)!;
    expect(after.participants[0]!.model_id).toBe(modelIds[3]);
    const msg = ctx.rtMsg.findOne(id, 1, 0)!;
    expect(msg.model_id).toBe(modelIds[3]);
    expect(msg.status).toBe('complete');
  });

  it('PUT /retry rejects unknown model_id', async () => {
    const { id, modelIds } = await seedRoundtable(ctx);
    ctx.rtMsg.insert({
      roundtable_id: id,
      round: 1,
      participant_index: 0,
      model_id: modelIds[0]!,
      status: 'failed',
    });
    const res = await ctx.app.inject({
      method: 'PUT',
      url: `/v1/roundtable/${id}/round/1/participant/0/retry`,
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
      },
      payload: { model_id: 'mdl_does_not_exist' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { code?: string };
    expect(body.code).toBe('validation_error');
    // Original model unchanged.
    const after = ctx.rt.get(id)!;
    expect(after.participants[0]!.model_id).toBe(modelIds[0]);
  });
});
