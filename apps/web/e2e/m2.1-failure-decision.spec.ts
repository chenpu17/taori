import { test, expect } from '@playwright/test';
import { readSidecarEnv, resetSidecar, authedFetch } from './_helpers';

/**
 * M2.1 — failure_decision card + auto-fallback toggle.
 *
 * Two ChatModels are seeded so the sidecar has a real fallback target
 * (`nextFallback` skips the current id and returns the next by
 * `fallback_order`). We inject the dev-only X-Test-Force-Classification
 * header by intercepting the renderer's `/v1/chat` POST in Playwright,
 * giving us deterministic classification without depending on a real
 * upstream that flakes.
 */

let env: ReturnType<typeof readSidecarEnv>;
let primaryId: string;
let fallbackId: string;

test.beforeEach(async () => {
  env = readSidecarEnv();
  await resetSidecar(env);
  // Reset the global auto-fallback flag so each test starts from OFF.
  await authedFetch(env, '/v1/memories', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      scope: 'global',
      key: 'auto_fallback_enabled',
      value: 'false',
    }),
  });
  const pr = await authedFetch(env, '/v1/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'OR',
      type: 'openrouter',
      base_url: 'https://example.invalid/v1',
      api_key: 'sk-test',
    }),
  });
  const provider = (await pr.json()) as { id: string };
  const m1 = await authedFetch(env, '/v1/models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider_id: provider.id,
      model_name: 'primary',
      capability: 'chat',
      display_name: 'Primary',
      is_default_for: 'chat',
    }),
  });
  primaryId = ((await m1.json()) as { id: string }).id;
  const m2 = await authedFetch(env, '/v1/models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider_id: provider.id,
      model_name: 'fallback',
      capability: 'chat',
      display_name: 'Fallback',
    }),
  });
  fallbackId = ((await m2.json()) as { id: string }).id;
});

test('M2.1 forced rate_limit → failure_decision card with switch + retry buttons', async ({ page }) => {
  await page.route('**/v1/chat', async (route) => {
    const headers = { ...route.request().headers(), 'x-test-force-classification': 'rate_limit' };
    await route.continue({ headers });
  });

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  await page.getByTestId('composer-input').fill('please fail with rate_limit');
  await page.getByTestId('composer-send').click();

  const card = page.getByTestId('failure-decision-card');
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card).toHaveCount(1);
  await expect(card).toHaveAttribute('data-classification', 'rate_limit');
  await expect(page.getByTestId('fdc-class')).toHaveText('rate_limit');
  await expect(page.getByTestId('fdc-retry')).toBeVisible();
  await expect(page.getByTestId('fdc-switch')).toBeVisible();
  await expect(page.getByTestId('fdc-switch')).toContainText('Fallback');
  await expect(page.getByTestId('fdc-rationale')).toContainText('失败来源');
  await expect(page.getByTestId('fdc-rationale')).toContainText('处理策略');
});

test('M2.1 manual model switch clears stale failure_decision card', async ({ page }) => {
  await page.route('**/v1/chat', async (route) => {
    const headers = { ...route.request().headers(), 'x-test-force-classification': 'rate_limit' };
    await route.continue({ headers });
  });

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  await page.getByTestId('composer-input').fill('please fail with rate_limit');
  await page.getByTestId('composer-send').click();

  await expect(page.getByTestId('failure-decision-card')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('active-model').selectOption(fallbackId);
  await expect(page.getByTestId('failure-decision-card')).toHaveCount(0);
});

test('M2.1 forced content_filter → card hides switch button', async ({ page }) => {
  await page.route('**/v1/chat', async (route) => {
    const headers = {
      ...route.request().headers(),
      'x-test-force-classification': 'content_filter',
    };
    await route.continue({ headers });
  });

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  await page.getByTestId('composer-input').fill('disallowed content');
  await page.getByTestId('composer-send').click();

  const card = page.getByTestId('failure-decision-card');
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card).toHaveAttribute('data-classification', 'content_filter');
  await expect(page.getByTestId('fdc-retry')).toBeVisible();
  await expect(page.getByTestId('fdc-switch')).toHaveCount(0);
});

test('M2.1 settings auto-fallback toggle persists via /v1/memories', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  await page.getByTestId('open-settings').click();
  const toggle = page.getByTestId('auto-fallback-toggle');
  await expect(toggle).toBeVisible();
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(toggle).toBeChecked();

  // Verify backend state.
  const r = await authedFetch(env, '/v1/memories?scope=global&key=auto_fallback_enabled');
  const j = (await r.json()) as { data: { value: string | null } };
  expect(j.data.value).toBe('true');
});

test('M2.1 auto-fallback ON → single-hop switch + system note', async ({ page }) => {
  // Seed the flag ON before page load so the first failure auto-fires.
  await authedFetch(env, '/v1/memories', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      scope: 'global',
      key: 'auto_fallback_enabled',
      value: 'true',
    }),
  });

  // Force every chat call to fail with rate_limit. The renderer should
  // detect the failure_decision, swap to the fallback model, and reload
  // — which will hit the same forced failure (single-hop only), this
  // time surfacing the card.
  await page.route('**/v1/chat', async (route) => {
    const headers = { ...route.request().headers(), 'x-test-force-classification': 'rate_limit' };
    await route.continue({ headers });
  });

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  await page.getByTestId('composer-input').fill('try auto-fallback');
  await page.getByTestId('composer-send').click();

  // System note injected by the renderer when auto-fallback fires.
  await expect(page.locator('.msg.system', { hasText: '已自动切换到' }).first()).toBeVisible({
    timeout: 15_000,
  });
  // Eventually the second attempt also fails → card shows up.
  await expect(page.getByTestId('failure-decision-card')).toBeVisible({ timeout: 15_000 });
});

// Mark unused vars.
void primaryId;
void fallbackId;
