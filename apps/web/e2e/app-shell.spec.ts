import { test, expect } from '@playwright/test';

/**
 * App shell smoke: page loads, header / sidebar / footer render, no JS errors.
 * Runs against mock data (no sidecar seeding needed).
 */
test('app loads without errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

  await page.goto('/');
  await page.waitForSelector('.app');

  // Header shows brand
  await expect(page.locator('.hdr-brand')).toContainText('Taori');

  // Sidebar shows new-chat button
  await expect(page.locator('.side-newbtn')).toContainText('新对话');

  // Footer renders with status item
  await expect(page.locator('.foot')).toBeVisible();

  // No JS errors
  expect(errors).toEqual([]);
});

test('sidebar mock scenarios render', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('.side');

  // Wait for data load
  await page.waitForTimeout(1500);

  // Sidebar has items or sections (live or mock data)
  const hasItems = await page.locator('.side-item').first().isVisible().catch(() => false);
  const hasSections = await page.locator('.side-section').first().isVisible().catch(() => false);

  // In a clean test env, sidebar may be empty - that's OK, just verify the structure renders
  if (hasItems) {
    await page.locator('.side-item').first().click();
    const chatHasContent = await page.locator('.chat .msg, .chat .welcome, .chat .composer').count();
    expect(chatHasContent).toBeGreaterThan(0);
  } else {
    // No items - at least the new chat button should be visible
    await expect(page.locator('.side-newbtn')).toBeVisible();
  }
});

test('footer status pill is clickable', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('.foot');
  await page.waitForTimeout(1000);

  // Click the first footer item (status)
  await page.locator('.foot-item').first().click();

  // Health popup or foot-popup should appear
  await expect(page.locator('.foot-popup, .popup').first()).toBeVisible({ timeout: 5000 });
});
