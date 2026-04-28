import { test, expect } from '@playwright/test';
import { readSidecarEnv, resetSidecar, authedFetch } from './_helpers';

/**
 * M3.A.5 — Roundtable main panel.
 *
 * Without a working upstream, every participant call fails (the seeded
 * provider points at api.openai.invalid). The renderer must still:
 *   1. Mount the panel after launch + display N participant columns.
 *   2. After clicking "开始第 1 轮", show failure cells with retry buttons.
 *   3. Restore the panel on page reload (spec §5.3).
 *   4. Persist a cancel via POST /v1/roundtable/:id/cancel.
 */

let env: ReturnType<typeof readSidecarEnv>;

async function seedThreeChatModels(): Promise<void> {
  const pr = await authedFetch(env, '/v1/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'OAI',
      type: 'openai',
      base_url: 'https://api.openai.invalid/v1',
      api_key: 'sk-test',
    }),
  });
  const provider = (await pr.json()) as { id: string };
  for (let i = 0; i < 3; i++) {
    await authedFetch(env, '/v1/models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider_id: provider.id,
        model_name: `gpt-${i}`,
        capability: 'chat',
        display_name: `Chat ${i}`,
        ...(i === 0 ? { is_default_for: 'chat' } : {}),
        price_input_per_1m: 1,
        price_output_per_1m: 2,
      }),
    });
  }
}

test.beforeEach(async () => {
  env = readSidecarEnv();
  await resetSidecar(env);
  await seedThreeChatModels();
});

test('M3.A.5 round 1 all-failed → failure cells render with retry buttons', async ({
  page,
}) => {
  await page.route('**/api.openai.invalid/**', (route) => route.abort());

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  // Launch dialog → analyzer fallback → continue.
  await page.getByTestId('composer-input').fill('需要选 ORM 框架');
  await page.getByTestId('composer-roundtable').click();
  const dlg = page.getByTestId('roundtable-launch-dialog');
  await expect(dlg).toBeVisible();
  await dlg.getByTestId('roundtable-launch-start').click();
  await expect(dlg.getByTestId('roundtable-preview')).toBeVisible({
    timeout: 15_000,
  });
  await dlg.getByTestId('roundtable-launch-continue').click();
  await expect(dlg).toBeHidden();

  // Panel mounts.
  const panel = page.getByTestId('roundtable-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('roundtable-grid').locator('.roundtable-column')).toHaveCount(3);

  // Start round 1.
  await panel.getByTestId('roundtable-action-start-round').click();

  // All three participant cells reach failed state.
  for (let i = 0; i < 3; i++) {
    await expect(
      panel.getByTestId(`roundtable-cell-error-${i}-1`),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      panel.getByTestId(`roundtable-retry-${i}-1`),
    ).toBeVisible();
  }
});

test('M3.A.5 panel restores on page reload (state restoration §5.3)', async ({
  page,
}) => {
  await page.route('**/api.openai.invalid/**', (route) => route.abort());

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  await page.getByTestId('composer-input').fill('需要选 ORM 框架');
  await page.getByTestId('composer-roundtable').click();
  const dlg = page.getByTestId('roundtable-launch-dialog');
  await dlg.getByTestId('roundtable-launch-start').click();
  await expect(dlg.getByTestId('roundtable-preview')).toBeVisible({
    timeout: 15_000,
  });
  await dlg.getByTestId('roundtable-launch-continue').click();
  await expect(page.getByTestId('roundtable-panel')).toBeVisible();

  // Reload — conversations are persisted server-side; sidebar lists them.
  // The user clicks the conversation, and the panel must restore.
  await page.reload();
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  // Sidebar shows the roundtable conversation. Click to activate.
  const items = page.getByTestId('conv-item');
  await expect(items.first()).toBeVisible({ timeout: 10_000 });
  await items.first().click();
  await expect(page.getByTestId('roundtable-panel')).toBeVisible({
    timeout: 10_000,
  });
});

test('M3.A.5 cost label visible in panel header', async ({ page }) => {
  await page.route('**/api.openai.invalid/**', (route) => route.abort());

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  await page.getByTestId('composer-input').fill('需要选 ORM 框架');
  await page.getByTestId('composer-roundtable').click();
  const dlg = page.getByTestId('roundtable-launch-dialog');
  await dlg.getByTestId('roundtable-launch-start').click();
  await expect(dlg.getByTestId('roundtable-preview')).toBeVisible({
    timeout: 15_000,
  });
  await dlg.getByTestId('roundtable-launch-continue').click();

  const panel = page.getByTestId('roundtable-panel');
  await expect(panel).toBeVisible();
  const cost = panel.getByTestId('roundtable-total-cost');
  await expect(cost).toBeVisible();
  await expect(cost).toContainText('$');
});
