import { test } from '@playwright/test';
import path from 'path';

const dir = '/tmp/taori-ux-screenshots';

test.describe('UX improvement screenshots', () => {
  test.beforeEach(async ({ page }) => {
    // Login to sidecar
    await page.goto('http://localhost:5173');
    // Wait for auth redirect or main page
    await page.waitForTimeout(3000);

    // If redirected to login page, enter password
    const loginInput = page.locator('input[type="password"]');
    if (await loginInput.isVisible()) {
      await loginInput.fill('dev_cb9490fd2ec45e89ad2a88cb674b627fe97cb737f37adc962c8f18ab5e041a17');
      await page.locator('button[type="submit"]').click();
      await page.waitForTimeout(3000);
    }
  });

  test('01 main chat page with composer', async ({ page }) => {
    await page.screenshot({ path: path.join(dir, '01-main-chat.png') });
  });

  test('02 composer tools dropdown', async ({ page }) => {
    const btn = page.locator('[data-testid="composer-tools-toggle"]');
    if (await btn.isVisible()) {
      await btn.click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(dir, '02-composer-dropdown.png') });
    }
  });

  test('03 help center with quick compare FAQ', async ({ page }) => {
    const btn = page.locator('[data-testid="open-help"]');
    if (await btn.isVisible()) {
      await btn.click();
      await page.waitForTimeout(1000);
      await page.screenshot({ path: path.join(dir, '03-help-center.png') });
    }
  });

  test('04 command palette with groups', async ({ page }) => {
    await page.keyboard.press('Meta+k');
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(dir, '04-command-palette.png') });
  });

  test('05 settings general tab', async ({ page }) => {
    await page.keyboard.press('Escape');
    await page.keyboard.press('Meta+k');
    await page.waitForTimeout(500);
    await page.keyboard.type('设置');
    await page.waitForTimeout(500);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2000);
    await page.screenshot({ path: path.join(dir, '05-settings-general.png') });
  });

  test('06 sidebar with research labels', async ({ page }) => {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    // Take sidebar screenshot
    const sidebar = page.locator('.sidebar');
    if (await sidebar.isVisible()) {
      await sidebar.screenshot({ path: path.join(dir, '06-sidebar.png') });
    }
  });

  test('07 confirm dialog', async ({ page }) => {
    // Hover over first conversation to reveal actions
    const firstConv = page.locator('.conv-item').first();
    if (await firstConv.isVisible()) {
      await firstConv.hover();
      await page.waitForTimeout(500);
      const delBtn = page.locator('.conv-item').first().locator('[title="删除"], [data-testid="conv-delete"], button:has-text("删除")');
      if (await delBtn.isVisible()) {
        await delBtn.click();
        await page.waitForTimeout(800);
        await page.screenshot({ path: path.join(dir, '07-confirm-dialog.png') });
      } else {
        // Try clicking the three-dot or action area
        await firstConv.locator('.conv-actions, .conv-actions-toggle').first().click().catch(() => {});
        await page.waitForTimeout(500);
        await page.screenshot({ path: path.join(dir, '07-confirm-dialog.png') });
      }
    }
  });
});
