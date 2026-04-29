/**
 * Perf — long-history conversation rendering.
 *
 * Stress check: a conversation pre-seeded with many turns (50 user +
 * 50 assistant messages) must load via /v1/conversations/:id/messages
 * and render in the timeline within a reasonable wall-clock budget,
 * with the composer remaining responsive (no UI hang).
 *
 * This is a guardrail, not a benchmark: the budget below is generous
 * enough to absorb CI slowness, but tight enough to catch O(N²)
 * regressions in the renderer (e.g. re-running annotation extraction
 * over the full message list on every keystroke).
 */
import { test, expect } from '@playwright/test';
import {
  authedFetch,
  readSidecarEnv,
  resetSidecar,
  type SidecarEnv,
} from './_helpers';
import { startMockOpenAI } from './_mock-openai-server';

const MOCK_PORT = 17898;
const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}/v1`;

let server: ReturnType<typeof startMockOpenAI> | null = null;
let env: SidecarEnv;

test.beforeAll(() => {
  server = startMockOpenAI(MOCK_PORT);
  env = readSidecarEnv();
});

test.afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
});

async function seedModel(env: SidecarEnv): Promise<string> {
  const pr = await authedFetch(env, '/v1/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Mock Long',
      type: 'openai',
      base_url: MOCK_URL,
      api_key: 'sk-mock',
    }),
  });
  const provider = (await pr.json()) as { id: string };
  const r = await authedFetch(env, '/v1/models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider_id: provider.id,
      model_name: 'mock-long',
      display_name: 'LongMock',
      capability: 'chat',
      is_default_for: 'chat',
      price_input_per_1m: 0.5,
      price_output_per_1m: 1.5,
    }),
  });
  return ((await r.json()) as { id: string }).id;
}

test.setTimeout(180_000);

test('Perf — 50-turn history loads + remains responsive', async ({ page }) => {
  await resetSidecar(env);
  const modelId = await seedModel(env);

  // Drive 50 chat turns through the real /v1/chat endpoint. The first
  // call mints a conversation (sidecar auto-creates when conversation_id
  // is undefined); subsequent calls reuse the same id so all 50 turns
  // land on one conversation. Each turn streams from the mock in <100ms.
  let convId: string | null = null;
  for (let i = 0; i < 50; i++) {
    const res = await authedFetch(env, '/v1/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model_id: modelId,
        ...(convId ? { conversation_id: convId } : {}),
        messages: [{ role: 'user', content: `seed turn ${i + 1}` }],
      }),
    });
    // Drain the SSE so sidecar runs end-of-stream persistence hooks.
    const text = await res.text();
    if (!convId) {
      // The first `meta` annotation carries the freshly minted conv id.
      const match = text.match(/"conversation_id":"(conv_[A-Za-z0-9_-]+)"/);
      convId = match?.[1] ?? null;
    }
  }
  if (!convId) throw new Error('mock chat did not return a conversation_id');

  // Verify sidecar persisted ≥ 100 messages (50 user + 50 assistant).
  const persisted = await authedFetch(env, `/v1/conversations/${convId}/messages`).then(
    (r) => r.json() as Promise<{ messages: Array<{ role: string }> }>,
  );
  expect(persisted.messages.length).toBeGreaterThanOrEqual(100);

  // ── Wall-clock guardrail for opening a heavy conversation ──────────
  await page.goto('/');
  await expect(page.getByTestId('composer-form')).toBeVisible({ timeout: 15_000 });

  const t0 = Date.now();
  // Click the first sidebar item (only one conversation exists).
  await page.getByTestId('conv-item').first().click();

  // Wait for the timeline to fully populate.
  await expect
    .poll(async () => await page.locator('.msg.user').count(), { timeout: 30_000 })
    .toBeGreaterThanOrEqual(50);
  await expect
    .poll(async () => await page.locator('.msg.assistant').count(), { timeout: 30_000 })
    .toBeGreaterThanOrEqual(50);
  const dtLoadMs = Date.now() - t0;

  // Generous budget — we just want to detect catastrophic regressions.
  expect(dtLoadMs).toBeLessThan(15_000);

  // Composer must remain interactive while the heavy timeline is mounted.
  const composer = page.getByTestId('composer-input');
  const t1 = Date.now();
  await composer.fill('responsiveness probe');
  const dtTypeMs = Date.now() - t1;
  expect(dtTypeMs).toBeLessThan(2_000);
  await expect(composer).toHaveValue('responsiveness probe');
});
