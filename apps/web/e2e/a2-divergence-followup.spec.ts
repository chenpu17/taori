/**
 * A2 — Divergence follow-up sub-roundtable.
 *
 * After the summary streams, each divergence item in the conclusion card
 * exposes a "🔍 就这一点再来一轮" button. Clicking it should:
 *   1. close the current roundtable panel,
 *   2. open the launch dialog pre-filled with the divergence as the new
 *      topic (including positions).
 */
import { test, expect } from '@playwright/test';
import {
  authedFetch,
  readSidecarEnv,
  resetSidecar,
  type SidecarEnv,
} from './_helpers';
import { startMockOpenAI } from './_mock-openai-server';

const MOCK_PORT = 17893;
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

async function seedThreeChatModels(): Promise<void> {
  const pr = await authedFetch(env, '/v1/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'A2 mock provider',
      type: 'openai',
      base_url: MOCK_URL,
      api_key: 'sk-test-mock-key',
    }),
  });
  if (!pr.ok) throw new Error(`provider create failed: ${pr.status}`);
  const provider = (await pr.json()) as { id: string };
  const seeds = [
    { name: 'mock-strategy', display: '战略模型', isDefault: true },
    { name: 'mock-user', display: '用户研究模型', isDefault: false },
    { name: 'mock-tech', display: '技术模型', isDefault: false },
  ];
  for (const s of seeds) {
    await authedFetch(env, '/v1/models', {
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
  }
}

test('A2 divergence item exposes follow-up button that re-opens launch dialog', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await resetSidecar(env);
  await seedThreeChatModels();

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await page
    .getByTestId('composer-input')
    .fill('如何选 SaaS 计费模型？');
  await page.getByTestId('composer-tools-toggle').click();
  await expect(page.getByTestId('composer-roundtable')).toBeVisible();
  await page.getByTestId('composer-roundtable').click();

  const dlg = page.getByTestId('roundtable-launch-dialog');
  await expect(dlg).toBeVisible();
  await dlg.getByTestId('roundtable-mode-select').selectOption('deep');
  await dlg.getByTestId('roundtable-launch-start').click();
  await expect(dlg.getByTestId('roundtable-preview')).toBeVisible({
    timeout: 20_000,
  });
  await dlg.getByTestId('roundtable-launch-continue').click();

  const panel = page.getByTestId('roundtable-panel');
  await expect(panel).toBeVisible({ timeout: 15_000 });
  await panel.getByTestId('roundtable-action-start-round').click();

  // Deep mode: round 1 → next-round → round 2 → summarize.
  await expect(panel.getByTestId('roundtable-cell-0-1')).toHaveClass(
    /roundtable-cell-complete/,
    { timeout: 30_000 },
  );
  await panel.getByTestId('roundtable-action-next-round').click();
  await expect(panel.getByTestId('roundtable-cell-0-2')).toHaveClass(
    /roundtable-cell-complete/,
    { timeout: 30_000 },
  );
  await panel.getByTestId('roundtable-action-summarize').click();
  await expect(panel.getByTestId('roundtable-summary')).toBeVisible({
    timeout: 30_000,
  });

  // Divergence follow-up button is present.
  const followUp = panel.getByTestId('roundtable-divergence-followup-0');
  await expect(followUp).toBeVisible();
  await followUp.click();

  // Panel closed, launch dialog re-opened with prefilled topic.
  await expect(page.getByTestId('roundtable-panel')).toHaveCount(0);
  const dlg2 = page.getByTestId('roundtable-launch-dialog');
  await expect(dlg2).toBeVisible();
  const topicInput = dlg2.getByTestId('roundtable-topic-input');
  // Prefilled topic carries the divergence headline (mock divergence[0]
  // topic is "支持订阅升级提示").
  await expect(topicInput).toHaveValue(/再讨论一轮/);
});
