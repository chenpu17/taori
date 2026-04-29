import { test, expect } from '@playwright/test';
import { readSidecarEnv, resetSidecar, seedDefaultModel } from './_helpers';

/**
 * Round-3 (Settings / browse-only / model CRUD) Playwright coverage — v0.7
 *
 * v0.7 polish moved Provider/Model list & test/delete UI from Settings into
 * the new Model Center (open via 🧬 toolbar button). Settings now only carries
 * AutoFallback, "重新打开 Onboarding" and the Danger Zone. Tests below cover
 * BOTH surfaces.
 */

test('skip path: clean sidecar → "暂不配置" → browse-only banner with Configure button', async ({
  page,
}) => {
  const env = readSidecarEnv();
  await resetSidecar(env);
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
  await expect(page.getByTestId('chat-panel')).toHaveCount(0);
  await page.getByTestId('browse-only-configure').click();
  await expect(page.getByTestId('onboarding')).toBeVisible();
});

test('settings (slim): only AutoFallback + Reopen Onboarding + Danger Zone — no model UI', async ({
  page,
}) => {
  const env = readSidecarEnv();
  await resetSidecar(env);
  await seedDefaultModel(env);
  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible();
  await page.getByTestId('open-settings').click();
  await expect(page.getByTestId('settings-overlay')).toBeVisible();

  // The slim Settings retains only these surfaces.
  await expect(page.getByTestId('settings-auto-fallback')).toBeVisible();
  await expect(page.getByTestId('settings-add-provider')).toBeVisible();
  await expect(page.getByTestId('settings-danger-zone')).toBeVisible();

  // The old in-Settings model UI must be GONE.
  await expect(page.getByTestId('settings-provider-item')).toHaveCount(0);
  await expect(page.getByTestId('settings-model-item')).toHaveCount(0);
  await expect(page.getByTestId('settings-test')).toHaveCount(0);
  await expect(page.getByTestId('settings-delete')).toHaveCount(0);
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

// ----------------------------------------------------------------------------
// Model Center smoke — replaces the model CRUD scenarios that used to live in
// Settings. Comprehensive Model Center coverage is in m2.5-modelcenter.spec.ts.
// ----------------------------------------------------------------------------
test('model-center: opens, lists provider chip + chat model row, can disable + delete', async ({
  page,
}) => {
  const env = readSidecarEnv();
  await resetSidecar(env);
  await seedDefaultModel(env);
  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible();
  await page.getByTestId('open-model-center').click();
  await expect(page.getByTestId('model-center')).toBeVisible();

  // One Provider chip and one chat model row.
  await expect(page.getByTestId('model-center-providers').locator('.provider-chip'))
    .toHaveCount(1);
  const rows = page.locator(
    '[data-testid^="model-row-"]:not([data-testid^="model-row-default-"]):not([data-testid^="model-row-up-"]):not([data-testid^="model-row-down-"]):not([data-testid^="model-row-delete-"]):not([data-testid^="model-row-enabled-"])',
  );
  await expect(rows).toHaveCount(1);

  // Toggle disable/enable.
  const toggle = page.locator('[data-testid^="model-row-enabled-"]').first();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(toggle).toBeChecked();

  // Delete via row action; native confirm auto-accept.
  page.once('dialog', (d) => void d.accept());
  await page.locator('[data-testid^="model-row-delete-"]').first().click();
  await expect(rows).toHaveCount(0);
});

test('model-center: provider chip "测试" probes the first model and shows ✓ for keyless provider', async ({
  page,
}) => {
  const env = readSidecarEnv();
  await resetSidecar(env);
  await seedDefaultModel(env); // no api key → /test returns ok with note
  await page.goto('/');
  await page.getByTestId('open-model-center').click();
  const testBtn = page.locator('[data-testid^="provider-chip-test-"]').first();
  await testBtn.click();
  const result = page.locator('[data-testid^="provider-chip-test-result-"]').first();
  await expect(result).toBeVisible();
  await expect(result).toContainText('✓');
  await expect(result).toContainText('no_api_key_configured');
});
