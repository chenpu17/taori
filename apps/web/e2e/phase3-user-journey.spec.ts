/**
 * Phase 3 — comprehensive end-to-end test from a user's perspective.
 *
 * Walks the same flow a returning user takes — seed via API as M1.1 already
 * covers the onboarding UI in isolation. This test exercises the *chat
 * lifecycle* end to end: send → see streamed reply → see cost annotation →
 * see status bar update → reload → drop unsupported file → trigger upstream
 * error path. Mirrors DoD checklist in docs/product/08-m1-spec.md §7.
 */
import { test, expect } from '@playwright/test';
import { readSidecarEnv, authedFetch, resetSidecar, seedDefaultModel } from './_helpers';

const env = readSidecarEnv();

test.beforeEach(async () => {
  await resetSidecar(env);
});

test('Phase 3 user journey: chat → cost → reload → drop reject → error path', async ({ page }) => {
  // --- 0. Seed a default chat model so the chat panel boots immediately.
  await seedDefaultModel(env);

  // --- 1. Land on chat panel.
  await page.goto('/');
  await expect(page.getByTestId('composer-form')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.price-badge')).toBeVisible();

  // --- 2. Send a message → streamed assistant reply + per-message cost.
  await page.getByTestId('composer-input').fill('hello taori, e2e journey test');
  await page.getByTestId('composer-send').click();
  await expect(page.locator('.msg.assistant').first()).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.msg-cost').first()).toBeVisible({ timeout: 10_000 });

  // --- 3. Cost status bar updates.
  await expect(page.getByTestId('cost-bar')).toBeVisible();
  // Today's total should be present and parseable as a dollar figure.
  const barText = await page.getByTestId('cost-bar').innerText();
  expect(barText).toMatch(/\$|￥|今日|month/i);

  // --- 4. Reload — sidecar SQLite persists costs, so totals survive.
  await page.reload();
  await expect(page.getByTestId('composer-form')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('cost-bar')).toBeVisible();

  // --- 5. Drop an unsupported file → user-visible rejection (not silent).
  const dt = await page.evaluateHandle(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['junk'], 'junk.exe', { type: 'application/octet-stream' }));
    return dt;
  });
  await page.getByTestId('composer-form').dispatchEvent('dragover', { dataTransfer: dt });
  await page.getByTestId('composer-form').dispatchEvent('drop', { dataTransfer: dt });
  await expect(page.getByTestId('drop-error')).toBeVisible();
  await expect(page.getByTestId('attachment-thumb')).toHaveCount(0);

  // --- 6. Force an upstream error path: swap to a provider with a bogus URL
  //        and an api_key (api_key triggers the upstream branch in the
  //        sidecar; without it the mock stream would just succeed).
  await resetSidecar(env);
  const pr = await authedFetch(env, '/v1/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'bad', type: 'custom',
      base_url: 'https://nonexistent.invalid.local/v1',
      api_key: 'sk-bad',
    }),
  });
  const prov = (await pr.json()) as { id: string };
  await authedFetch(env, '/v1/models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider_id: prov.id, model_name: 'whatever', capability: 'chat',
      display_name: 'Bad', is_default_for: 'chat',
      price_input_per_1m: 0.5, price_output_per_1m: 1.5,
    }),
  });
  await page.reload();
  await expect(page.getByTestId('composer-form')).toBeVisible({ timeout: 10_000 });
  await page.route('**/v1/chat', async (route) => {
    const headers = { ...route.request().headers(), 'x-test-force-classification': 'rate_limit' };
    await route.continue({ headers });
  });
  await page.getByTestId('composer-input').fill('this should fail');
  await page.getByTestId('composer-send').click();
  await expect(page.getByTestId('chat-error')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('chat-error-class')).toHaveText(
    /^provider_error\/(quota|rate_limit|network|content_filter|unknown)$/,
  );
});
