import { test, expect, type Locator, type Page } from '@playwright/test';
import { authedFetch, readSidecarEnv, resetSidecar, seedDefaultModel, type SidecarEnv } from './_helpers';

type TipId = 'roundtable' | 'image' | 'fallback' | 'cost';

async function suppressTips(page: Page, tipIds: TipId[]): Promise<void> {
  await page.addInitScript((ids) => {
    for (const id of ids) {
      localStorage.setItem(`tip_${id}_first_seen`, 'true');
    }
  }, tipIds);
}

async function expectHorizontallyWithinViewport(page: Page, locator: Locator): Promise<void> {
  const box = await locator.boundingBox();
  expect(box).toBeTruthy();
  const viewport = page.viewportSize();
  expect(viewport).toBeTruthy();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width);
}

async function expectRootFitsViewport(page: Page): Promise<void> {
  const widths = await page.evaluate(() => ({
    body: document.body.getBoundingClientRect().width,
    root: document.documentElement.getBoundingClientRect().width,
    viewport: window.innerWidth,
  }));
  expect(Math.max(widths.body, widths.root)).toBeLessThanOrEqual(widths.viewport + 1);
}

async function expectNoHorizontalOverflow(locator: Locator): Promise<void> {
  const overflow = await locator.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

async function seedCompareModels(
  env: SidecarEnv,
  labels: { provider: string; models: [string, string, string] },
): Promise<void> {
  const pr = await authedFetch(env, '/v1/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: labels.provider,
      type: 'custom',
      base_url: 'https://example.invalid/v1',
    }),
  });
  expect(pr.ok).toBeTruthy();
  const provider = (await pr.json()) as { id: string };
  for (const [index, display_name] of labels.models.entries()) {
    const mr = await authedFetch(env, '/v1/models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider_id: provider.id,
        model_name: `interaction-qc-${index}`,
        capability: 'chat',
        display_name,
        is_default_for: index === 0 ? 'chat' : null,
        price_input_per_1m: 0.1 + index,
        price_output_per_1m: 0.2 + index,
        context_length: index === 2 ? 128_000 : 32_000,
        supports_tools: index === 2,
        supports_json: index === 2,
      }),
    });
    expect(mr.ok).toBeTruthy();
  }
}

test.describe('interaction guardrails', () => {
  test.use({ colorScheme: 'dark' });

  test.beforeEach(async () => {
    const env = readSidecarEnv();
    await resetSidecar(env);
  });

  test('roundtable dont-show syncs across sibling tabs', async ({ page }) => {
    const env = readSidecarEnv();
    await seedDefaultModel(env);
    await suppressTips(page, ['image', 'fallback', 'cost']);
    const sibling = await page.context().newPage();
    await suppressTips(sibling, ['image', 'fallback', 'cost']);

    await page.goto('/');
    await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('tip-roundtable')).toBeVisible({ timeout: 5_000 });

    await sibling.goto('/');
    await expect(sibling.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
    await expect(sibling.getByTestId('tip-roundtable')).toBeVisible({ timeout: 5_000 });

    await page.getByTestId('tip-roundtable').getByTestId('tip-dont-show').click();
    await expect(page.getByTestId('tip-roundtable')).toHaveCount(0, { timeout: 5_000 });
    await expect(sibling.getByTestId('tip-roundtable')).toHaveCount(0, { timeout: 5_000 });
    await sibling.close();
  });

  test('help center escape restores focus to the header trigger', async ({ page }) => {
    const env = readSidecarEnv();
    await seedDefaultModel(env);
    await suppressTips(page, ['roundtable', 'image', 'fallback', 'cost']);
    await page.goto('/');
    await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

    const trigger = page.getByTestId('open-help');
    await trigger.click();
    await expect(page.getByTestId('help-center')).toBeVisible();

    await page.getByTestId('help-selfcheck-run').focus();
    await expect(page.getByTestId('help-selfcheck-run')).toBeFocused();
    await page.keyboard.press('Escape');

    await expect(page.getByTestId('help-center')).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test('control center escape restores focus to the opener after internal navigation', async ({ page }) => {
    const env = readSidecarEnv();
    await seedDefaultModel(env);
    await suppressTips(page, ['roundtable', 'image', 'fallback', 'cost']);
    await page.goto('/');
    await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

    const trigger = page.getByTestId('open-settings');
    await trigger.click();
    await expect(page.getByTestId('control-center')).toBeVisible();

    await page.getByTestId('settings-tab-tools').click();
    await expect(page.getByTestId('settings-tools')).toBeVisible();
    await page.getByTestId('settings-close').focus();
    await expect(page.getByTestId('settings-close')).toBeFocused();
    await page.keyboard.press('Escape');

    await expect(page.getByTestId('control-center')).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test('small viewport roundtable tip stays within the screen width', async ({ page }) => {
    const env = readSidecarEnv();
    await seedDefaultModel(env);
    await suppressTips(page, ['image', 'fallback', 'cost']);
    await page.setViewportSize({ width: 390, height: 720 });

    await page.goto('/');
    const tip = page.getByTestId('tip-roundtable');
    await expect(tip).toBeVisible({ timeout: 5_000 });

    await expectHorizontallyWithinViewport(page, tip.locator('.tip-card'));
    await expectRootFitsViewport(page);
  });

  test('small viewport quick compare stays within the screen with long unbroken model labels', async ({ page }) => {
    const env = readSidecarEnv();
    await seedCompareModels(env, {
      provider: 'ProviderWithAnExcessivelyLongUnbrokenIdentifierForResponsiveChecks',
      models: [
        'CurrentModelWithAnExcessivelyLongUnbrokenIdentifierForResponsiveChecksAlpha',
        'PeerModelWithAnExcessivelyLongUnbrokenIdentifierForResponsiveChecksBeta',
        'PeerModelWithAnExcessivelyLongUnbrokenIdentifierForResponsiveChecksGamma',
      ],
    });
    await page.addInitScript(() => {
      localStorage.setItem('tip_roundtable_first_seen', 'true');
    });
    await page.setViewportSize({ width: 390, height: 720 });

    await page.goto('/');
    await page.getByTestId('composer-input').fill('请比较这三个候选模型在移动端上的可读性');
    await page.getByTestId('composer-quick-compare').click();
    const picker = page.getByTestId('quick-compare-picker');
    await expect(picker).toBeVisible();
    await expectHorizontallyWithinViewport(page, picker.locator('.quick-compare-picker-dialog'));
    await expectRootFitsViewport(page);
    await page.getByTestId('quick-compare-picker-submit').click();

    const card = page.getByTestId('quick-compare-card');
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('quick-compare-output')).toHaveCount(3, { timeout: 15_000 });

    await expectHorizontallyWithinViewport(page, card);
    await expectRootFitsViewport(page);
    await expectNoHorizontalOverflow(page.getByTestId('quick-compare-output').first().locator('header'));
  });
});
