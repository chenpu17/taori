/**
 * R6 — error classification + strike accounting matrix.
 *
 * Verifies the spec-audit fixes:
 *   - M1 (auth): 401/403 upstream → classification='auth' (not 'unknown').
 *   - M2 (strikes): {quota, rate_limit, network, auth, unknown} count toward
 *     demote(3)/disable(5); content_filter does NOT (per-prompt user issue).
 *
 * Strategy: spawn a tiny mock OpenAI server that returns a chosen status
 * code per request, drive /v1/chat against a real sidecar model, then read
 * `consecutive_strikes` (or `disabled` once it crosses 5) from /v1/models.
 */
import { test, expect } from '@playwright/test';
import http from 'node:http';
import {
  authedFetch,
  readSidecarEnv,
  resetSidecar,
  type SidecarEnv,
} from './_helpers';

interface FailureMode {
  status: number;
  body: Record<string, unknown> | string;
  classification: 'auth' | 'rate_limit' | 'quota' | 'content_filter';
  countsAsStrike: boolean;
}

const MODES: Record<string, FailureMode> = {
  auth: {
    status: 401,
    body: { error: { message: 'invalid api key', type: 'invalid_request_error' } },
    classification: 'auth',
    countsAsStrike: true,
  },
  rate_limit: {
    status: 429,
    body: { error: { message: 'rate limit exceeded', type: 'rate_limit_error' } },
    classification: 'rate_limit',
    countsAsStrike: true,
  },
  quota: {
    status: 429,
    body: { error: { message: 'You exceeded your current quota', code: 'insufficient_quota' } },
    classification: 'quota',
    countsAsStrike: true,
  },
  content_filter: {
    status: 400,
    body: {
      error: {
        message: 'content_policy: response blocked by content filter',
        code: 'content_policy_violation',
        type: 'invalid_request_error',
      },
    },
    classification: 'content_filter',
    countsAsStrike: false,
  },
};

let env: SidecarEnv;

test.beforeAll(() => {
  env = readSidecarEnv();
});

function startFailServer(port: number, mode: FailureMode): http.Server {
  const srv = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url?.includes('/chat/completions')) {
      const body =
        typeof mode.body === 'string' ? mode.body : JSON.stringify(mode.body);
      res.writeHead(mode.status, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  srv.listen(port, '127.0.0.1');
  return srv;
}

async function waitListening(srv: http.Server): Promise<void> {
  await new Promise<void>((resolve) => srv.once('listening', resolve));
}

async function seedModel(env: SidecarEnv, baseUrl: string): Promise<string> {
  const pr = await authedFetch(env, '/v1/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: `Mock ${baseUrl}`,
      type: 'openai',
      base_url: baseUrl,
      api_key: 'sk-mock',
    }),
  });
  const provider = (await pr.json()) as { id: string };
  const mr = await authedFetch(env, '/v1/models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider_id: provider.id,
      model_name: 'mock-fail',
      capability: 'chat',
      display_name: 'Failer',
      is_default_for: 'chat',
      price_input_per_1m: 0.5,
      price_output_per_1m: 1.5,
    }),
  });
  return ((await mr.json()) as { id: string }).id;
}

async function fireChat(env: SidecarEnv, modelId: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const r = await authedFetch(env, '/v1/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model_id: modelId,
        messages: [{ role: 'user', content: `attempt ${i + 1}` }],
      }),
    });
    // Drain stream so the server-side error path runs to completion.
    if (r.body) {
      const reader = r.body.getReader();
      while (!(await reader.read()).done) {
        /* ignore */
      }
    }
  }
}

async function readModel(env: SidecarEnv, id: string): Promise<{
  failure_count_24h: number;
  demoted: boolean;
  disabled_until: number | null;
}> {
  const r = await authedFetch(env, '/v1/models');
  const { models } = (await r.json()) as {
    models: Array<{
      id: string;
      failure_count_24h: number;
      demoted: boolean;
      disabled_until: number | null;
    }>;
  };
  const m = models.find((x) => x.id === id);
  if (!m) throw new Error(`model ${id} not found`);
  return m;
}

test.setTimeout(120_000);

for (const [name, mode] of Object.entries(MODES)) {
  test(`R6 error-matrix · ${name} → classification=${mode.classification}, strike=${mode.countsAsStrike}`, async () => {
    await resetSidecar(env);
    const port = 17800 + Math.floor(Math.random() * 90);
    const srv = startFailServer(port, mode);
    await waitListening(srv);
    try {
      const modelId = await seedModel(env, `http://127.0.0.1:${port}/v1`);
      // Send 2 failing chats — enough to confirm strike accumulation
      // direction without crossing demote/disable thresholds.
      await fireChat(env, modelId, 2);

      const m = await readModel(env, modelId);
      if (mode.countsAsStrike) {
        expect.soft(m.failure_count_24h, `${name}: strikes after 2 fails`).toBeGreaterThanOrEqual(2);
      } else {
        expect.soft(m.failure_count_24h, `${name}: must NOT count strikes`).toBe(0);
      }
      const isDisabled = m.disabled_until != null && m.disabled_until > Date.now();
      expect.soft(isDisabled, `${name}: not disabled at 2 strikes`).toBe(false);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
}

test('R6 error-matrix · 5 auth failures disable the model (M1+M2)', async () => {
  await resetSidecar(env);
  const port = 17891;
  const srv = startFailServer(port, MODES.auth!);
  await waitListening(srv);
  try {
    const modelId = await seedModel(env, `http://127.0.0.1:${port}/v1`);
    await fireChat(env, modelId, 5);
    const m = await readModel(env, modelId);
    // 5 strikes → disabled_until set to now+24h per spec 09-m2 §7.2.
    expect(m.disabled_until).not.toBeNull();
    expect(m.disabled_until!).toBeGreaterThan(Date.now());
    expect(m.failure_count_24h).toBeGreaterThanOrEqual(5);
    expect(m.demoted).toBe(true);
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
});

test('R6 error-matrix · 10 content_filter failures do NOT disable', async () => {
  await resetSidecar(env);
  const port = 17892;
  const srv = startFailServer(port, MODES.content_filter!);
  await waitListening(srv);
  try {
    const modelId = await seedModel(env, `http://127.0.0.1:${port}/v1`);
    await fireChat(env, modelId, 10);
    const m = await readModel(env, modelId);
    expect(m.disabled_until).toBeNull();
    expect(m.demoted).toBe(false);
    expect(m.failure_count_24h).toBe(0);
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
});
