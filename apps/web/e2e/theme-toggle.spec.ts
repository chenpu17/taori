import { test, expect } from '@playwright/test';
import { readSidecarEnv, resetSidecar, seedDefaultModel } from './_helpers';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOTS_DIR = path.resolve(HERE, '..', 'test-results', 'theme');

/**
 * Theme toggle + visual polish smoke.
 *
 * - Verifies the in-header ThemeToggle exists and switches `data-theme`
 *   on <html> for all three states (light / system / dark).
 * - Confirms the chosen theme survives a full reload (localStorage path).
 * - Captures full-page screenshots of the chat shell in both light and dark
 *   so the human reviewer can sanity-check the visual polish.
 */

test.beforeEach(async () => {
  const env = readSidecarEnv();
  await resetSidecar(env);
  await seedDefaultModel(env);
});

test('theme toggle: switches data-theme and persists across reload', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 15_000 });

  const html = page.locator('html');
  const toggle = page.getByTestId('theme-toggle');
  await expect(toggle).toBeVisible();

  // Default: system (set pre-mount in main.tsx).
  await expect(html).toHaveAttribute('data-theme', /system|dark|light/);

  // Force light, capture screenshot.
  await page.getByTestId('theme-toggle-light').click();
  await expect(html).toHaveAttribute('data-theme', 'light');
  await expect(page.getByTestId('theme-toggle-light')).toHaveAttribute('aria-checked', 'true');
  // Wait briefly for the CSS transition so the screenshot is steady.
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(SHOTS_DIR, 'light.png'), fullPage: true });

  // Switch to dark.
  await page.getByTestId('theme-toggle-dark').click();
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByTestId('theme-toggle-dark')).toHaveAttribute('aria-checked', 'true');
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(SHOTS_DIR, 'dark.png'), fullPage: true });

  // Reload — preference should stick.
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByTestId('theme-toggle-dark')).toHaveAttribute('aria-checked', 'true');

  // Back to system.
  await page.getByTestId('theme-toggle-system').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'system');
});

test('theme toggle: dark palette actually changes background', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 15_000 });

  await page.getByTestId('theme-toggle-light').click();
  await page.waitForTimeout(300);
  const lightBg = await page.evaluate(
    () => getComputedStyle(document.body).backgroundColor,
  );

  await page.getByTestId('theme-toggle-dark').click();
  await page.waitForTimeout(300);
  const darkBg = await page.evaluate(
    () => getComputedStyle(document.body).backgroundColor,
  );

  expect(lightBg).not.toBe(darkBg);

  // Light should be brighter than dark on the green channel (a cheap proxy).
  const lum = (rgb: string): number => {
    const m = rgb.match(/\d+/g);
    if (!m) return 0;
    const [r, g, b] = m.map(Number);
    return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
  };
  expect(lum(lightBg)).toBeGreaterThan(lum(darkBg));
});
