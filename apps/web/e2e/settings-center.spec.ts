import { expect, test } from '@playwright/test';
import { clearAllData, sidecarJson } from './test-api';

test('settings center: wizard, provider edit dialog, key revoke, appearance, general', async ({ page }) => {
  await clearAllData();

  await page.goto('/');
  await page.getByTestId('empty-no-model-cta').click();
  await expect(page.getByRole('heading', { name: '模型', exact: true })).toBeVisible();

  // 用 wizard 接入 OpenRouter 预设 → 故意提供错误 Key 让 discover 失败 → 退到手动
  await page.getByTestId('empty-add-model-cta').click();
  await expect(page.getByTestId('add-model-wizard')).toBeVisible();
  await page.getByTestId('wizard-preset-openrouter').click();
  await page.getByTestId('wizard-next').click();
  await page.getByTestId('wizard-api-key').fill('sk-bad-key-for-test');
  await page.getByTestId('wizard-connect').click();
  // 应该退到手动 fallback（discover 失败）
  await expect(page.getByTestId('wizard-manual-model-name')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('wizard-manual-model-name').fill('openrouter/auto');
  await page.getByTestId('wizard-manual-display-name').fill('OpenRouter Auto');
  await page.getByTestId('wizard-finish').click();
  await expect(page.locator('.toast').filter({ hasText: /已添加|已接入/ }).first()).toBeVisible({
    timeout: 10_000,
  });

  // 进入"服务商" tab，验证 Provider 卡的瘦身 + 编辑 Dialog
  await page.getByRole('button', { name: '服务商', exact: true }).click();
  const providerCard = page.locator('.provider-card', { hasText: 'OpenRouter' });
  await expect(providerCard).toBeVisible();
  // 主操作：发现模型 / 测试连接 直接可见
  await expect(providerCard.getByRole('button', { name: '测试连接' })).toBeVisible();
  await expect(providerCard.getByRole('button', { name: '发现模型' })).toBeVisible();
  // 测试连接（OpenRouter 走 sk-bad-key，会失败）
  await providerCard.getByRole('button', { name: '测试连接' }).click();
  await expect(
    page.locator('.toast').filter({ hasText: /ECONNREFUSED|fetch failed|测试失败|未授权|invalid|401|Authentication|Unauthorized/i }).first(),
  ).toBeVisible({ timeout: 10_000 });

  // 编辑入口移到 ⋯ 菜单
  await providerCard.locator('details summary').click();
  await page.getByRole('menuitem', { name: /编辑名称/ }).click();
  await expect(page.getByTestId('provider-edit-dialog')).toBeVisible();
  await page
    .getByTestId('provider-edit-dialog')
    .getByPlaceholder('名称')
    .fill('OpenRouter（已重命名）');
  await page.getByTestId('provider-edit-dialog').getByRole('button', { name: '保存' }).click();
  await expect(page.locator('.toast').filter({ hasText: '已保存' }).first()).toBeVisible();
  await expect(page.locator('.provider-card', { hasText: 'OpenRouter（已重命名）' })).toBeVisible();

  // 外观：dark + comfy
  await page.getByRole('button', { name: '外观', exact: true }).click();
  await expect(page.getByRole('heading', { name: '外观', exact: true })).toBeVisible();
  await page.getByTestId('theme-dark').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: '宽松' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-density', 'comfy');

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('html')).toHaveAttribute('data-density', 'comfy');

  // 通用 tab 基础内容渲染
  await page.getByRole('button', { name: '设置' }).first().click();
  await page.getByRole('button', { name: '通用', exact: true }).click();
  await expect(page.getByRole('heading', { name: '通用', exact: true })).toBeVisible();
  await expect(page.getByText('发送消息')).toBeVisible();
  await expect(page.getByText('换行')).toBeVisible();

  // 删除 Provider 走自定义 Dialog（菜单 → 删除整个服务商 → Dialog 确认）
  await page.getByRole('button', { name: '服务商', exact: true }).click();
  const renamedCard = page.locator('.provider-card', { hasText: 'OpenRouter（已重命名）' });
  await renamedCard.locator('details summary').click();
  await page.getByRole('menuitem', { name: '删除整个服务商' }).click();
  await expect(page.getByTestId('app-dialog')).toContainText('删除服务商');
  await page.getByTestId('app-dialog-ok').click();
  await expect(page.locator('.toast').filter({ hasText: '已删除' }).first()).toBeVisible();
});
