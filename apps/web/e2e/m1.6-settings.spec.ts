import { test, expect } from '@playwright/test';
import { readSidecarEnv, resetSidecar, seedDefaultModel } from './_helpers';

/**
 * Round-3 (Settings / browse-only / model CRUD) Playwright coverage — v0.7
 *
 * v0.7 polish moved Provider/Model list & test/delete UI from Settings into
 * the new Model Center (open via 🧬 toolbar button). Settings now carries
 * cross-cutting reliability/cost/memory toggles plus "重新打开 Onboarding" and
 * the Danger Zone. Tests below cover BOTH surfaces.
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

test('settings (slim): reliability toggles + Reopen Onboarding + Danger Zone — no model UI', async ({
  page,
}) => {
  const env = readSidecarEnv();
  await resetSidecar(env);
  await seedDefaultModel(env);
  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible();
  await page.getByTestId('open-settings').click();
  await expect(page.getByTestId('settings-overlay')).toBeVisible();

  // The slim Settings retains only cross-cutting surfaces.
  await expect(page.getByTestId('settings-auto-fallback')).toBeVisible();
  await expect(page.getByTestId('settings-stream-recovery')).toBeVisible();
  await expect(page.getByTestId('stream-auto-resume-toggle')).toBeVisible();
  await expect(page.getByTestId('settings-add-provider')).toBeVisible();
  await expect(page.getByTestId('settings-danger-zone')).toBeVisible();

  // The old in-Settings model UI must be GONE.
  await expect(page.getByTestId('settings-provider-item')).toHaveCount(0);
  await expect(page.getByTestId('settings-model-item')).toHaveCount(0);
  await expect(page.getByTestId('settings-test')).toHaveCount(0);
  await expect(page.getByTestId('settings-delete')).toHaveCount(0);
});

test('settings: stream auto-resume toggle persists globally', async ({ page }) => {
  const env = readSidecarEnv();
  await resetSidecar(env);
  await seedDefaultModel(env);
  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible();

  await page.getByTestId('open-settings').click();
  const toggle = page.getByTestId('stream-auto-resume-toggle');
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect(toggle).toBeChecked();
  await page.getByTestId('settings-close').click();

  await page.getByTestId('open-settings').click();
  await expect(page.getByTestId('stream-auto-resume-toggle')).toBeChecked();
});

test('settings: thinking toggle persists globally', async ({ page }) => {
  const env = readSidecarEnv();
  await resetSidecar(env);
  await seedDefaultModel(env);
  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible();

  await page.getByTestId('open-settings').click();
  const toggle = page.getByTestId('thinking-toggle');
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect(toggle).toBeChecked();
  await page.getByTestId('settings-close').click();

  await page.getByTestId('open-settings').click();
  await expect(page.getByTestId('thinking-toggle')).toBeChecked();
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

test('settings: tools tab lists builtin tools and persists toggles', async ({ page }) => {
  const env = readSidecarEnv();
  await resetSidecar(env);
  await seedDefaultModel(env);
  await page.goto('/');
  await page.getByTestId('open-settings').click();
  await page.getByTestId('settings-tab-tools').click();
  await expect(page.getByTestId('settings-tools')).toBeVisible();
  await expect(page.getByTestId('settings-tool-builtin.web_search')).toContainText('网页搜索');
  await expect(page.getByTestId('settings-tool-builtin.web_fetch')).toContainText('网页抓取');
  await expect(page.getByTestId('settings-tool-builtin.image_generate')).toContainText('图像生成');
  await expect(page.getByTestId('settings-tools')).toContainText('图像理解不是独立工具');
  await expect(page.getByTestId('settings-tool-builtin.web_fetch')).toContainText('24h 调用');
  await expect(page.getByTestId('settings-tool-builtin.web_fetch')).toContainText('最近失败');

  const toggle = page.getByTestId('tool-toggle-builtin.web_fetch');
  await expect(toggle).toContainText('已启用');
  await toggle.click();
  await expect(toggle).toContainText('已关闭');
  await page.getByTestId('settings-close').click();

  await page.getByTestId('open-settings').click();
  await page.getByTestId('settings-tab-tools').click();
  await expect(page.getByTestId('tool-toggle-builtin.web_fetch')).toContainText('已关闭');
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

  // One provider in nav and one chat model row.
  await expect(page.locator('[data-testid^="provider-nav-item-"]')).toHaveCount(1);
  const rows = page.locator('.model-matrix tbody > tr:not(.model-health-row)');
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

test('model-center: provider detail "测试" reports key_missing for keyless provider', async ({
  page,
}) => {
  const env = readSidecarEnv();
  await resetSidecar(env);
  await seedDefaultModel(env); // no api key → /test reports key_missing
  await page.goto('/');
  await page.getByTestId('open-model-center').click();
  const providerNavItem = page.locator('[data-testid^="provider-nav-item-"]').first();
  const providerId = (await providerNavItem.getAttribute('data-testid'))?.replace(
    'provider-nav-item-',
    '',
  );
  expect(providerId).toBeTruthy();
  await providerNavItem.click();
  await page.getByTestId(`provider-detail-test-${providerId}`).click();
  const result = page.getByTestId(`provider-detail-test-result-${providerId}`);
  await expect(result).toBeVisible();
  await expect(result).toContainText('✗');
  await expect(result).toContainText('no_api_key_configured');
  await expect(result).toContainText('key_missing');
});
