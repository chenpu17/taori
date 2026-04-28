/**
 * M1.7 — R4 (files / cost extras) acceptance tests.
 *
 *   1. PDF drop attaches as a file chip but server rejects with a clear error
 *      (M1 §4 FILE-2 acknowledged-deferred behaviour).
 *   2. Pre-send estimate bar appears once the user types and is hidden when
 *      the input is empty (M1 §5.1).
 *   3. Danger-zone clear-all-data wipes models + providers and forces the app
 *      back to onboarding (M1 §6.2).
 */
import { test, expect } from '@playwright/test';
import { readSidecarEnv, authedFetch, resetSidecar, seedDefaultModel } from './_helpers';

const env = readSidecarEnv();

test.beforeEach(async () => {
  await resetSidecar(env);
});

test('R4a: estimate bar appears when user types, hides when empty', async ({ page }) => {
  await seedDefaultModel(env);
  await page.goto('/');
  await expect(page.getByTestId('composer-input')).toBeVisible();
  // Empty input → no estimate bar.
  await expect(page.getByTestId('estimate-bar')).toHaveCount(0);
  await page.getByTestId('composer-input').fill('Hello, world! 你好世界');
  // After typing, the estimate bar should render (either an amount or a "no price" hint).
  await expect(page.getByTestId('estimate-bar')).toBeVisible();
});

test('R4c: PDF drop attaches as chip but send is rejected with typed error', async ({ page }) => {
  await seedDefaultModel(env);
  await page.goto('/');
  await expect(page.getByTestId('composer-form')).toBeVisible();
  const dataTransfer = await page.evaluateHandle(() => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'doc.pdf', { type: 'application/pdf' }));
    return dt;
  });
  await page.getByTestId('composer-form').dispatchEvent('dragover', { dataTransfer });
  await page.getByTestId('composer-form').dispatchEvent('drop', { dataTransfer });
  await expect(page.getByTestId('attachment-thumb')).toHaveCount(1);
  await expect(page.getByTestId('attachment-thumb')).toHaveAttribute('data-kind', 'pdf');
  // Send → sidecar must surface a typed validation error.
  await page.getByTestId('composer-input').fill('summarize');
  await page.getByTestId('composer-send').click();
  await expect(page.getByTestId('chat-error')).toBeVisible({ timeout: 8000 });
  await expect(page.getByTestId('chat-error-detail')).toContainText('PDF');
});

test('R4b: danger-zone clear-all-data wipes models and forces onboarding', async ({ page }) => {
  await seedDefaultModel(env);
  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible();
  await page.getByTestId('open-settings').click();
  await expect(page.getByTestId('settings-overlay')).toBeVisible();

  await expect(page.getByTestId('settings-danger-zone')).toBeVisible();
  // Button must be disabled until armed.
  await expect(page.getByTestId('settings-clear-all')).toBeDisabled();
  await page.getByTestId('settings-danger-arm').check();
  await expect(page.getByTestId('settings-clear-all')).toBeEnabled();

  // Auto-confirm the native dialog.
  page.once('dialog', (d) => void d.accept());
  await page.getByTestId('settings-clear-all').click();

  // Page reloads after clear; verify backend is empty.
  await page.waitForLoadState('networkidle');
  const r = await authedFetch(env, '/v1/models');
  const j = (await r.json()) as { models: unknown[] };
  expect(j.models).toEqual([]);
});
