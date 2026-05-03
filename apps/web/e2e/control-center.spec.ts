import { test, expect } from '@playwright/test';
import { readSidecarEnv, resetSidecar, seedDefaultModel } from './_helpers';

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
  await expect(page.getByTestId('settings-tool-builtin.web_search')).toBeVisible();

  await page.getByTestId('control-center-nav-costs').click();
  await expect(page.getByTestId('cost-dashboard-panel')).toBeVisible();
  await expect(page.getByTestId('cost-call-log')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('control-center')).toHaveCount(0);
});
