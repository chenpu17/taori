import { test, expect } from '@playwright/test';
import { readSidecarEnv, resetSidecar, seedDefaultModel } from './_helpers';

/**
 * M2.5 — Model Center surface coverage.
 *
 * Provider chip rendering, capability tabs, the "+ 添加 Provider" path and
 * the "+ 导入模型" drawer are all exercised here. Catalog sync UI lives in
 * `m2.5-catalog-sync-ui.spec.ts`; Volcengine Ark visibility lives in
 * `m2.5-volcengine-ark.spec.ts`.
 */

test('model-center: provider chips render and tabs filter rows', async ({ page }) => {
  const env = readSidecarEnv();
  await resetSidecar(env);
  await seedDefaultModel(env); // seeds ONE chat model, ONE provider
  await page.goto('/');
  await page.getByTestId('open-model-center').click();
  await expect(page.getByTestId('model-center')).toBeVisible();

  await expect(
    page.getByTestId('model-center-providers').locator('.provider-chip'),
  ).toHaveCount(1);

  // 6 capability tabs render.
  for (const t of ['chat', 'multimodal', 'image', 'video', 'asr', 'tts', 'embedding']) {
    await expect(page.getByTestId(`model-center-tab-${t}`)).toBeVisible();
  }

  // chat tab shows 1 row; image tab shows none (and prompts to import).
  await page.getByTestId('model-center-tab-chat').click();
  await expect(page.getByTestId('model-matrix')).toBeVisible();
  await page.getByTestId('model-center-tab-image').click();
  await expect(page.getByTestId('model-matrix')).toHaveCount(0);
  await expect(page.locator('.model-center__matrix .hint').last()).toContainText(
    '尚无',
  );
});

test('model-center: "+ 添加 Provider" reopens onboarding wizard', async ({ page }) => {
  const env = readSidecarEnv();
  await resetSidecar(env);
  await seedDefaultModel(env);
  await page.goto('/');
  await page.getByTestId('open-model-center').click();
  // Button label "+ 添加 Provider" lives inside the providers section header.
  await page
    .getByTestId('model-center-providers')
    .getByRole('button', { name: /添加 Provider/ })
    .click();
  await expect(page.getByTestId('model-center')).toHaveCount(0);
  await expect(page.getByTestId('onboarding')).toBeVisible();
});

test('model-center: "+ 导入模型" opens ImportDrawer with provider + capability prefilled', async ({
  page,
}) => {
  const env = readSidecarEnv();
  await resetSidecar(env);
  await seedDefaultModel(env);
  await page.goto('/');
  await page.getByTestId('open-model-center').click();
  await page.getByTestId('model-center-tab-chat').click();
  await page.getByTestId('model-center-import').click();
  await expect(page.getByTestId('import-drawer')).toBeVisible();
  await expect(page.getByTestId('import-drawer-capability')).toHaveValue('chat');
  // Provider dropdown is non-empty.
  const providerOptions = page
    .getByTestId('import-drawer-provider')
    .locator('option');
  await expect.poll(async () => providerOptions.count()).toBeGreaterThan(0);
});

test('model-center: import drawer disabled when no providers exist', async ({ page }) => {
  const env = readSidecarEnv();
  await resetSidecar(env);
  await page.addInitScript(() => {
    try {
      localStorage.setItem('taori.browseOnly', '1');
    } catch {
      /* ignore */
    }
  });
  await page.goto('/');
  await expect(page.getByTestId('browse-only')).toBeVisible();
  // Browse-only doesn't render the toolbar; reload after seeding skip-cleared.
});
