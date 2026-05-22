import { test, expect } from '@playwright/test';

/**
 * Responsive layout: verify mobile hamburger menu and sidebar overlay.
 */
test.use({ viewport: { width: 375, height: 812 } });

test('mobile: sidebar hidden by default, opens via hamburger', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('.app');

  // Sidebar should NOT have 'open' class initially
  const side = page.locator('.side');
  await expect(side).not.toHaveClass(/open/);

  // Hamburger button is visible
  const hamburger = page.locator('.hdr-hamburger');
  await expect(hamburger).toBeVisible();

  // Click hamburger
  await hamburger.click();

  // Sidebar should now have 'open' class
  await expect(side).toHaveClass(/open/);

  // Backdrop should appear
  await expect(page.locator('.side-backdrop')).toBeVisible();
});

test('mobile: clicking sidebar item closes overlay', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('.app');
  await page.waitForTimeout(1500);

  // Open sidebar
  await page.locator('.hdr-hamburger').click();
  await expect(page.locator('.side')).toHaveClass(/open/);

  // Wait for sidebar items to render
  await page.waitForTimeout(500);

  // Need sidebar items to test the close-on-click behavior
  const sideItems = page.locator('.side .side-item');
  const count = await sideItems.count();
  if (count === 0) {
    // No items seeded - click in the right area (outside sidebar, where backdrop is visible)
    await page.mouse.click(300, 400); // sidebar is 280px wide on mobile
    await expect(page.locator('.side')).not.toHaveClass(/open/);
    return;
  }

  await sideItems.first().click();
  await expect(page.locator('.side')).not.toHaveClass(/open/);
});

test('mobile: footer version text is hidden', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('.foot');

  // .foot-version should be hidden on mobile
  await expect(page.locator('.foot-version')).toBeHidden();
});
