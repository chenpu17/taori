import { test, expect } from '@playwright/test';
import { readSidecarEnv, resetSidecar, seedDefaultModel } from './_helpers';

/**
 * M1.3 cost transparency UI smoke.
 *
 * Verifies the renderer surfaces:
 *   1) price-tier badge in the chat header (model.price_input_per_1m=0.5 → cheap)
 *   2) per-message cost line under the assistant bubble after a chat completes
 *   3) bottom cost status bar updates after stream end
 */
test.beforeEach(async () => {
  const env = readSidecarEnv();
  await resetSidecar(env);
  await seedDefaultModel(env);
});

test('M1.3 cost UI: badge, per-message cost, status bar', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  // (1) price-tier badge
  await expect(page.getByTestId('price-tier')).toBeVisible();
  await expect(page.getByTestId('price-tier')).toContainText('💰');

  // (2) send a message and wait for the assistant bubble
  await page.getByTestId('composer-input').fill('hello cost');
  await page.getByTestId('composer-send').click();

  const assistantBubble = page.locator('.msg.assistant').last();
  await expect(assistantBubble).toContainText('[M0 mock]', { timeout: 15_000 });

  // per-message cost line
  await expect(page.getByTestId('msg-cost')).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId('msg-cost')).toContainText('in');
  await expect(page.getByTestId('msg-cost')).toContainText('out');

  // (3) status bar updated
  await expect(page.getByTestId('cost-bar')).toBeVisible();
  await expect(page.getByTestId('cost-conv')).toContainText('1 次', { timeout: 8_000 });
  await expect(page.getByTestId('cost-today')).toContainText('$');
});
