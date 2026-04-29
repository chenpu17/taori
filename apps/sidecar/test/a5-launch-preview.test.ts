/**
 * A5 — POST /v1/roundtable now returns a `preview` block for the launch
 * dialog redesign:
 *   - topic_type / complexity (null on fallback)
 *   - analyzer_chose_mode_reason (null on fallback)
 *   - estimated_calls / duration ranges for the chosen mode
 *   - alt_mode + matching estimates so renderer can show fast vs deep
 *
 * Plus pure-function coverage for the helpers in cost-estimate.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { openDb } from '../src/db/index.js';
import { ControlClient } from '../src/control/client.js';
import { MemoryStore } from '../src/keystore.js';
import { ProvidersRepo, ModelsRepo } from '../src/db/repos/index.js';
import {
  estimateRoundtableCallsAndDuration,
  buildAnalyzerModeReason,
} from '../src/roundtable/cost-estimate.js';
import type { FastifyInstance } from 'fastify';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const bearer = 'test_bearer_a5';

interface Ctx {
  app: FastifyInstance;
  db: ReturnType<typeof openDb>;
  dbPath: string;
  providers: ProvidersRepo;
  models: ModelsRepo;
}

async function makeCtx(): Promise<Ctx> {
  const dbPath = path.join(
    os.tmpdir(),
    `taori-a5-${Date.now()}-${Math.random()}.db`,
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
  };
}

async function teardown(ctx: Ctx): Promise<void> {
  await ctx.app.close();
  fs.rmSync(ctx.dbPath, { force: true });
}

describe('A5 — estimateRoundtableCallsAndDuration', () => {
  it('fast mode with analyzer + 3 participants → 5 calls', () => {
    const r = estimateRoundtableCallsAndDuration({
      mode: 'fast',
      hasAnalyzer: true,
      participantCount: 3,
    });
    // analyzer(1) + 3*1(round) + summarizer(1) = 5
    expect(r.calls).toBe(5);
    // sequentialSlots = 1 + 1 + 1 = 3 → 12..24s
    expect(r.durationSecLow).toBe(12);
    expect(r.durationSecHigh).toBe(24);
  });

  it('deep mode with analyzer + 3 participants → 8 calls', () => {
    const r = estimateRoundtableCallsAndDuration({
      mode: 'deep',
      hasAnalyzer: true,
      participantCount: 3,
    });
    // analyzer(1) + 3*2(rounds) + summarizer(1) = 8
    expect(r.calls).toBe(8);
    // sequentialSlots = 1 + 2 + 1 = 4 → 16..32s
    expect(r.durationSecLow).toBe(16);
    expect(r.durationSecHigh).toBe(32);
  });

  it('without analyzer (fallback path) the call count drops by 1', () => {
    const r = estimateRoundtableCallsAndDuration({
      mode: 'fast',
      hasAnalyzer: false,
      participantCount: 3,
    });
    expect(r.calls).toBe(4); // 0 + 3 + 1
    expect(r.durationSecLow).toBe(8); // 2 slots * 4
  });
});

describe('A5 — buildAnalyzerModeReason', () => {
  it('returns null when analyzer fell back', () => {
    expect(
      buildAnalyzerModeReason({
        topicType: 'business',
        complexity: 'high',
        requestedMode: 'auto',
        chosenMode: 'deep',
        analyzerFallback: true,
      }),
    ).toBeNull();
  });

  it('explicit mode → "按你指定的XX模式运行"', () => {
    const r = buildAnalyzerModeReason({
      topicType: 'business',
      complexity: 'high',
      requestedMode: 'deep',
      chosenMode: 'deep',
      analyzerFallback: false,
    });
    expect(r).toContain('深度');
    expect(r).toContain('按你指定');
  });

  it('auto+deep mentions both topic type and complexity', () => {
    const r = buildAnalyzerModeReason({
      topicType: 'technical',
      complexity: 'high',
      requestedMode: 'auto',
      chosenMode: 'deep',
      analyzerFallback: false,
    });
    expect(r).toContain('技术抉择');
    expect(r).toContain('复杂度较高');
    expect(r).toContain('深度');
  });

  it('auto+fast cites "快速模式已足够"', () => {
    const r = buildAnalyzerModeReason({
      topicType: 'creative',
      complexity: 'low',
      requestedMode: 'auto',
      chosenMode: 'fast',
      analyzerFallback: false,
    });
    expect(r).toContain('创意发散');
    expect(r).toContain('快速');
    expect(r).toContain('已足够');
  });
});

describe('A5 — POST /v1/roundtable preview block', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await makeCtx();
  });
  afterEach(async () => {
    await teardown(ctx);
  });

  it('returns preview with alt_mode estimate and (null reason on fallback)', async () => {
    const prov = ctx.providers.create({
      name: 'P',
      type: 'openai',
      base_url: 'http://x',
      api_key: 'placeholder',
    });
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

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/roundtable',
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ topic: 'pick a database', mode: 'auto' }),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      mode: 'fast' | 'deep';
      analyzer_fallback: boolean;
      preview: {
        topic_type: string | null;
        complexity: string | null;
        requested_mode: string;
        analyzer_chose_mode_reason: string | null;
        estimated_calls: number;
        estimated_duration_sec_low: number;
        estimated_duration_sec_high: number;
        alt_mode: 'fast' | 'deep';
        alt_estimated_cost_usd_low: number | null;
        alt_estimated_cost_usd_high: number | null;
        alt_estimated_calls: number;
        alt_estimated_duration_sec_low: number;
        alt_estimated_duration_sec_high: number;
      };
    };
    expect(body.analyzer_fallback).toBe(true);
    expect(body.preview).toBeDefined();
    // analyzer fallback → topic_type / complexity / reason all null
    expect(body.preview.topic_type).toBeNull();
    expect(body.preview.complexity).toBeNull();
    expect(body.preview.analyzer_chose_mode_reason).toBeNull();
    expect(body.preview.requested_mode).toBe('auto');

    // Chosen mode = fast (fallback default), so alt = deep with bigger calls
    expect(body.mode).toBe('fast');
    expect(body.preview.alt_mode).toBe('deep');
    expect(body.preview.estimated_calls).toBeLessThan(
      body.preview.alt_estimated_calls,
    );
    // duration ranges populated
    expect(body.preview.estimated_duration_sec_low).toBeGreaterThan(0);
    expect(body.preview.alt_estimated_duration_sec_high).toBeGreaterThan(
      body.preview.alt_estimated_duration_sec_low,
    );
    // alt cost > chosen cost (deep does more rounds)
    expect(
      (body.preview.alt_estimated_cost_usd_low ?? 0) >
        (body as any).estimated_cost_usd_low,
    ).toBe(true);
  });
});
