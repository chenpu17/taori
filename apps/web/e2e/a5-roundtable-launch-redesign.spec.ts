import { test, expect } from '@playwright/test';
import { readSidecarEnv, resetSidecar, authedFetch } from './_helpers';

/**
 * A5 — Roundtable launch dialog redesign.
 *
 * What we verify (real-user perspective):
 *   1. Open the launch dialog → click 开始分析
 *   2. Preview shows the mode-comparison cards (fast vs deep)
 *   3. Chosen mode is highlighted via data-chosen="true" + chosen badge
 *   4. Both cards have populated calls / cost / duration values
 *   5. Reason chips include the requested mode
 *   6. On analyzer fallback: reason panel hidden, fallback notice shown,
 *      reason chips still show requested-mode chip (no topic_type/complexity)
 */

let env: ReturnType<typeof readSidecarEnv>;

test.beforeEach(async () => {
  env = readSidecarEnv();
  await resetSidecar(env);
  // Seed three chat models pointing at an unreachable host so the analyzer
  // falls back deterministically.
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

test('A5 launch dialog shows mode-comparison cards with populated values', async ({
  page,
}) => {
  await page.route('**/api.openai.invalid/**', (route) => route.abort());

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('composer-input').fill('是否要从 mysql 迁移到 postgres');
  await page.getByTestId('composer-tools-toggle').click();
  await expect(page.getByTestId('composer-roundtable')).toBeVisible();
  await page.getByTestId('composer-roundtable').click();

  const dlg = page.getByTestId('roundtable-launch-dialog');
  await expect(dlg).toBeVisible();
  await expect(dlg.getByTestId('roundtable-analyzer-model-select')).toContainText(
    'Chat 0 · OAI',
  );
  await expect(dlg.getByTestId('roundtable-summarizer-model-select')).toContainText(
    'Chat 0 · OAI',
  );
  await dlg.getByTestId('roundtable-launch-start').click();

  await expect(dlg.getByTestId('roundtable-preview')).toBeVisible({
    timeout: 15_000,
  });

  // 1) Mode comparison panel visible.
  const compare = dlg.getByTestId('roundtable-mode-compare');
  await expect(compare).toBeVisible();

  const fastCard = dlg.getByTestId('roundtable-mode-card-fast');
  const deepCard = dlg.getByTestId('roundtable-mode-card-deep');
  await expect(fastCard).toBeVisible();
  await expect(deepCard).toBeVisible();

  // 2) Exactly one chosen card shows the badge. In the analyzer-fallback
  //    path the suggested mode is 'fast'.
  await expect(fastCard).toHaveAttribute('data-chosen', 'true');
  await expect(deepCard).toHaveAttribute('data-chosen', 'false');
  await expect(
    dlg.getByTestId('roundtable-mode-card-chosen-badge'),
  ).toHaveCount(1);
  await expect(
    dlg.getByTestId('roundtable-mode-card-chosen-badge'),
  ).toBeVisible();

  // 3) Both cards have populated calls / cost / duration values.
  for (const mode of ['fast', 'deep'] as const) {
    const calls = dlg.getByTestId(`roundtable-mode-card-${mode}-calls`);
    const cost = dlg.getByTestId(`roundtable-mode-card-${mode}-cost`);
    const dur = dlg.getByTestId(`roundtable-mode-card-${mode}-duration`);
    await expect(calls).not.toBeEmpty();
    // calls must be a positive integer
    const callsTxt = (await calls.innerText()).trim();
    expect(Number(callsTxt)).toBeGreaterThan(0);
    await expect(cost).toContainText('$');
    await expect(dur).toContainText('秒');
  }

  // 4) deep mode should have strictly more calls than fast (more rounds).
  const fastCalls = Number(
    (await dlg.getByTestId('roundtable-mode-card-fast-calls').innerText()).trim(),
  );
  const deepCalls = Number(
    (await dlg.getByTestId('roundtable-mode-card-deep-calls').innerText()).trim(),
  );
  expect(deepCalls).toBeGreaterThan(fastCalls);

  // 5) On fallback: reason panel is hidden, fallback notice visible.
  await expect(dlg.getByTestId('roundtable-reason-panel')).toHaveCount(0);
  await expect(dlg.getByTestId('roundtable-fallback-notice')).toBeVisible();

  // 6) Reason chips still render with at least the requested-mode chip
  //    (topic_type/complexity chips are absent on fallback).
  await expect(dlg.getByTestId('roundtable-reason-chips')).toBeVisible();
  await expect(dlg.getByTestId('roundtable-reason-chip-req')).toBeVisible();
  await expect(dlg.getByTestId('roundtable-reason-chip-req')).toContainText(
    '分析器',
  );
  // No topic_type / complexity chips on fallback path.
  await expect(dlg.getByTestId('roundtable-reason-chip-topic')).toHaveCount(0);
  await expect(dlg.getByTestId('roundtable-reason-chip-cx')).toHaveCount(0);
});

test('A5 user-specified mode shows "用户已指定" chip', async ({ page }) => {
  await page.route('**/api.openai.invalid/**', (route) => route.abort());

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('composer-input').fill('讨论选型');
  await page.getByTestId('composer-tools-toggle').click();
  await expect(page.getByTestId('composer-roundtable')).toBeVisible();
  await page.getByTestId('composer-roundtable').click();

  const dlg = page.getByTestId('roundtable-launch-dialog');
  await expect(dlg).toBeVisible();
  // Switch the launch-mode select to 'deep' before launching.
  const modeSelect = dlg.getByTestId('roundtable-mode-select');
  await modeSelect.selectOption('deep');
  await dlg.getByTestId('roundtable-launch-start').click();

  await expect(dlg.getByTestId('roundtable-preview')).toBeVisible({
    timeout: 15_000,
  });

  // Chosen card should now be 'deep' (analyzer suggestion is overridden by
  // explicit user request).
  await expect(dlg.getByTestId('roundtable-mode-card-deep')).toHaveAttribute(
    'data-chosen',
    'true',
  );

  // The requested-mode chip should now read "用户已指定 深度".
  await expect(dlg.getByTestId('roundtable-reason-chip-req')).toContainText(
    '已指定',
  );
  await expect(dlg.getByTestId('roundtable-reason-chip-req')).toContainText(
    '深度',
  );
});
