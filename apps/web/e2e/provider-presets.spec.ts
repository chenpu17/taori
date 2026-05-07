import { test, expect } from '@playwright/test';
import { resetSidecar, readSidecarEnv } from './_helpers';

test.beforeEach(async () => {
  await resetSidecar(readSidecarEnv());
});

test('onboarding exposes PackyAPI and SiliconFlow presets with default base URLs', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('onboarding')).toBeVisible({ timeout: 10_000 });

  const select = page.getByTestId('onb-provider-type');

  await expect(select.locator('option', { hasText: 'DeepSeek 官方' })).toHaveCount(1);
  await select.selectOption('deepseek');
  await expect(page.getByTestId('onb-provider-name')).toHaveValue('DeepSeek 官方');
  await expect(page.getByTestId('onb-base-url')).toHaveValue('https://api.deepseek.com');

  await expect(select.locator('option', { hasText: 'PackyAPI / PackyCode' })).toHaveCount(1);
  await select.selectOption('packyapi');
  await expect(page.getByTestId('onb-provider-name')).toHaveValue('PackyAPI / PackyCode');
  await expect(page.getByTestId('onb-base-url')).toHaveValue('https://www.packyapi.com/v1');

  await expect(select.locator('option', { hasText: '硅基流动 SiliconFlow' })).toHaveCount(1);
  await select.selectOption('siliconflow');
  await expect(page.getByTestId('onb-provider-name')).toHaveValue('硅基流动 SiliconFlow');
  await expect(page.getByTestId('onb-base-url')).toHaveValue('https://api.siliconflow.cn/v1');
});
