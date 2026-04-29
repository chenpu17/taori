import { test, expect } from '@playwright/test';
import { readSidecarEnv, resetSidecar, authedFetch } from './_helpers';

/**
 * A1 — Roundtable retry-with-fallback.
 *
 * Validates the new "换模型 ▾" UI: after a participant fails, the user can
 * open the candidate dropdown and pick a different model. The dropdown
 * lists every chat model with the current one tagged "当前" and the
 * recommended next as "推荐".
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

test('A1 retry options dropdown lists candidates with current/recommended tags', async ({
  page,
}) => {
  await page.route('**/api.openai.invalid/**', (route) => route.abort());

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  // Launch roundtable and start round 1 (which will fail).
  await page.getByTestId('composer-input').fill('A1 retry options');
  await page.getByTestId('composer-roundtable').click();
  const dlg = page.getByTestId('roundtable-launch-dialog');
  await expect(dlg).toBeVisible();
  await dlg.getByTestId('roundtable-launch-start').click();
  await expect(dlg.getByTestId('roundtable-preview')).toBeVisible({
    timeout: 15_000,
  });
  await dlg.getByTestId('roundtable-launch-continue').click();
  await expect(dlg).toBeHidden();

  const panel = page.getByTestId('roundtable-panel');
  await expect(panel).toBeVisible();
  await panel.getByTestId('roundtable-action-start-round').click();

  // Wait for first cell to fail.
  await expect(panel.getByTestId('roundtable-cell-error-0-1')).toBeVisible({
    timeout: 30_000,
  });

  // Open the "换模型 ▾" dropdown for participant 0, round 1.
  const toggle = panel.getByTestId(
    'roundtable-retry-options-toggle-0-1',
  );
  await expect(toggle).toBeVisible();
  await toggle.click();

  const opts = panel.getByTestId('roundtable-retry-options-0-1');
  await expect(opts).toBeVisible();

  // 3 candidate buttons rendered (one per chat model).
  const items = opts.locator('li');
  await expect(items).toHaveCount(3);

  // First item is the current model (data-recommended=false because the
  // current model is excluded from the recommended candidate).
  const first = items.nth(0);
  await expect(first).toContainText('当前');

  // Exactly one item is tagged "推荐".
  await expect(opts.locator('.cand-tag-recommended')).toHaveCount(1);

  // Toggle collapses again.
  await toggle.click();
  await expect(opts).toBeHidden();
});
