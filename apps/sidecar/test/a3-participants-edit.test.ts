/**
 * A3 — PUT /v1/roundtable/:id/participants — manual participant edit before round 1.
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
} from '../src/db/repos/index.js';
import type { FastifyInstance } from 'fastify';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const bearer = 'test_bearer_a3';

interface Ctx {
  app: FastifyInstance;
  db: ReturnType<typeof openDb>;
  dbPath: string;
  providers: ProvidersRepo;
  models: ModelsRepo;
  rt: RoundtablesRepo;
  keystore: MemoryStore;
}

async function makeCtx(): Promise<Ctx> {
  const dbPath = path.join(
    os.tmpdir(),
    `taori-a3-${Date.now()}-${Math.random()}.db`,
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
    keystore,
  };
}

async function teardown(ctx: Ctx): Promise<void> {
  await ctx.app.close();
  fs.rmSync(ctx.dbPath, { force: true });
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
  const participants = modelIds.slice(0, 2).map((mid, i) => ({
    model_id: mid,
    role_label: ['综合', '批判'][i]!,
    persona_prompt: 'persona-original',
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

describe('A3 — PUT /v1/roundtable/:id/participants', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await makeCtx();
  });
  afterEach(async () => {
    await teardown(ctx);
    vi.restoreAllMocks();
  });

  it('replaces participants when current_round=0', async () => {
    const { id, modelIds } = await seedRoundtable(ctx);
    const next = [
      {
        model_id: modelIds[1]!,
        display_name: 'M1',
        role_label: '换了',
        persona_prompt: 'edited persona prompt',
      },
      {
        model_id: modelIds[2]!,
        display_name: 'M2',
        role_label: '新角色',
        persona_prompt: 'edited persona prompt 2',
      },
      {
        model_id: modelIds[3]!,
        display_name: 'M3',
        role_label: '第三',
        persona_prompt: 'edited persona prompt 3',
      },
    ];
    const res = await ctx.app.inject({
      method: 'PUT',
      url: `/v1/roundtable/${id}/participants`,
      headers: { authorization: `Bearer ${bearer}` },
      payload: { participants: next },
    });
    expect(res.statusCode).toBe(200);
    const row = ctx.rt.get(id)!;
    expect(row.participants).toHaveLength(3);
    expect(row.participants[0]!.model_id).toBe(modelIds[1]);
    expect(row.participants[0]!.role_label).toBe('换了');
    expect(row.participants[0]!.persona_prompt).toBe('edited persona prompt');
  });

  it('rejects when fewer than 2 participants', async () => {
    const { id, modelIds } = await seedRoundtable(ctx);
    const res = await ctx.app.inject({
      method: 'PUT',
      url: `/v1/roundtable/${id}/participants`,
      headers: { authorization: `Bearer ${bearer}` },
      payload: {
        participants: [
          {
            model_id: modelIds[0]!,
            display_name: 'M0',
            role_label: '只剩一个',
            persona_prompt: 'too few participants',
          },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('validation_error');
  });

  it('rejects unknown model_id', async () => {
    const { id } = await seedRoundtable(ctx);
    const res = await ctx.app.inject({
      method: 'PUT',
      url: `/v1/roundtable/${id}/participants`,
      headers: { authorization: `Bearer ${bearer}` },
      payload: {
        participants: [
          {
            model_id: 'nope',
            display_name: 'X',
            role_label: 'X',
            persona_prompt: 'persona for unknown model',
          },
          {
            model_id: 'nope2',
            display_name: 'Y',
            role_label: 'Y',
            persona_prompt: 'persona for unknown model 2',
          },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('validation_error');
  });

  it('rejects after current_round > 0 (conflict)', async () => {
    const { id, modelIds } = await seedRoundtable(ctx);
    ctx.db.run(`UPDATE roundtables SET current_round = 1 WHERE id = '${id}'`);
    const res = await ctx.app.inject({
      method: 'PUT',
      url: `/v1/roundtable/${id}/participants`,
      headers: { authorization: `Bearer ${bearer}` },
      payload: {
        participants: [
          {
            model_id: modelIds[1]!,
            display_name: 'M1',
            role_label: 'r1',
            persona_prompt: 'after-start change attempt',
          },
          {
            model_id: modelIds[2]!,
            display_name: 'M2',
            role_label: 'r2',
            persona_prompt: 'after-start change attempt 2',
          },
        ],
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('conflict');
  });
});
