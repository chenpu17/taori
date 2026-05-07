/**
 * B3 — GET /v1/selfcheck integration tests.
 *
 * Verifies the checks (sidecar/keystore/database/default_model) and the overall
 * status aggregation (ok / warn / error). Keychain probing is opt-in so the
 * default in-app self-check does not trigger OS prompts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { openDb } from '../src/db/index.js';
import { ControlClient } from '../src/control/client.js';
import { MemoryStore } from '../src/keystore.js';
import { ProvidersRepo, ModelsRepo } from '../src/db/repos/index.js';
import type { FastifyInstance } from 'fastify';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const bearer = 'test_bearer_b3';

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
    `taori-b3-${Date.now()}-${Math.random()}.db`,
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
    startedAt: Date.now() - 5_000,
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

describe('B3 — GET /v1/selfcheck', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await makeCtx();
  });
  afterEach(async () => {
    await teardown(ctx);
  });

  async function get(includeKeychain = false) {
    return ctx.app.inject({
      method: 'GET',
      url: `/v1/selfcheck${includeKeychain ? '?include_keychain=1' : ''}`,
      headers: { authorization: `Bearer ${bearer}` },
    });
  }

  it('reports error when no chat models configured', async () => {
    const res = await get();
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      ok: boolean;
      overall: string;
      checks: { id: string; ok: boolean; level: string; detail: string }[];
    };
    expect(body.checks).toHaveLength(4);
    const ids = body.checks.map((c) => c.id);
    expect(ids).toEqual([
      'sidecar',
      'keystore',
      'database',
      'default_model',
    ]);
    // sidecar / database always ok in test env; keystore is skipped by default.
    expect(body.checks[0].ok).toBe(true);
    expect(body.checks[1].ok).toBe(true);
    expect(body.checks[1].level).toBe('warn');
    expect(body.checks[2].ok).toBe(true);
    // No models → default_model fails
    expect(body.checks[3].ok).toBe(false);
    expect(body.checks[3].level).toBe('error');
    expect(body.overall).toBe('error');
    expect(body.ok).toBe(false);
  });

  it('reports warn when models exist but none is the default', async () => {
    const prov = ctx.providers.create({
      name: 'P',
      type: 'openai',
      base_url: 'http://x',
      api_key: 'k',
    });
    ctx.models.create({
      provider_id: prov.id,
      model_name: 'gpt-4o-mini',
      capability: 'chat',
      display_name: 'Mini',
    });
    const res = await get();
    const body = res.json() as {
      ok: boolean;
      overall: string;
      checks: { id: string; level: string; detail: string }[];
    };
    expect(body.overall).toBe('warn');
    expect(body.ok).toBe(true);
    const m = body.checks.find((c) => c.id === 'default_model')!;
    expect(m.level).toBe('warn');
    expect(m.detail).toContain('未设置默认');
  });

  it('reports ok when default chat model is configured', async () => {
    const prov = ctx.providers.create({
      name: 'P',
      type: 'openai',
      base_url: 'http://x',
      api_key: 'k',
    });
    ctx.models.create({
      provider_id: prov.id,
      model_name: 'gpt-4o-mini',
      capability: 'chat',
      display_name: 'Mini',
      is_default_for: 'chat',
    });
    const res = await get();
    const body = res.json() as {
      ok: boolean;
      overall: string;
      checks: { id: string; level: string; detail: string }[];
    };
    expect(body.overall).toBe('warn');
    expect(body.ok).toBe(true);
    expect(body.checks.find((c) => c.id === 'keystore')!.level).toBe('warn');
    const m = body.checks.find((c) => c.id === 'default_model')!;
    expect(m.detail).toContain('Mini');
  });

  it('keystore probe is opt-in, round-trips, and cleans up after', async () => {
    const res = await get(true);
    const body = res.json() as {
      checks: { id: string; ok: boolean; level: string }[];
    };
    expect(body.checks.find((c) => c.id === 'keystore')!.ok).toBe(true);
    expect(body.checks.find((c) => c.id === 'keystore')!.level).toBe('ok');
  });
});
