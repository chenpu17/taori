import { expect, test } from '@playwright/test';
import { clearAllData } from './test-api';

test('织 empty state and settings entry render', async ({ page }) => {
  // Isolate from other specs sharing the worker's sidecar: the empty-state and
  // provider-empty CTA assertions below require a clean database.
  await clearAllData();
  await page.goto('/');

  // Empty state landing
  await expect(page.getByRole('heading', { name: /早上好|中午好|下午好|晚上好|夜深了/ })).toBeVisible();
  await expect(page.getByPlaceholder('问点什么，或粘贴一段文字开始…')).toBeVisible();

  // Suggestion cards
  await expect(page.getByText('帮我写一封婉拒会议邀请的邮件')).toBeVisible();

  // Sidebar new-chat button + brand
  await expect(page.getByRole('button', { name: /新对话/ }).first()).toBeVisible();

  // Open settings via the bottom-left settings icon button
  await page.getByRole('button', { name: '设置' }).first().click();
  await expect(page.getByRole('heading', { name: '模型', exact: true })).toBeVisible();

  // Switch to 服务商 tab and confirm the new empty CTA + unified wizard entry render
  await page.getByRole('button', { name: '服务商', exact: true }).click();
  await expect(page.getByRole('heading', { name: '服务商', exact: true })).toBeVisible();
  await expect(page.getByTestId('provider-empty-cta')).toBeVisible();
  await expect(page.getByTestId('provider-add')).toBeVisible();

  // Switch to Appearance tab and toggle dark theme
  await page.getByRole('button', { name: '外观', exact: true }).click();
  await page.getByTestId('theme-dark').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  // Back to light to leave a clean state
  await page.getByTestId('theme-light').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});
