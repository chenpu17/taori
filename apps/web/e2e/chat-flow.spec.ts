import { test, expect } from '@playwright/test';
import { readSidecarEnv, resetSidecar, seedDefaultModel } from './_helpers';

/**
 * Live chat round-trip: seed a provider + model, send a message, see response.
 * Requires the test sidecar (started by global-setup) with a mock provider
 * that echoes or returns a canned response.
 */
test.beforeEach(async () => {
  const env = readSidecarEnv();
  await resetSidecar(env);
  await seedDefaultModel(env);
});

test('composer sends message and shows user bubble', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto('/');

  // Wait for footer to show some status (sidecar reachable or not)
  await expect(page.locator('.foot')).toBeVisible({ timeout: 10_000 });

  // Wait for sidebar to populate with live conversations (or show empty state)
  await page.waitForSelector('.side', { timeout: 10_000 });

  // Composer should be visible
  const textarea = page.locator('.composer-input');
  await expect(textarea).toBeVisible({ timeout: 10_000 });

  // Type a message
  await textarea.fill('hello from e2e');
  await expect(textarea).toHaveValue('hello from e2e');

  // Send via Enter key
  await textarea.press('Enter');

  // User message should appear in chat
  await expect(page.locator('.msg').first()).toContainText('hello from e2e', { timeout: 10_000 });

  // No page errors
  expect(errors).toEqual([]);
});

test('composer send button click works', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.foot')).toBeVisible({ timeout: 10_000 });

  const textarea = page.locator('.composer-input');
  await expect(textarea).toBeVisible({ timeout: 10_000 });

  await textarea.fill('click test');

  // Click send button
  await page.locator('.composer-send').click();

  // Message appears
  await expect(page.locator('.msg').first()).toContainText('click test', { timeout: 10_000 });
});

test('new chat button clears conversation', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.foot')).toBeVisible({ timeout: 10_000 });

  // Send a message first
  const textarea = page.locator('.composer-input');
  await expect(textarea).toBeVisible({ timeout: 10_000 });
  await textarea.fill('first message');
  await textarea.press('Enter');
  await expect(page.locator('.msg').first()).toContainText('first message', { timeout: 10_000 });

  // Click new chat
  await page.locator('.side-newbtn').click();

  // Welcome screen should appear (no active conversation)
  await expect(page.locator('.welcome')).toBeVisible({ timeout: 5_000 });
});
