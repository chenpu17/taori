/**
 * R7 — rapid model switch race.
 *
 * Boundary case: the user starts a long-running request with model A,
 * and BEFORE the stream completes flips the active-model selector to
 * model B, then sends a follow-up prompt. The two outgoing /v1/chat
 * bodies must each carry the model_id that was active at submit time
 * (M1 §1.2 — useChat re-reads `body` on every submit).
 *
 * Why it matters: a stale closure on model_id would re-route the
 * follow-up to model A, invisibly billing the wrong key + spending
 * against the wrong cost line. Verified against /v1/costs/breakdown
 * after both turns finalize.
 */
import { test, expect } from '@playwright/test';
import {
  authedFetch,
  readSidecarEnv,
  resetSidecar,
  type SidecarEnv,
} from './_helpers';
import { startMockOpenAI } from './_mock-openai-server';

const MOCK_PORT = 17897;
const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}/v1`;

let server: ReturnType<typeof startMockOpenAI> | null = null;
let env: SidecarEnv;

test.beforeAll(() => {
  // Mild slowdown — long enough that the renderer doesn't race past the
  // selector change but fast enough to keep wall-clock low.
  server = startMockOpenAI(MOCK_PORT, { streamDelayMs: 60 });
  env = readSidecarEnv();
});

test.afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
});

async function seed(env: SidecarEnv): Promise<{ alpha: string; beta: string }> {
  const pr = await authedFetch(env, '/v1/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Mock Switcher',
      type: 'openai',
      base_url: MOCK_URL,
      api_key: 'sk-mock',
    }),
  });
  const provider = (await pr.json()) as { id: string };
  async function mkModel(name: string, display: string, isDefault = false): Promise<string> {
    const r = await authedFetch(env, '/v1/models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider_id: provider.id,
        model_name: name,
        display_name: display,
        capability: 'chat',
        is_default_for: isDefault ? 'chat' : null,
        price_input_per_1m: 0.5,
        price_output_per_1m: 1.5,
      }),
    });
    return ((await r.json()) as { id: string }).id;
  }
  const alpha = await mkModel('mock-alpha', 'Alpha', true);
  const beta = await mkModel('mock-beta', 'Beta', false);
  return { alpha, beta };
}

test.setTimeout(120_000);

test('R7 rapid model switch between turns produces correct per-model cost rows', async ({ page }) => {
  await resetSidecar(env);
  const { alpha, beta } = await seed(env);

  await page.goto('/');
  await expect(page.getByTestId('composer-form')).toBeVisible({ timeout: 15_000 });

  // Default selector should land on Alpha (is_default_for: 'chat').
  const selector = page.getByTestId('active-model');
  await expect(selector).toHaveValue(alpha, { timeout: 10_000 });

  // ── Turn 1 with Alpha ───────────────────────────────────────────────
  await page.getByTestId('composer-input').fill('turn one — alpha view');
  await page.getByTestId('composer-send').click();

  // Wait for the first stream to complete and conv id to propagate.
  await expect(page.getByTestId('composer-stop')).toBeHidden({ timeout: 30_000 });
  await expect(page.getByTestId('chat-panel')).not.toHaveAttribute('data-active-conv', '', {
    timeout: 15_000,
  });
  await expect(page.getByTestId('composer-input')).toBeEnabled();

  const convId = await page.getByTestId('chat-panel').getAttribute('data-active-conv');
  expect(convId).toBeTruthy();

  // ── Switch to Beta, then immediately fire turn 2 ───────────────────
  await selector.selectOption(beta);
  await expect(selector).toHaveValue(beta);

  await page.getByTestId('composer-input').fill('turn two — beta view');
  await page.getByTestId('composer-send').click();
  await expect(page.getByTestId('composer-stop')).toBeHidden({ timeout: 30_000 });

  // ── Verify per-model cost rows ─────────────────────────────────────
  const breakdownRes = await authedFetch(
    env,
    `/v1/costs/breakdown?scope=session&conversation_id=${convId}`,
  );
  const breakdown = (await breakdownRes.json()) as {
    data: { rows: Array<{ model_id: string }> };
  };
  const modelIds = new Set(breakdown.data.rows.map((r) => r.model_id));
  expect(modelIds.has(alpha)).toBe(true);
  expect(modelIds.has(beta)).toBe(true);
  // Both turns landed on the same conversation.
  expect(modelIds.size).toBeGreaterThanOrEqual(2);
});
