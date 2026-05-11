import { test, expect } from '@playwright/test';
import { authedFetch, readSidecarEnv, resetSidecar, seedDefaultModel } from './_helpers';

test.beforeEach(async () => {
  const env = readSidecarEnv();
  await resetSidecar(env);
  await seedDefaultModel(env);
});

test('control center unifies settings, models, tools and costs behind one navigable surface', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  await page.getByTestId('open-settings').click();
  await expect(page.getByTestId('control-center')).toBeVisible();
  await expect(page.getByTestId('settings-add-provider')).toBeVisible();

  await page.getByTestId('control-center-nav-models').click();
  await expect(page.getByTestId('model-center')).toBeVisible();
  await expect(page.getByTestId('model-center-providers')).toBeVisible();

  await page.getByTestId('settings-tab-tools').click();
  await expect(page.getByTestId('settings-tools')).toBeVisible();
  await expect(page.getByTestId('settings-search-builtin')).toBeVisible();

  await page.getByTestId('control-center-nav-costs').click();
  await expect(page.getByTestId('cost-dashboard-panel')).toBeVisible();
  await expect(page.getByTestId('cost-call-log')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('control-center')).toHaveCount(0);
});

test('control center overview surfaces model and tool health summaries', async ({ page }) => {
  const env = readSidecarEnv();
  const modelRes = await authedFetch(env, '/v1/models');
  const modelBody = (await modelRes.json()) as { models: Array<{ id: string }> };
  const modelId = modelBody.models[0]!.id;

  await authedFetch(env, '/v1/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model_id: modelId,
      messages: [{ role: 'user', content: 'control overview health success' }],
    }),
  }).then((res) => res.text());
  await authedFetch(env, '/v1/chat', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-test-force-classification': 'rate_limit',
    },
    body: JSON.stringify({
      model_id: modelId,
      messages: [{ role: 'user', content: 'control overview health failure' }],
    }),
  }).then((res) => res.text());

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  await page.getByTestId('open-settings').click();
  await page.getByTestId('control-center-nav-overview').click();
  await expect(page.getByTestId('control-center-overview')).toBeVisible();
  await expect(page.getByTestId('control-budget-overview')).toBeVisible();
  const providerRiskQueue = page.getByTestId('control-provider-risk-queue');
  await expect(providerRiskQueue).toContainText('缺少可用 Key');
  await expect(providerRiskQueue).toContainText('补 Provider Key');
  await expect(page.getByTestId('control-cost-attribution-overview')).toBeVisible();
  await expect(page.getByTestId('control-health-overview')).toBeVisible();
  await expect(page.getByTestId('control-health-wall-actions')).toContainText('失败率偏高');
  await page.getByTestId('control-health-wall-action-cost-risky').click();
  await expect(page.getByTestId('cost-dashboard-panel')).toBeVisible();
  await expect(page.getByTestId('cost-dashboard-model-focus-banner')).toBeVisible();
  await page.getByTestId('cost-dashboard-model-focus-open-models').click();
  await expect(page.getByTestId('model-center')).toBeVisible();
  await page.getByTestId('control-center-nav-overview').click();
  await page.getByTestId('control-health-wall-action-cost-risky').click();
  await expect(page.getByTestId('cost-dashboard-model-focus-banner')).toBeVisible();
  await page.getByTestId('cost-dashboard-model-focus-open-provider').click();
  await expect(page.getByTestId('cost-dashboard-provider-focus-banner')).toBeVisible();
  await expect(page.locator('[data-testid="cost-dashboard-provider-card"][data-focused="1"]').first()).toBeVisible();
  await page.getByTestId('control-center-nav-overview').click();
  await page.getByTestId('control-center-nav-overview').click();
  await expect(page.getByTestId('control-model-health-calls')).toHaveText('2');
  await expect(page.getByTestId('control-model-health-failures')).toHaveText('1');
  await expect(page.getByTestId('control-model-health-affected')).toHaveText('1');
  await expect(page.getByTestId('control-model-health-last-failure')).toContainText('限流');

  await expect(page.getByTestId('control-tool-health-calls')).toHaveText('0');
  await expect(page.getByTestId('control-tool-health-failures')).toHaveText('0');
  await expect(page.getByTestId('control-tool-health-affected')).toHaveText('0');
  await expect(page.getByTestId('control-tool-health-last-failure')).toHaveText('无');

  await providerRiskQueue.getByRole('button', { name: '看成本影响' }).first().click();
  await expect(page.getByTestId('cost-dashboard-panel')).toBeVisible();
  await expect(page.getByTestId('cost-dashboard-provider-focus-banner')).toBeVisible();
  const focusedProviderCard = page.locator('[data-testid="cost-dashboard-provider-card"][data-focused="1"]').first();
  await expect(focusedProviderCard).toBeVisible();
  await focusedProviderCard.getByRole('button', { name: '去模型中心' }).click();
  await expect(page.getByTestId('model-center')).toBeVisible();

  await page.getByTestId('control-center-nav-overview').click();
  await page.getByTestId('control-health-open-models').click();
  await expect(page.getByTestId('model-center')).toBeVisible();
});
