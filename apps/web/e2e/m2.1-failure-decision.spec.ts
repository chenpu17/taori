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

test.beforeEach(async ({ page }) => {
  env = readSidecarEnv();
  await resetSidecar(env);
  await page.addInitScript(() => {
    localStorage.setItem('tip_image_first_seen', 'true');
    localStorage.setItem('tip_fallback_first_seen', 'true');
    localStorage.setItem('tip_cost_first_seen', 'true');
    localStorage.setItem('tip_roundtable_first_seen', 'true');
  });
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
      price_input_per_1m: 1,
      price_output_per_1m: 2,
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
      price_input_per_1m: 1,
      price_output_per_1m: 2,
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

test('M2.1 retry button uses Sidecar recover API without adding a user message', async ({ page }) => {
  let recoverCalled = false;
  await page.route('**/v1/chat', async (route) => {
    const headers = { ...route.request().headers(), 'x-test-force-classification': 'rate_limit' };
    await route.continue({ headers });
  });
  await page.route('**/v1/runs/*/recover', async (route) => {
    recoverCalled = true;
    await route.continue();
  });

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  await page.getByTestId('composer-input').fill('please fail then recover');
  await page.getByTestId('composer-send').click();

  await expect(page.getByTestId('failure-decision-card')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('fdc-retry').click();

  await expect(page.getByTestId('failure-decision-card')).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator('.msg.user')).toHaveCount(1);
  await expect(page.locator('.msg.assistant')).toHaveCount(2);
  await expect.poll(() => recoverCalled).toBe(true);
});

test('M2.1 retry recovery opens cost confirmation before high-cost recover', async ({ page }) => {
  let firstRecoverBody: { confirmed_cost?: boolean } | null = null;
  let confirmedRecoverBody: { confirmed_cost?: boolean } | null = null;
  await page.route('**/v1/chat', async (route) => {
    const headers = { ...route.request().headers(), 'x-test-force-classification': 'rate_limit' };
    await route.continue({ headers });
  });
  await page.route('**/v1/runs/*/recover', async (route) => {
    const raw = route.request().postData();
    const body = raw ? JSON.parse(raw) as { confirmed_cost?: boolean } : {};
    if (body.confirmed_cost) confirmedRecoverBody = body;
    else firstRecoverBody = body;
    await route.continue();
  });

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  await page.getByTestId('composer-input').fill('please fail then confirm recover');
  await page.getByTestId('composer-send').click();

  await expect(page.getByTestId('failure-decision-card')).toBeVisible({ timeout: 15_000 });
  await authedFetch(env, '/v1/memories', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      scope: 'global',
      key: 'cost_confirm_threshold_usd',
      value: '0.0000000001',
    }),
  });
  await page.getByTestId('fdc-retry').click();

  await expect(page.getByTestId('cost-confirm-dialog')).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId('cost-confirm-cheaper')).toBeDisabled();
  await page.getByTestId('cost-confirm-continue').click();
  await expect(page.getByTestId('cost-confirm-dialog')).not.toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('failure-decision-card')).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator('.msg.user')).toHaveCount(1);
  await expect(page.locator('.msg.assistant')).toHaveCount(2);
  await expect.poll(() => firstRecoverBody != null).toBe(true);
  await expect.poll(() => confirmedRecoverBody?.confirmed_cost).toBe(true);
});

test('M2.1 compact context button uses recover API and records compact_context run', async ({ page }) => {
  let recoverBody: { action?: string } | null = null;
  await page.route('**/v1/chat', async (route) => {
    const headers = { ...route.request().headers(), 'x-test-force-classification': 'rate_limit' };
    await route.continue({ headers });
  });
  await page.route('**/v1/runs/*/recover', async (route) => {
    const raw = route.request().postData();
    recoverBody = raw ? JSON.parse(raw) as { action?: string } : null;
    await route.continue();
  });

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  await page.getByTestId('composer-input').fill(
    '先失败，然后用 compact_context 压缩上下文后恢复',
  );
  await page.getByTestId('composer-send').click();

  await expect(page.getByTestId('failure-decision-card')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('fdc-compact')).toBeVisible();
  await page.getByTestId('fdc-compact').click();

  await expect(page.getByTestId('failure-decision-card')).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator('.msg.user')).toHaveCount(1);
  await expect(page.locator('.msg.assistant')).toHaveCount(2);
  await expect.poll(() => recoverBody?.action).toBe('compact_context');

  const convRes = await authedFetch(env, '/v1/conversations');
  const convBody = (await convRes.json()) as { conversations: Array<{ id: string }> };
  const conversationId = convBody.conversations[0]?.id;
  expect(conversationId).toBeTruthy();

  const runsRes = await authedFetch(env, `/v1/conversations/${conversationId}/runs?limit=5`);
  const runsBody = (await runsRes.json()) as {
    data: { runs: Array<{ recovery_policy: string | null; status: string }> };
  };
  expect(runsBody.data.runs[0]).toMatchObject({
    recovery_policy: 'compact_context',
    status: 'completed',
  });

  await page.getByTestId('open-run-timeline').click();
  const panel = page.getByTestId('run-timeline-panel');
  await expect(panel).toBeVisible({ timeout: 10_000 });
  const topRun = panel.getByTestId('run-group').first();
  await expect(topRun.locator('[data-testid="run-event"][data-kind="recovery.started"]')).toContainText(
    '恢复开始',
  );
  await expect(topRun.locator('[data-testid="run-event"][data-kind="turn.started"]')).toContainText(
    '压缩上下文重试开始',
  );
  await expect(topRun.locator('[data-testid="run-event"][data-kind="cost.recorded"]')).toContainText(
    'Cost',
  );

  await page.getByTestId('run-timeline-close').click();
  await page.getByTestId('open-cost-dashboard').click();
  const firstCall = page.getByTestId('cost-call-log-row').first();
  await expect(firstCall).toBeVisible({ timeout: 10_000 });
  await expect(firstCall.getByTestId('cost-call-run-link')).toContainText('Run');
  await expect(firstCall.getByTestId('cost-call-event-link')).toContainText('成本记录');
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

test('M2.1 starting a new chat clears stale failure_decision card', async ({ page }) => {
  await page.route('**/v1/chat', async (route) => {
    const headers = { ...route.request().headers(), 'x-test-force-classification': 'rate_limit' };
    await route.continue({ headers });
  });

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  await page.getByTestId('composer-input').fill('please fail then start over');
  await page.getByTestId('composer-send').click();

  await expect(page.getByTestId('failure-decision-card')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('sidebar-new').click();

  await expect(page.getByTestId('failure-decision-card')).toHaveCount(0);
  await expect(page.getByTestId('chat-panel')).toHaveAttribute('data-active-conv', '');
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
