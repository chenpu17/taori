import { test, expect } from '@playwright/test';
import { readSidecarEnv, resetSidecar, seedDefaultModel } from './_helpers';

/**
 * B3 — Help Center + status self-check.
 *
 * Real-user verification:
 *  1. Click the ❔ button in the header → help dialog opens
 *  2. Three pillars and FAQ are visible; FAQ <details> can expand
 *  3. Run self-check → 4 items render, all green when default model seeded
 *  4. ESC closes the dialog
 */

let env: ReturnType<typeof readSidecarEnv>;

test.beforeEach(async () => {
  env = readSidecarEnv();
  await resetSidecar(env);
  await seedDefaultModel(env);
});

test('help center: opens, shows pillars/FAQ, runs selfcheck, closes on ESC', async ({
  page,
}) => {
  await page.goto('/');

  // 1. Open help center
  const openBtn = page.getByTestId('open-help');
  await expect(openBtn).toBeVisible();
  await openBtn.click();
  await expect(page.getByTestId('help-center')).toBeVisible();

  // 2. Pillars + FAQ
  const pillars = page.getByTestId('help-pillars');
  await expect(pillars).toContainText('失败兜底');
  await expect(pillars).toContainText('成本透明');
  await expect(pillars).toContainText('多模型圆桌');

  const faq = page.getByTestId('help-faq');
  await expect(faq).toBeVisible();
  // First FAQ entry should expand on click
  const firstSummary = faq.locator('summary').first();
  await firstSummary.click();
  await expect(
    faq.locator('details').first(),
  ).toHaveAttribute('open', '');

  // 3. Run self-check
  await page.getByTestId('help-selfcheck-run').click();
  const overall = page.getByTestId('help-selfcheck-overall');
  await expect(overall).toBeVisible({ timeout: 10_000 });
  // Default model is seeded but not marked default → expect warn or ok.
  await expect(overall).toHaveAttribute('data-level', /ok|warn/);

  // All four items render.
  for (const id of ['sidecar', 'keystore', 'database', 'default_model']) {
    const item = page.getByTestId(`help-selfcheck-${id}`);
    await expect(item).toBeVisible();
    await expect(item).toHaveAttribute('data-level', /ok|warn|error/);
  }

  // Sidecar / keystore / database should always be ok in test env.
  await expect(page.getByTestId('help-selfcheck-sidecar')).toHaveAttribute(
    'data-level',
    'ok',
  );
  await expect(page.getByTestId('help-selfcheck-keystore')).toHaveAttribute(
    'data-level',
    'ok',
  );
  await expect(page.getByTestId('help-selfcheck-database')).toHaveAttribute(
    'data-level',
    'ok',
  );

  // 4. ESC closes
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('help-center')).not.toBeVisible();
});
