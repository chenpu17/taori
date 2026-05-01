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
});

test('D1 cost dashboard opens and supports scope/group switching', async ({ page }) => {
  await seedChatCost('cost dash one');
  await seedChatCost('cost dash two');

  await suppressTips(page);
  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await dismissTipsIfVisible(page);

  await page.getByTestId('open-cost-dashboard').click();
  await expect(page.getByTestId('cost-dashboard-panel')).toBeVisible();
  await expect(page.getByTestId('cost-dashboard-total')).toBeVisible();
  await expect(page.getByTestId('cost-dashboard-row').first()).toBeVisible();

  await page.getByTestId('cost-dashboard-group-conversation').click();
  await expect(page.getByTestId('cost-dashboard-group-conversation')).toHaveAttribute('data-active', '1');
  await expect(page.getByTestId('cost-dashboard-row')).toHaveCount(2);

  await page.getByTestId('cost-dashboard-group-feature').click();
  await expect(page.getByTestId('cost-dashboard-group-feature')).toHaveAttribute('data-active', '1');
  await expect(page.getByTestId('cost-dashboard-row').first()).toBeVisible();

  await page.getByTestId('cost-dashboard-scope-week').click();
  await expect(page.getByTestId('cost-dashboard-scope-week')).toHaveAttribute('data-active', '1');
  await expect(page.getByTestId('cost-dashboard-row').first()).toBeVisible();
});

test('D2 monthly budget shows one-time toast and gates next send after over-budget', async ({ page }) => {
  const env = readSidecarEnv();
  await seedChatCost('budget baseline');

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
  await expect(page.getByTestId('cost-bar')).toHaveAttribute('data-budget-level', 'over');

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
