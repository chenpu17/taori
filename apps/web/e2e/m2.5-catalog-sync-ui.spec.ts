import { test, expect } from '@playwright/test';
import { readSidecarEnv, resetSidecar, seedDefaultModel } from './_helpers';

/**
 * M2.5 — Catalog sync UI smoke.
 *
 * The "🔄 同步价格" button posts to /v1/catalog/sync. With the seed provider
 * (no real API key), the sidecar returns either an error or an empty diff;
 * either way the button must not crash and must remain clickable afterwards.
 */

test('model-center: 🔄 同步价格 button is clickable and completes', async ({ page }) => {
  const env = readSidecarEnv();
  await resetSidecar(env);
  await seedDefaultModel(env);
  await page.goto('/');
  await page.getByTestId('open-model-center').click();
  const sync = page.getByTestId('model-center-sync');
  await expect(sync).toBeVisible();
  await expect(sync).toBeEnabled();
  await sync.click();
  // Either the summary surface appears, or an inline error renders, or the
  // button just re-enables. Wait until it's clickable again.
  await expect(sync).toBeEnabled({ timeout: 15_000 });
});
