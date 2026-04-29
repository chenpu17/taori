import { test, expect } from '@playwright/test';
import { authedFetch, readSidecarEnv, resetSidecar, seedDefaultModel } from './_helpers';

/**
 * M2.5 — Manual model editor.
 *
 * Covers user request: "如果没有自动同步，能否手动设置？" + "图像生成的，是按次数算" +
 * "火山方舟的图像/视频模型有些被错误识别为文本对话，需要修正能力"。
 *
 * Verifies:
 *   1. The "编辑" button per row opens a dialog with capability + pricing fields.
 *   2. Switching capability chat → image swaps the visible price field
 *      (input/output per 1M  →  per-image).
 *   3. Saving persists capability + per_image price (verified via the model row
 *      and via /v1/models GET).
 *   4. Capability change clears the stale `is_default_for` binding.
 */

test('model-editor: change capability chat → image and set per-image price', async ({ page }) => {
  const env = readSidecarEnv();
  await resetSidecar(env);
  await seedDefaultModel(env);
  await page.goto('/');
  await page.getByTestId('open-model-center').click();
  await expect(page.getByTestId('model-center')).toBeVisible();
  await page.getByTestId('model-center-tab-chat').click();

  // Pick the only seeded model row and click "编辑".
  const editBtn = page.locator('[data-testid^="model-edit-"]').first();
  await editBtn.click();
  await expect(page.getByTestId('model-editor')).toBeVisible();

  // Initially chat → token-based price fields shown.
  await expect(page.getByTestId('model-editor-price-input')).toBeVisible();
  await expect(page.getByTestId('model-editor-price-output')).toBeVisible();
  await expect(page.getByTestId('model-editor-price-image')).toHaveCount(0);

  // Change capability to image.
  await page.getByTestId('model-editor-capability').selectOption('image');

  // Per-image price field appears, token fields hide.
  await expect(page.getByTestId('model-editor-price-image')).toBeVisible();
  await expect(page.getByTestId('model-editor-price-input')).toHaveCount(0);
  await expect(page.getByTestId('model-editor-price-output')).toHaveCount(0);

  // Capability-change warning visible (model was the chat default).
  await expect(page.getByTestId('model-editor-cap-warn')).toBeVisible();

  // Set per-image price + save.
  await page.getByTestId('model-editor-price-image').fill('0.04');
  await page.getByTestId('model-editor-save').click();

  // Editor closes; row should now be on the image tab (no longer on chat).
  await expect(page.getByTestId('model-editor')).toHaveCount(0);
  // Switch to image tab and confirm row shows up.
  await page.getByTestId('model-center-tab-image').click();
  await expect(page.getByTestId('model-matrix')).toBeVisible();

  // Verify via API: capability=image, price_per_image=0.04, is_default_for=null.
  const res = await authedFetch(env, '/v1/models');
  const body = (await res.json()) as { models: Array<{ capability: string; price_per_image: number | null; is_default_for: string | null }> };
  expect(body.models).toHaveLength(1);
  expect(body.models[0].capability).toBe('image');
  expect(body.models[0].price_per_image).toBeCloseTo(0.04, 4);
  expect(body.models[0].is_default_for).toBeNull();
});
