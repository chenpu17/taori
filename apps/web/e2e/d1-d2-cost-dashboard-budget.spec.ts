import { test, expect, type Page } from '@playwright/test';
import { authedFetch, readSidecarEnv, resetSidecar, seedDefaultModel } from './_helpers';

async function getDefaultModelId(): Promise<string> {
  const env = readSidecarEnv();
  const res = await authedFetch(env, '/v1/models');
  const body = (await res.json()) as { models: Array<{ id: string }> };
  return body.models[0]!.id;
}

async function seedChatCost(content: string): Promise<string | null> {
  const env = readSidecarEnv();
  const modelId = await getDefaultModelId();
  const res = await authedFetch(env, '/v1/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model_id: modelId,
      messages: [{ role: 'user', content }],
    }),
  });
  const payload = await res.text();
  const metaLine = payload
    .split('\n')
    .find((line) => line.startsWith('8:') && line.includes('"conversation_id"'));
  if (!metaLine) return null;
  const annotations = JSON.parse(metaLine.slice(2)) as Array<Record<string, unknown>>;
  const meta = annotations.find((item) => item.type === 'meta');
  return typeof meta?.conversation_id === 'string' ? (meta.conversation_id as string) : null;
}

async function dismissTipsIfVisible(page: Page): Promise<void> {
  const button = page.getByTestId('tip-got-it');
  if (await button.count()) {
    await button.click();
  }
}

async function suppressTips(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('tip_image_first_seen', 'true');
    localStorage.setItem('tip_fallback_first_seen', 'true');
    localStorage.setItem('tip_cost_first_seen', 'true');
    localStorage.setItem('tip_roundtable_first_seen', 'true');
  });
}

test.beforeEach(async () => {
  const env = readSidecarEnv();
  await resetSidecar(env);
  await seedDefaultModel(env);
  await authedFetch(env, '/v1/memories?scope=global&key=monthly_budget_usd', {
    method: 'DELETE',
  });
  await authedFetch(env, '/v1/memories?scope=global&key=monthly_budget_alert_state', {
    method: 'DELETE',
  });
  await authedFetch(env, '/v1/memories?scope=global&key=monthly_budget_hard_limit', {
    method: 'DELETE',
  });
});

test('D1 cost dashboard opens and supports scope/group switching', async ({ page }) => {
  const env = readSidecarEnv();
  const convOne = await seedChatCost('cost dash one');
  const convTwo = await seedChatCost('cost dash two');
  const providersRes = await authedFetch(env, '/v1/providers');
  const providersBody = (await providersRes.json()) as { providers: Array<{ id: string }> };
  const providerId = providersBody.providers[0]!.id;
  await authedFetch(env, '/v1/models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider_id: providerId,
      model_name: 'mock-cheap-model',
      capability: 'chat',
      display_name: 'Mock cheap',
      price_input_per_1m: 0.1,
      price_output_per_1m: 0.2,
    }),
  });
  if (convOne) {
    await authedFetch(env, `/v1/conversations/${convOne}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tags: ['project-alpha', 'frontend'] }),
    });
  }
  if (convTwo) {
    await authedFetch(env, `/v1/conversations/${convTwo}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tags: ['project-beta'] }),
    });
  }

  await suppressTips(page);
  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await dismissTipsIfVisible(page);

  await page.getByTestId('open-cost-dashboard').click();
  await expect(page.getByTestId('cost-dashboard-panel')).toBeVisible();
  await expect
    .poll(async () =>
      page.getByTestId('cost-dashboard-export-csv').evaluate((el) => {
        const style = getComputedStyle(el);
        return style.borderRadius === '10px' && style.minHeight === '40px';
      }),
    )
    .toBe(true);
  await expect
    .poll(async () =>
      page.getByTestId('cost-dashboard-refresh').evaluate((el) =>
        getComputedStyle(el).backgroundImage !== 'none',
      ),
    )
    .toBe(true);
  await expect(page.getByTestId('cost-dashboard-total')).toBeVisible();
  await expect(page.getByTestId('cost-dashboard-advisor')).toBeVisible();
  await expect(page.getByTestId('cost-dashboard-advisor')).toContainText('可先试的低成本替代');
  await expect(page.getByTestId('cost-dashboard-advisor')).toContainText('Mock cheap');
  await expect(page.getByTestId('cost-dashboard-provider-breakdown')).toBeVisible();
  await expect(page.getByTestId('cost-dashboard-provider-breakdown')).toContainText('M0 mock provider');
  await page.getByTestId('cost-dashboard-provider-card').first().getByRole('button', { name: '只看这个 Provider' }).click();
  await expect(page.getByTestId('cost-dashboard-provider-focus-banner')).toBeVisible();
  await expect(page.getByTestId('cost-dashboard-row').first()).toBeVisible();
  await page.getByTestId('cost-dashboard-provider-focus-clear').click();
  await page.getByTestId('cost-dashboard-row-drilldown').first().click();
  await expect(page.getByTestId('cost-dashboard-model-focus-banner')).toBeVisible();
  await expect(page.getByTestId('cost-dashboard-model-focus-banner')).toContainText('24h');
  await expect(page.locator('[data-testid="cost-dashboard-row"][data-focused="1"]').first()).toBeVisible();
  await page.getByTestId('cost-dashboard-model-focus-open-provider').click();
  await expect(page.getByTestId('cost-dashboard-provider-focus-banner')).toBeVisible();
  await page.getByTestId('cost-dashboard-provider-focus-clear').click();
  await page.getByTestId('cost-dashboard-row-drilldown').first().click();
  const firstCall = page.getByTestId('cost-call-log-row').first();
  await expect(firstCall).toBeVisible();
  await firstCall.getByTestId('cost-call-focus-model').click();
  await expect(page.getByTestId('cost-dashboard-model-focus-banner')).toBeVisible();
  await expect(page.locator('[data-testid="cost-call-log-row"][data-focused="1"]').first()).toBeVisible();
  await firstCall.getByTestId('cost-call-focus-provider').click();
  await expect(page.getByTestId('cost-dashboard-provider-focus-banner')).toBeVisible();
  await expect(firstCall.getByTestId('cost-call-source-id')).toContainText('Cost');
  await expect(firstCall.getByTestId('cost-call-run-link')).toContainText('Run');
  await expect(firstCall.getByTestId('cost-call-event-link')).toContainText('成本记录');
  await firstCall.getByTestId('cost-call-focus-run').click();
  await expect(page.getByTestId('control-center')).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByTestId('run-timeline-panel')).toBeVisible({ timeout: 10_000 });
  await expect(
    page.locator('[data-testid="run-event"][data-kind="cost.recorded"][data-focused="1"]'),
  ).toBeVisible({ timeout: 10_000 });
  await page
    .locator('[data-testid="run-event"][data-kind="cost.recorded"][data-focused="1"]')
    .getByTestId('run-event-focus-cost')
    .click();
  await expect(page.getByTestId('control-center')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('cost-dashboard-panel')).toBeVisible();
  await expect(
    page.locator('[data-testid="cost-call-log-row"][data-focused="1"]'),
  ).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('run-timeline-panel')).toHaveCount(0);

  await expect(page.getByTestId('cost-dashboard-panel')).toBeVisible();

  await page.getByTestId('cost-dashboard-group-conversation').click();
  await expect(page.getByTestId('cost-dashboard-group-conversation')).toHaveAttribute('data-active', '1');
  await expect(page.getByTestId('cost-dashboard-row')).toHaveCount(2);

  await page.getByTestId('cost-dashboard-group-feature').click();
  await expect(page.getByTestId('cost-dashboard-group-feature')).toHaveAttribute('data-active', '1');
  await expect(page.getByTestId('cost-dashboard-row').first()).toBeVisible();

  await page.getByTestId('cost-dashboard-scope-week').click();
  await expect(page.getByTestId('cost-dashboard-scope-week')).toHaveAttribute('data-active', '1');
  await expect(page.getByTestId('cost-dashboard-row').first()).toBeVisible();

  await page.getByTestId('cost-dashboard-group-tag').click();
  await expect(page.getByTestId('cost-dashboard-group-tag')).toHaveAttribute('data-active', '1');
  await expect(page.getByTestId('cost-dashboard-tag-hint')).toContainText('均分归因');
  await expect(page.getByTestId('cost-dashboard-panel')).toContainText('折算');
  await expect(page.getByTestId('cost-dashboard-panel')).toContainText('project-alpha');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('cost-dashboard-export-csv').click(),
  ]);
  expect(download.suggestedFilename()).toContain('taori-costs-tag-week.csv');
});

test('D2 monthly budget shows one-time toast and gates next send after over-budget', async ({ page }) => {
  const env = readSidecarEnv();
  await seedChatCost('budget baseline');
  const providersRes = await authedFetch(env, '/v1/providers');
  const providersBody = (await providersRes.json()) as { providers: Array<{ id: string }> };
  await authedFetch(env, '/v1/models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider_id: providersBody.providers[0]!.id,
      model_name: 'budget-cheap-model',
      capability: 'chat',
      display_name: 'Budget Cheap',
      price_input_per_1m: 0.05,
      price_output_per_1m: 0.1,
    }),
  });

  await suppressTips(page);
  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await dismissTipsIfVisible(page);

  const realtimeRes = await authedFetch(env, '/v1/costs/realtime');
  const realtime = (await realtimeRes.json()) as {
    ok: boolean;
    data: { month_usd: number };
  };
  const monthlyBudget = Math.max(realtime.data.month_usd / 2, 0.000001);
  await authedFetch(env, '/v1/memories', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      scope: 'global',
      scope_id: null,
      key: 'monthly_budget_usd',
      value: String(monthlyBudget),
    }),
  });
  await authedFetch(env, '/v1/memories?scope=global&key=monthly_budget_alert_state', {
    method: 'DELETE',
  });

  await page.reload();
  await dismissTipsIfVisible(page);
  await expect(page.getByTestId('budget-toast')).toContainText('100%', { timeout: 5_000 });
  await expect(page.getByTestId('budget-toast-open-costs')).toBeVisible();
  await expect(page.getByTestId('budget-toast-switch-cheaper')).toContainText('Budget Cheap');
  await expect(page.getByTestId('cost-bar')).toHaveAttribute('data-budget-level', 'over');
  await page.getByTestId('budget-toast-open-costs').click();
  await expect(page.getByTestId('control-center')).toBeVisible();
  await expect(page.getByTestId('control-center-nav-costs')).toHaveClass(/active/);
  await expect(page.getByTestId('cost-dashboard-model-focus-banner')).toBeVisible();
  await expect(page.locator('[data-testid="cost-dashboard-row"][data-focused="1"]').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('control-center')).toHaveCount(0);
  await page.getByTestId('open-settings').click();
  await expect(page.getByTestId('control-center')).toBeVisible();
  await page.getByTestId('control-center-nav-overview').click();
  await expect(page.getByTestId('control-budget-alerts')).toContainText('本月预算已超出');
  await page.getByTestId('control-center-nav-costs').click();
  await expect(page.getByTestId('cost-dashboard-budget-alerts')).toContainText('本月预算已超出');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('control-center')).toHaveCount(0);

  await page.reload();
  await dismissTipsIfVisible(page);
  await expect(page.getByTestId('budget-toast')).toHaveCount(0);

  await page.getByTestId('composer-input').fill('should be gated');
  await page.getByTestId('composer-send').click();
  await expect(page.getByTestId('cost-confirm-dialog')).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId('cost-confirm-dialog')).toContainText('本月预算已达');
  await page.getByTestId('cost-confirm-cancel').click();
  await expect(page.getByTestId('cost-confirm-dialog')).toHaveCount(0);
});
