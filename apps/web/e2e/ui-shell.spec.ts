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

test('capability ribbon toggle collapses and restores, persisting choice', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 15_000 });

  // Default: ribbon expanded (preflight visible)
  const toggle = page.getByTestId('ribbon-toggle');
  await expect(toggle).toBeVisible();
  await expect(page.getByTestId('capability-preflight')).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');

  // Collapse
  await toggle.click();
  await expect(page.getByTestId('capability-preflight')).toBeHidden();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');

  // Persists after reload
  await page.reload();
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('capability-preflight')).toBeHidden();
  await expect(page.getByTestId('ribbon-toggle')).toHaveAttribute('aria-expanded', 'false');

  // Expand again
  await page.getByTestId('ribbon-toggle').click();
  await expect(page.getByTestId('capability-preflight')).toBeVisible();
});
