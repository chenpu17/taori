import { test, expect } from '@playwright/test';
import { readSidecarEnv, resetSidecar, authedFetch } from './_helpers';

/**
 * M3.A.4 — roundtable launch dialog (web entrypoint).
 *
 * Flow:
 *   1. Click 🔍 圆桌 button → dialog opens
 *   2. Topic prefilled from composer; mode select default = auto
 *   3. Click 开始分析 → analyzer call (with no real upstream we hit
 *      analyzer_fallback path on the sidecar — three default roles)
 *   4. Preview shows participants + estimate + fallback notice
 *   5. Continue → roundtable banner shows id; modal closes
 *
 * We DO NOT want real upstream calls. Sidecar's analyzer falls back to
 * default participants when the chat call fails — we exploit that by
 * pointing the seeded provider at a host that returns 401.
 */

let env: ReturnType<typeof readSidecarEnv>;

test.beforeEach(async () => {
  env = readSidecarEnv();
  await resetSidecar(env);
  // Mock upstream chat completions so analyzer fails → fallback path.
  // Seed three chat-capable models so the analyzer fallback can distribute
  // them across three default roles.
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
});

test('M3.A.4 launch dialog → analyzer fallback → preview → continue → banner', async ({
  page,
}) => {
  // Force the analyzer's upstream chat call to fail so we hit the
  // analyzer_fallback path deterministically.
  await page.route('**/api.openai.invalid/**', (route) => route.abort());

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  await page.getByTestId('composer-input').fill('是否在生产从 mysql 迁移到 postgres');
  await page.getByTestId('composer-roundtable').click();

  const dlg = page.getByTestId('roundtable-launch-dialog');
  await expect(dlg).toBeVisible();
  // Topic prefilled.
  await expect(dlg.getByTestId('roundtable-topic-input')).toHaveValue(
    '是否在生产从 mysql 迁移到 postgres',
  );

  // Submit → analyzer runs → preview appears. (analyzing state may flash by
  // too fast to assert reliably when the analyzer call is fast.)
  await dlg.getByTestId('roundtable-launch-start').click();

  await expect(dlg.getByTestId('roundtable-preview')).toBeVisible({
    timeout: 15_000,
  });
  await expect(dlg.getByTestId('roundtable-fallback-notice')).toBeVisible();
  // 3 fallback participants.
  await expect(
    dlg.getByTestId('roundtable-participants-list').locator('li'),
  ).toHaveCount(3);
  await expect(dlg.getByTestId('roundtable-estimate')).toContainText('$');

  // Continue → banner appears, dialog closes.
  await dlg.getByTestId('roundtable-launch-continue').click();
  await expect(dlg).toBeHidden();
  await expect(page.getByTestId('roundtable-panel')).toBeVisible();
});

test('M3.A.4 cancel from edit step closes dialog without creating roundtable', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  await page.getByTestId('composer-roundtable').click();
  const dlg = page.getByTestId('roundtable-launch-dialog');
  await expect(dlg).toBeVisible();
  await dlg.getByTestId('roundtable-launch-cancel').click();
  await expect(dlg).toBeHidden();
  await expect(page.getByTestId('roundtable-panel')).toHaveCount(0);
});

test('M3.A.4 Esc during analyzing is ignored (no orphan close)', async ({
  page,
}) => {
  // Slow down the POST so we can press Esc while it's in flight.
  await page.route('**/v1/roundtable', async (route) => {
    if (route.request().method() === 'POST') {
      await new Promise((r) => setTimeout(r, 1500));
    }
    await route.continue();
  });

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('composer-input').fill('topic');
  await page.getByTestId('composer-roundtable').click();
  const dlg = page.getByTestId('roundtable-launch-dialog');
  await dlg.getByTestId('roundtable-launch-start').click();
  await expect(dlg.getByTestId('roundtable-analyzing')).toBeVisible();
  // Press Esc — should NOT close the dialog.
  await page.keyboard.press('Escape');
  // Wait for analyzer to resolve and preview to appear.
  await expect(dlg.getByTestId('roundtable-preview')).toBeVisible({
    timeout: 15_000,
  });
});

test('M3.A.4 disabled_conversations skips confirm checkbox visibility', async ({
  page,
}) => {
  // Pre-set the conversation-skip preference to a placeholder; the dialog
  // will check `prefs.disabledConvs` against the new conversation_id (random)
  // so the placeholder won't match — but `cost_confirm_roundtable_always`
  // can be set to false to short-circuit the confirm gate.
  await authedFetch(env, '/v1/memories', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      scope: 'global',
      scope_id: null,
      key: 'cost_confirm_roundtable_always',
      value: 'false',
    }),
  });
  // Threshold=999 ensures even a high estimate falls below.
  await authedFetch(env, '/v1/memories', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      scope: 'global',
      scope_id: null,
      key: 'cost_confirm_roundtable_threshold_usd',
      value: '999',
    }),
  });

  await page.route('**/api.openai.invalid/**', (route) => route.abort());

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('composer-input').fill('选 sql 还是 nosql');
  await page.getByTestId('composer-roundtable').click();
  const dlg = page.getByTestId('roundtable-launch-dialog');
  await dlg.getByTestId('roundtable-launch-start').click();
  await expect(dlg.getByTestId('roundtable-preview')).toBeVisible({
    timeout: 15_000,
  });
  // Confirm-gate disabled → skip-checkbox NOT shown.
  await expect(dlg.getByTestId('roundtable-skip-conv')).toHaveCount(0);
  await dlg.getByTestId('roundtable-launch-continue').click();
  await expect(dlg).toBeHidden();
});
