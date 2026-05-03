import { test, expect } from '@playwright/test';
import { readSidecarEnv, resetSidecar, seedDefaultModel } from './_helpers';

test.beforeEach(async () => {
  const env = readSidecarEnv();
  await resetSidecar(env);
  await seedDefaultModel(env);
});

test('composer Enter does not submit while confirming IME composition', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  const input = page.getByTestId('composer-input');
  await input.fill('ni');

  await input.evaluate((el) => {
    el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    el.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        bubbles: true,
        cancelable: true,
      }),
    );
  });

  await expect(page.locator('.msg.user')).toHaveCount(0);

  await input.evaluate((el) => {
    el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '你' }));
    el.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        bubbles: true,
        cancelable: true,
      }),
    );
  });

  await expect(page.locator('.msg.user')).toHaveCount(0);

  await input.fill('你好');
  await page.waitForTimeout(150);
  await input.press('Enter');

  await expect(page.locator('.msg.user')).toContainText('你好');
});
