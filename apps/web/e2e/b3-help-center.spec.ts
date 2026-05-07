import { test, expect } from '@playwright/test';
import { readSidecarEnv, resetSidecar, seedDefaultModel } from './_helpers';

/**
 * B3 — Help Center + status self-check.
 *
 * Real-user verification:
 *  1. Click the ❔ button in the header → help dialog opens
 *  2. Three pillars and FAQ are visible; FAQ <details> can expand
 *  3. Run default self-check → Keychain is skipped to avoid OS prompts
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
  await expect(faq).toContainText('Prompt 模板和 Persona 有什么区别？');
  await expect(faq).toContainText('为什么 Persona 会显示“待绑定”？');
  // First FAQ entry should expand on click
  const firstSummary = page.getByTestId('help-faq-summary-0');
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

  // Sidecar / database should be ok in test env; Keychain is intentionally
  // skipped by default so the desktop app does not trigger OS prompts.
  await expect(page.getByTestId('help-selfcheck-sidecar')).toHaveAttribute(
    'data-level',
    'ok',
  );
  await expect(page.getByTestId('help-selfcheck-keystore')).toHaveAttribute(
    'data-level',
    'warn',
  );
  await expect(page.getByTestId('help-selfcheck-database')).toHaveAttribute(
    'data-level',
    'ok',
  );

  // 4. Real provider diagnostics reads local verify:real artifacts only. The
  // test passes both on a clean machine and on a machine with prior artifacts.
  await page.getByTestId('help-realdiag-load').click();
  await expect(
    page
      .getByTestId('help-realdiag-result')
      .or(page.getByTestId('help-realdiag-empty')),
  ).toBeVisible({ timeout: 10_000 });
  const realDiagResult = page.getByTestId('help-realdiag-result');
  if (await realDiagResult.isVisible()) {
    await expect(page.getByTestId('help-realdiag-steps')).toBeVisible();
    await expect(
      page
        .getByTestId('help-realdiag-risks')
        .or(page.getByTestId('help-realdiag-no-risks')),
    ).toBeVisible();
  }

  // 5. ESC closes
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('help-center')).not.toBeVisible();
});
