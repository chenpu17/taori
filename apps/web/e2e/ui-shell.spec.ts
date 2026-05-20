import { test, expect } from '@playwright/test';
import { readSidecarEnv, resetSidecar, seedDefaultModel } from './_helpers';

test.beforeEach(async () => {
  const env = readSidecarEnv();
  await resetSidecar(env);
  await seedDefaultModel(env);
});

test('composer can switch between chat and deep research in one shell', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 15_000 });

  // Default mode is chat
  await expect(page.locator('.workspace')).toHaveAttribute('data-workspace-mode', 'chat');
  await expect(page.getByTestId('research-center')).toBeHidden();

  await page.getByTestId('composer-input').fill('分析 AI Coding 工具趋势');
  await page.getByTestId('composer-tools-toggle').click();
  await expect(page.getByTestId('composer-deep-research')).toBeVisible();
  await page.getByTestId('composer-deep-research').click();
  await expect(page.locator('.workspace')).toHaveAttribute('data-workspace-mode', 'research');
  await expect(page.getByTestId('research-center')).toBeVisible();
  await expect(page.getByTestId('chat-panel')).toBeHidden();
  await expect(page.getByTestId('research-input-objective')).toHaveValue('分析 AI Coding 工具趋势');

  // Switch back to chat
  await page.getByTestId('sidebar-new').click();
  await expect(page.locator('.workspace')).toHaveAttribute('data-workspace-mode', 'chat');
  await expect(page.getByTestId('chat-panel')).toBeVisible();
  await expect(page.getByTestId('research-center')).toBeHidden();
});

test('command palette opens deep research with current composer text', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 15_000 });

  await page.getByTestId('composer-input').fill('比较 2026 年桌面 AI 助手的产品机会');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
  await expect(page.getByTestId('cmd-palette-input')).toBeVisible();
  await page.getByTestId('cmd-palette-input').fill('深度研究');
  await expect(page.getByTestId('cmd-result').filter({ hasText: '进入深度研究' })).toBeVisible();
  await page.keyboard.press('Enter');

  await expect(page.locator('.workspace')).toHaveAttribute('data-workspace-mode', 'research');
  await expect(page.getByTestId('research-center')).toBeVisible();
  await expect(page.getByTestId('research-input-objective')).toHaveValue('比较 2026 年桌面 AI 助手的产品机会');
  await expect(page.getByTestId('chat-panel')).toBeHidden();
});

test('capability ribbon toggle collapses and restores, persisting choice', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 15_000 });

  // Default: ribbon collapsed so the chat shell matches the quiet design surface.
  const toggle = page.getByTestId('ribbon-toggle');
  await expect(toggle).toBeVisible();
  await expect(page.getByTestId('capability-preflight')).toBeHidden();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');

  // Expand
  await toggle.click();
  await expect(page.getByTestId('capability-preflight')).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');

  // Collapse again

  await toggle.click();
  await expect(page.getByTestId('capability-preflight')).toBeHidden();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await page.reload();
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('capability-preflight')).toBeHidden();
  await expect(page.getByTestId('ribbon-toggle')).toHaveAttribute('aria-expanded', 'false');

  // Expand again
  await page.getByTestId('ribbon-toggle').click();
  await expect(page.getByTestId('capability-preflight')).toBeVisible();
});
