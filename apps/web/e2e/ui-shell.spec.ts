import { test, expect } from '@playwright/test';
import { readSidecarEnv, resetSidecar, seedDefaultModel } from './_helpers';

test.beforeEach(async () => {
  const env = readSidecarEnv();
  await resetSidecar(env);
  await seedDefaultModel(env);
});

test('workspace tabs switch between chat and deep research', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 15_000 });

  // Default mode is chat
  await expect(page.locator('.workspace')).toHaveAttribute('data-workspace-mode', 'chat');
  await expect(page.getByTestId('workspace-tab-chat')).toHaveClass(/active/);
  await expect(page.getByTestId('research-center')).toBeHidden();

  // Switch to research
  await page.getByTestId('workspace-tab-research').click();
  await expect(page.locator('.workspace')).toHaveAttribute('data-workspace-mode', 'research');
  await expect(page.getByTestId('workspace-tab-research')).toHaveClass(/active/);
  await expect(page.getByTestId('research-center')).toBeVisible();
  await expect(page.getByTestId('chat-panel')).toBeHidden();

  // Reload preserves mode
  await page.reload();
  await expect(page.locator('.workspace')).toHaveAttribute('data-workspace-mode', 'research', {
    timeout: 10_000,
  });
  await expect(page.getByTestId('research-center')).toBeVisible();

  // Switch back to chat
  await page.getByTestId('workspace-tab-chat').click();
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
