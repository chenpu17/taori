import { test, expect } from '@playwright/test';
import { readSidecarEnv, resetSidecar, seedDefaultModel } from './_helpers';

/**
 * Round-3 (Settings / browse-only skip / model CRUD) Playwright coverage.
 */

test('skip path: clean sidecar → "暂不配置" → browse-only banner with Configure button', async ({
  page,
}) => {
  const env = readSidecarEnv();
  await resetSidecar(env);
  // Clear any persisted browseOnly flag from prior tests.
  await page.addInitScript(() => {
    try {
      localStorage.removeItem('taori.browseOnly');
    } catch {
      /* ignore */
    }
  });
  await page.goto('/');
  await expect(page.getByTestId('onboarding')).toBeVisible();
  await page.getByTestId('onb-skip').click();
  await expect(page.getByTestId('browse-only')).toBeVisible();
  // Composer/chat should NOT be rendered.
  await expect(page.getByTestId('chat-panel')).toHaveCount(0);
  // Click "Configure" to reopen onboarding.
  await page.getByTestId('browse-only-configure').click();
  await expect(page.getByTestId('onboarding')).toBeVisible();
});

test('settings: opens, lists provider + model, can disable + delete model', async ({
  page,
}) => {
  const env = readSidecarEnv();
  await resetSidecar(env);
  await seedDefaultModel(env);
  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible();
  await page.getByTestId('open-settings').click();
  await expect(page.getByTestId('settings-overlay')).toBeVisible();
  // Provider listed.
  await expect(page.getByTestId('settings-provider-item')).toHaveCount(1);
  // One chat model listed.
  const items = page.getByTestId('settings-model-item');
  await expect(items).toHaveCount(1);
  // Price tier badge rendered (seedDefaultModel uses 0.5 → low tier).
  await expect(page.getByTestId('settings-price-tier').first()).toBeVisible();
  // Disable then re-enable.
  await page.getByTestId('settings-toggle-enabled').first().click();
  await expect(items.first()).toHaveClass(/disabled/);
  await page.getByTestId('settings-toggle-enabled').first().click();
  await expect(items.first()).not.toHaveClass(/disabled/);
  // Delete the model — confirm dialog.
  page.once('dialog', (d) => void d.accept());
  await page.getByTestId('settings-delete').first().click();
  await expect(items).toHaveCount(0);
});

test('settings: test button surfaces no_api_key_configured for keyless provider', async ({
  page,
}) => {
  const env = readSidecarEnv();
  await resetSidecar(env);
  await seedDefaultModel(env); // no api_key_ref → /test returns ok+note
  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible();
  await page.getByTestId('open-settings').click();
  await page.getByTestId('settings-test').first().click();
  await expect(page.getByTestId('settings-test-result')).toBeVisible();
  await expect(page.getByTestId('settings-test-result')).toContainText('✓');
  await expect(page.getByTestId('settings-test-result')).toContainText(
    '无 API Key',
  );
});

test('settings: Escape key closes the modal (a11y)', async ({ page }) => {
  const env = readSidecarEnv();
  await resetSidecar(env);
  await seedDefaultModel(env);
  await page.goto('/');
  await page.getByTestId('open-settings').click();
  await expect(page.getByTestId('settings-overlay')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('settings-overlay')).toHaveCount(0);
});

test('settings: reopen onboarding closes settings and shows wizard', async ({
  page,
}) => {
  const env = readSidecarEnv();
  await resetSidecar(env);
  await seedDefaultModel(env);
  await page.goto('/');
  await page.getByTestId('open-settings').click();
  await page.getByTestId('settings-add-provider').click();
  await expect(page.getByTestId('settings-overlay')).toHaveCount(0);
  await expect(page.getByTestId('onboarding')).toBeVisible();
});
