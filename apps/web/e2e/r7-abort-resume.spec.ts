/**
 * R7 — abort mid-stream + resume.
 *
 * Boundary case the spec implies but no prior e2e covers:
 *   user clicks the ■ 停止 button while an assistant message is streaming,
 *   then sends a new prompt. The renderer must:
 *     1. Halt the stream (composer becomes interactive again, stop button
 *        disappears).
 *     2. Preserve whatever text has already been streamed (per useChat
 *        contract — partial assistant message stays in the timeline).
 *     3. Accept and complete a follow-up prompt cleanly.
 *
 * Strategy: configure the mock OpenAI server to stream slowly enough
 * (300ms per chunk × 6 chunks ≈ 1.8s) that a Playwright click on the
 * stop button reliably lands mid-stream. Drive it through a real sidecar
 * + real renderer to exercise the full stack including useChat's abort
 * controller wiring.
 */
import { test, expect } from '@playwright/test';
import {
  authedFetch,
  readSidecarEnv,
  resetSidecar,
  type SidecarEnv,
} from './_helpers';
import { startMockOpenAI } from './_mock-openai-server';

const MOCK_PORT = 17896;
const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}/v1`;

let server: ReturnType<typeof startMockOpenAI> | null = null;
let env: SidecarEnv;

test.beforeAll(() => {
  // 300ms per SSE chunk → ample window for a manual stop click.
  server = startMockOpenAI(MOCK_PORT, { streamDelayMs: 300 });
  env = readSidecarEnv();
});

test.afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
});

async function seed(env: SidecarEnv): Promise<string> {
  const pr = await authedFetch(env, '/v1/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Mock Slow',
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
      model_name: 'mock-slow',
      display_name: 'SlowMock',
      capability: 'chat',
      is_default_for: 'chat',
      price_input_per_1m: 0.5,
      price_output_per_1m: 1.5,
    }),
  });
  return ((await r.json()) as { id: string }).id;
}

test.setTimeout(120_000);

test('R7 abort mid-stream → resume with a new prompt', async ({ page }) => {
  await resetSidecar(env);
  await seed(env);

  await page.goto('/');
  await expect(page.getByTestId('composer-form')).toBeVisible({ timeout: 15_000 });

  // ── Turn 1: send, then click stop while streaming ───────────────────
  await page.getByTestId('composer-input').fill('first prompt — please be slow');
  await page.getByTestId('composer-send').click();

  // The stop button only appears while isLoading=true. If it shows, we
  // know the request is in flight (the slow mock guarantees this).
  await expect(page.getByTestId('composer-stop')).toBeVisible({ timeout: 10_000 });

  // Click stop. useChat.stop() aborts the fetch + flips isLoading=false,
  // which removes the stop button and re-enables the composer.
  await page.getByTestId('composer-stop').click();

  await expect(page.getByTestId('composer-stop')).toBeHidden({ timeout: 10_000 });
  await expect(page.getByTestId('composer-input')).toBeEnabled({ timeout: 5_000 });

  // The user message should still be in the timeline; whatever assistant
  // text already streamed before the abort is allowed to remain.
  await expect(
    page.locator('.msg.user', { hasText: 'first prompt' }),
  ).toBeVisible();

  const beforeAssistant = await page.locator('.msg.assistant').count();

  // ── Turn 2: send a follow-up; it must complete normally ────────────
  await page.getByTestId('composer-input').fill('second prompt — finish please');
  await page.getByTestId('composer-send').click();

  // Wait for stream to fully complete (stop button reappears then gone).
  await expect(page.getByTestId('composer-stop')).toBeHidden({ timeout: 30_000 });

  // A new assistant message must have arrived for the follow-up.
  await expect
    .poll(async () => await page.locator('.msg.assistant').count(), {
      timeout: 30_000,
    })
    .toBeGreaterThan(beforeAssistant);
  await expect(
    page.locator('.msg.user', { hasText: 'second prompt' }),
  ).toBeVisible();
});
