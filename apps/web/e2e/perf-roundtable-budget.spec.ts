/**
 * Perf — round-table wall-clock guardrail.
 *
 * Runs the deep-mode 3-participant pipeline (analyzer → R1 → R2 → summary)
 * end-to-end against the local OAI mock and asserts the entire flow finishes
 * within a generous budget. Catches catastrophic regressions in the
 * orchestrator (e.g. accidental serialization, infinite retries, dead waits).
 *
 * Budget rationale: each cell ~1s mock stream × 3 participants × 2 rounds
 * + summary ~1s + analyzer ~1s ≈ 8s real work. We allow 60s ceiling so
 * CI noise / fastify cold start doesn't flake the test.
 */
import { test, expect } from '@playwright/test';
import {
  authedFetch,
  readSidecarEnv,
  resetSidecar,
  type SidecarEnv,
} from './_helpers';
import { startMockOpenAI } from './_mock-openai-server';

const MOCK_PORT = 17899;
const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}/v1`;

let server: ReturnType<typeof startMockOpenAI> | null = null;
let env: SidecarEnv;

test.beforeAll(async () => {
  server = startMockOpenAI(MOCK_PORT);
  env = readSidecarEnv();
});

test.afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
});

async function seedThreeModels(env: SidecarEnv): Promise<void> {
  const pr = await authedFetch(env, '/v1/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'perf-roundtable provider',
      type: 'openai',
      base_url: MOCK_URL,
      api_key: 'sk-test-mock-key',
    }),
  });
  if (!pr.ok) throw new Error(`provider create failed: ${pr.status}`);
  const provider = (await pr.json()) as { id: string };

  const seeds = [
    { name: 'p-strategy', display: '战略', isDefault: true },
    { name: 'p-user', display: '用研', isDefault: false },
    { name: 'p-tech', display: '技术', isDefault: false },
  ];
  for (const s of seeds) {
    const r = await authedFetch(env, '/v1/models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider_id: provider.id,
        model_name: s.name,
        capability: 'chat',
        display_name: s.display,
        is_default_for: s.isDefault ? 'chat' : null,
        price_input_per_1m: 0.5,
        price_output_per_1m: 1.5,
      }),
    });
    if (!r.ok) throw new Error(`model create failed: ${r.status}`);
  }
}

test('Perf — deep round-table 2-round + summary completes within budget', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await resetSidecar(env);
  await seedThreeModels(env);

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  await page.getByTestId('composer-input').fill('选 SaaS 计费模型');
  await page.getByTestId('composer-tools-toggle').click();
  await expect(page.getByTestId('composer-roundtable')).toBeVisible();
  await page.getByTestId('composer-roundtable').click();

  const dlg = page.getByTestId('roundtable-launch-dialog');
  await expect(dlg).toBeVisible();
  await dlg.getByTestId('roundtable-mode-select').selectOption('deep');

  const t0 = Date.now();

  await dlg.getByTestId('roundtable-launch-start').click();
  await expect(dlg.getByTestId('roundtable-preview')).toBeVisible({
    timeout: 20_000,
  });
  await dlg.getByTestId('roundtable-launch-continue').click();

  const panel = page.getByTestId('roundtable-panel');
  await expect(panel).toBeVisible({ timeout: 15_000 });

  await panel.getByTestId('roundtable-action-start-round').click();
  await expect(panel.getByTestId('roundtable-cell-0-1')).toHaveClass(
    /roundtable-cell-complete/,
    { timeout: 45_000 },
  );

  await panel.getByTestId('roundtable-action-next-round').click();
  await expect(panel.getByTestId('roundtable-cell-0-2')).toHaveClass(
    /roundtable-cell-complete/,
    { timeout: 45_000 },
  );

  await panel.getByTestId('roundtable-action-summarize').click();
  await expect(panel.getByTestId('roundtable-summary')).toBeVisible({
    timeout: 30_000,
  });

  const elapsed = Date.now() - t0;
  // Generous ceiling — real work is ~8s; 60s flags catastrophic regressions.
  expect(elapsed).toBeLessThan(60_000);
});
