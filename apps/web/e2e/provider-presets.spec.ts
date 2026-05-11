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
  await expect(page.getByTestId('onb-provider-note')).toContainText('国内直连');
  await expect(page.getByTestId('onb-provider-note')).toContainText('OpenRouter');
  await expect(page.getByTestId('onb-provider-note')).toContainText('DeepSeek 官方');

  await expect(select.locator('option', { hasText: 'PackyAPI / PackyCode' })).toHaveCount(1);
  await select.selectOption('packyapi');
  await expect(page.getByTestId('onb-provider-name')).toHaveValue('PackyAPI / PackyCode');
  await expect(page.getByTestId('onb-base-url')).toHaveValue('https://www.packyapi.com/v1');

  await expect(select.locator('option', { hasText: '硅基流动 SiliconFlow' })).toHaveCount(1);
  await select.selectOption('siliconflow');
  await expect(page.getByTestId('onb-provider-name')).toHaveValue('硅基流动 SiliconFlow');
  await expect(page.getByTestId('onb-base-url')).toHaveValue('https://api.siliconflow.cn/v1');

  await expect(select.locator('option[value="aliyun-bailian"]')).toHaveText('阿里云百炼');
  await expect(select.locator('option[value="zhipu-glm"]')).toHaveText('智谱 GLM');
  await expect(select.locator('option[value="minimax"]')).toHaveText('MiniMax');
  await expect(select.locator('option[value="kimi"]')).toHaveText('Kimi');

  await select.selectOption('aliyun-bailian');
  await expect(page.getByTestId('onb-provider-name')).toHaveValue('阿里云百炼');
  await expect(page.getByTestId('onb-base-url')).toHaveValue('https://dashscope.aliyuncs.com/compatible-mode/v1');
  await expect(page.getByTestId('onb-provider-note')).toContainText('兼容接入');

  await select.selectOption('custom');
  await expect(page.getByTestId('onb-provider-note')).toContainText('兼容接入');
  await expect(page.getByTestId('onb-provider-note')).toContainText('阿里云百炼');
  await expect(page.getByTestId('onb-provider-note')).toContainText('Kimi');
  await expect(page.getByTestId('onb-provider-note')).toContainText('MiniMax');
  await expect(page.getByTestId('onb-compat-templates')).toBeVisible();

  await page.getByTestId('onb-compat-template-aliyun-bailian').click();
  await expect(page.getByTestId('onb-provider-name')).toHaveValue('阿里云百炼');
  await expect(page.getByTestId('onb-base-url')).toHaveValue('https://dashscope.aliyuncs.com/compatible-mode/v1');

  await page.getByTestId('onb-compat-template-zhipu-glm').click();
  await expect(page.getByTestId('onb-provider-name')).toHaveValue('智谱 GLM');
  await expect(page.getByTestId('onb-base-url')).toHaveValue('https://open.bigmodel.cn/api/paas/v4');

  await page.getByTestId('onb-compat-template-minimax').click();
  await expect(page.getByTestId('onb-provider-name')).toHaveValue('MiniMax');
  await expect(page.getByTestId('onb-base-url')).toHaveValue('https://api.minimax.chat/v1');

  await page.getByTestId('onb-compat-template-kimi').click();
  await expect(page.getByTestId('onb-provider-name')).toHaveValue('Kimi');
  await expect(page.getByTestId('onb-base-url')).toHaveValue('https://api.moonshot.cn/v1');
});
