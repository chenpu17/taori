import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { openDb } from '../src/db/index.js';
import { ControlClient } from '../src/control/client.js';
import { MemoryStore } from '../src/keystore.js';
import type { FastifyInstance } from 'fastify';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const bearer = 'test_bearer_diagnostics';

interface Ctx {
  app: FastifyInstance;
  db: ReturnType<typeof openDb>;
  dbPath: string;
}

async function makeCtx(): Promise<Ctx> {
  const dbPath = path.join(
    os.tmpdir(),
    `taori-diagnostics-${Date.now()}-${Math.random()}.db`,
  );
  const db = openDb(dbPath);
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
    keystore: new MemoryStore(),
    startedAt: Date.now() - 5_000,
  });
  await app.ready();
  return { app, db, dbPath };
}

async function teardown(ctx: Ctx): Promise<void> {
  await ctx.app.close();
  fs.rmSync(ctx.dbPath, { force: true });
}

describe('GET /v1/diagnostics/real-provider/latest', () => {
  let ctx: Ctx;
  let artifactDir: string | null = null;

  beforeEach(async () => {
    ctx = await makeCtx();
  });

  afterEach(async () => {
    await teardown(ctx);
    if (artifactDir) fs.rmSync(artifactDir, { recursive: true, force: true });
    artifactDir = null;
  });

  it('returns a safe empty state when no artifact exists', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/diagnostics/real-provider/latest',
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; available: boolean; message: string };
    expect(body.ok).toBe(true);
    expect(typeof body.available).toBe('boolean');
    if (!body.available) {
      expect(body.message).toContain('verify:real');
    }
  });

  it('summarizes the latest verify:real artifact without reading secrets', async () => {
    artifactDir = path.join(os.tmpdir(), `taori-real-journey-test-${Date.now()}`);
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(
      path.join(artifactDir, 'events.json'),
      JSON.stringify({
        run_id: 'test-real-run',
        artifact_dir: artifactDir,
        structured_risks: [{ code: 'model_did_not_follow_tool_call', message: 'tool not called' }],
        steps: [
          { name: 'image_generate_tool_from_chat', ok: true },
          { name: 'mcp_tool_from_ordinary_chat', ok: true },
          { name: 'real_skip_tool_recovery', ok: false },
        ],
        agent_runtime: {
          run_count: 3,
          run_event_count: 18,
          cost_call_count: 5,
          latest_run_status: 'completed',
        },
        final_screenshot: path.join(artifactDir, '99-final-state.png'),
      }),
    );
    fs.writeFileSync(
      path.join(artifactDir, 'capability-summary.json'),
      JSON.stringify({
        collected_at: '2026-05-06T00:00:00.000Z',
        selected: {
          tool_chat: { id: 'mdl_tool', label: 'Tool Model', supports_tools: true },
          image: { id: 'mdl_image', label: 'Image Model', capability: 'image' },
        },
      }),
    );

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/diagnostics/real-provider/latest',
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      available: boolean;
      artifact_dir: string;
      summary: { passed_steps: number; failed_steps: number; risk_count: number; run_count: number };
      selected: { tool_chat?: { label?: string } };
      required_steps: Array<{ name: string; ok: boolean }>;
      risks: Array<{ code: string; message: string }>;
    };
    expect(body.available).toBe(true);
    expect(body.artifact_dir).toBe(artifactDir);
    expect(body.summary).toMatchObject({
      passed_steps: 2,
      failed_steps: 1,
      risk_count: 1,
      run_count: 3,
    });
    expect(body.selected.tool_chat?.label).toBe('Tool Model');
    expect(body.required_steps.find((step) => step.name === 'real_skip_tool_recovery')?.ok).toBe(false);
    expect(body.risks[0]?.code).toBe('model_did_not_follow_tool_call');
  });
});
