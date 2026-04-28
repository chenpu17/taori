import { test, expect } from '@playwright/test';
import { readSidecarEnv, resetSidecar, seedDefaultModel } from './_helpers';

/**
 * M0 smoke: sidecar streams a mock reply through useChat data protocol.
 *
 * Pre-condition: dev launcher (`pnpm dev:browser`) has booted sidecar + vite,
 *   so VITE_SIDECAR_URL & VITE_SIDECAR_BEARER are wired into the page.
 *
 * The chat panel is only mounted when a default chat model exists, so we
 * pre-seed one (deleting any prior state) before each run.
 */
test.beforeEach(async () => {
  const env = readSidecarEnv();
  await resetSidecar(env);
  await seedDefaultModel(env);
});

test('M0 chat round-trip', async ({ page }) => {
  const consoleErrs: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrs.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrs.push(`pageerror: ${err.message}`));
  page.on('requestfailed', (r) =>
    consoleErrs.push(`reqfail: ${r.url()} ${r.failure()?.errorText ?? ''}`),
  );

  await page.goto('/');

  await expect(page.locator('.badge.ok')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  await page.getByTestId('composer-input').fill('hello taori');
  await page.getByTestId('composer-send').click();

  await expect(page.locator('.msg.user')).toContainText('hello taori');

  try {
    const assistantBubble = page.locator('.msg.assistant').last();
    await expect(assistantBubble).toContainText('[M0 mock]', { timeout: 15_000 });
    await expect(assistantBubble).toContainText('hello taori', { timeout: 15_000 });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log('CONSOLE ERRORS:\n' + consoleErrs.join('\n'));
    // eslint-disable-next-line no-console
    console.log('DOM:\n' + (await page.content()));
    throw e;
  }
});
