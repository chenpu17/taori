import { test, expect, type Page } from '@playwright/test';
import { authedFetch, readSidecarEnv, resetSidecar } from './_helpers';

const env = readSidecarEnv();
type TipId = 'roundtable' | 'image' | 'fallback' | 'cost';

const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

async function suppressTips(page: Page, tipIds: TipId[]) {
  await page.addInitScript((ids) => {
    for (const id of ids) {
      localStorage.setItem(`tip_${id}_first_seen`, 'true');
    }
  }, tipIds);
}

async function expectWorkspaceReady(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
}

async function dismissTip(page: Page, tipId: TipId, action: 'got-it' | 'dont-show') {
  const tip = page.getByTestId(`tip-${tipId}`);
  await expect(tip).toBeVisible({ timeout: 5_000 });
  await tip.getByTestId(action === 'got-it' ? 'tip-got-it' : 'tip-dont-show').click();
  await expect(tip).toHaveCount(0, { timeout: 5_000 });
}

async function triggerFallback(page: Page, content: string) {
  await page.getByTestId('composer-input').fill(content);
  await page.getByTestId('composer-send').click();
  await expect(page.getByTestId('failure-decision-card')).toBeVisible({ timeout: 15_000 });
}

async function triggerCostTip(page: Page, content: string) {
  await page.getByTestId('composer-input').fill(content);
  await page.getByTestId('composer-send').click();
  await expect(page.locator('.msg.assistant').last()).toBeVisible({ timeout: 10_000 });
}

async function setThresholdConfirmMemory(value: string) {
  const res = await authedFetch(env, '/v1/memories', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      scope: 'global',
      key: 'cost_confirm_threshold_usd',
      value,
    }),
  });
  expect(res.ok).toBeTruthy();
}

async function seedVisionChatModel() {
  const pr = await authedFetch(env, '/v1/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Vision provider',
      type: 'custom',
      base_url: 'https://example.invalid/v1',
    }),
  });
  const provider = (await pr.json()) as { id: string };
  await authedFetch(env, '/v1/models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider_id: provider.id,
      model_name: 'vision-default',
      capability: 'chat',
      display_name: 'Vision Default',
      is_default_for: 'chat',
      supports_vision: true,
      price_input_per_1m: 0.5,
      price_output_per_1m: 1.5,
    }),
  });
}

async function seedFallbackModels() {
  const pr = await authedFetch(env, '/v1/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Fallback provider',
      type: 'openrouter',
      base_url: 'https://example.invalid/v1',
      api_key: 'sk-test',
    }),
  });
  const provider = (await pr.json()) as { id: string };
  await authedFetch(env, '/v1/models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider_id: provider.id,
      model_name: 'primary',
      capability: 'chat',
      display_name: 'Primary',
      is_default_for: 'chat',
    }),
  });
  await authedFetch(env, '/v1/models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider_id: provider.id,
      model_name: 'fallback',
      capability: 'chat',
      display_name: 'Fallback',
    }),
  });
}

async function seedPricedChatModel() {
  const pr = await authedFetch(env, '/v1/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Priced provider',
      type: 'custom',
      base_url: 'https://example.invalid/v1',
    }),
  });
  const provider = (await pr.json()) as { id: string };
  await authedFetch(env, '/v1/models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider_id: provider.id,
      model_name: 'priced-chat',
      capability: 'chat',
      display_name: 'Priced Chat',
      is_default_for: 'chat',
      price_input_per_1m: 0.5,
      price_output_per_1m: 1.5,
      price_per_call: 0.02,
    }),
  });
}

async function seedImageGeneratorModels() {
  const pr = await authedFetch(env, '/v1/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Image provider',
      type: 'openai',
      base_url: 'https://example.invalid/v1',
      api_key: 'sk-image-test',
    }),
  });
  const provider = (await pr.json()) as { id: string };
  await authedFetch(env, '/v1/models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider_id: provider.id,
      model_name: 'chat-default',
      capability: 'chat',
      display_name: 'Image Chat',
      is_default_for: 'chat',
      price_input_per_1m: 0.5,
      price_output_per_1m: 1.5,
    }),
  });
  await authedFetch(env, '/v1/models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider_id: provider.id,
      model_name: 'image-default',
      capability: 'image',
      display_name: 'Image Default',
      price_per_call: 0.02,
    }),
  });
}

async function dropImage(page: Page) {
  const dataTransfer = await page.evaluateHandle((b64) => {
    const dt = new DataTransfer();
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    dt.items.add(new File([arr], 'tiny.png', { type: 'image/png' }));
    return dt;
  }, TINY_PNG_B64);
  await page.getByTestId('composer-form').dispatchEvent('dragover', { dataTransfer });
  await page.getByTestId('composer-form').dispatchEvent('drop', { dataTransfer });
}

test.beforeEach(async () => {
  await resetSidecar(env);
});

test('B2 roundtable tip shows on first workspace load and dont-show persists across reload', async ({ page }) => {
  await seedVisionChatModel();

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  const tip = page.getByTestId('tip-roundtable');
  await expect(tip).toBeVisible({ timeout: 5_000 });
  await expect(tip).toContainText('多模型圆桌');

  await tip.getByTestId('tip-dont-show').click();
  await expect(tip).toBeHidden({ timeout: 3_000 });

  await page.reload();
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('tip-roundtable')).toHaveCount(0);
});

test('B2 image tip appears after first image drop', async ({ page }) => {
  await seedVisionChatModel();
  await suppressTips(page, ['roundtable']);

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  await dropImage(page);

  const tip = page.getByTestId('tip-image');
  await expect(tip).toBeVisible({ timeout: 5_000 });
  await expect(tip).toContainText('多模型图像理解');
  await expect(page.getByTestId('attachment-thumb')).toBeVisible();
});

test('B2 fallback tip appears when first failure-decision card lands', async ({ page }) => {
  await seedFallbackModels();
  await suppressTips(page, ['roundtable']);

  await page.route('**/v1/chat', async (route) => {
    const headers = {
      ...route.request().headers(),
      'x-test-force-classification': 'rate_limit',
    };
    await route.continue({ headers });
  });

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  await page.getByTestId('composer-input').fill('trigger fallback tip');
  await page.getByTestId('composer-send').click();

  await expect(page.getByTestId('failure-decision-card')).toBeVisible({ timeout: 15_000 });
  const tip = page.getByTestId('tip-fallback');
  await expect(tip).toBeVisible({ timeout: 5_000 });
  await expect(tip).toContainText('失败兜底');
});

test('B2 cost tip appears after monthly spend crosses threshold', async ({ page }) => {
  await seedPricedChatModel();
  await suppressTips(page, ['roundtable']);

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  await page.getByTestId('composer-input').fill('say hello with measurable cost');
  await page.getByTestId('composer-send').click();

  await expect(page.locator('.msg.assistant').last()).toBeVisible({ timeout: 10_000 });
  const tip = page.getByTestId('tip-cost');
  await expect(tip).toBeVisible({ timeout: 5_000 });
  await expect(tip).toContainText('成本透明');
  await expect(page.getByTestId('cost-month')).toContainText('$');
});

test('B2 roundtable got-it is session-only and tip returns in a fresh tab', async ({ page }) => {
  await seedVisionChatModel();

  await expectWorkspaceReady(page);
  await dismissTip(page, 'roundtable', 'got-it');

  const freshPage = await page.context().newPage();
  await expectWorkspaceReady(freshPage);
  await expect(freshPage.getByTestId('tip-roundtable')).toBeVisible({ timeout: 5_000 });
  await freshPage.close();
});

test('B2 roundtable tip hides behind settings overlay and returns after close', async ({ page }) => {
  await seedVisionChatModel();

  await expectWorkspaceReady(page);
  await expect(page.getByTestId('tip-roundtable')).toBeVisible({ timeout: 5_000 });

  await page.getByTestId('open-settings').click();
  await expect(page.getByTestId('control-center')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('tip-roundtable')).toHaveCount(0);

  await page.getByTestId('settings-close').click();
  await expect(page.getByTestId('control-center')).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByTestId('tip-roundtable')).toBeVisible({ timeout: 5_000 });
});

test('B2 roundtable tip hides behind cost dashboard and returns after close', async ({ page }) => {
  await seedVisionChatModel();

  await expectWorkspaceReady(page);
  await expect(page.getByTestId('tip-roundtable')).toBeVisible({ timeout: 5_000 });

  await page.getByTestId('open-cost-dashboard').click();
  await expect(page.getByTestId('cost-dashboard-panel')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('tip-roundtable')).toHaveCount(0);

  await page.getByTestId('cost-dashboard-close').click();
  await expect(page.getByTestId('control-center')).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByTestId('tip-roundtable')).toBeVisible({ timeout: 5_000 });
});

test('B2 roundtable tip hides behind roundtable launch dialog and returns after cancel', async ({ page }) => {
  await seedVisionChatModel();

  await expectWorkspaceReady(page);
  await expect(page.getByTestId('tip-roundtable')).toBeVisible({ timeout: 5_000 });

  await page.getByTestId('composer-tools-toggle').click();
  await expect(page.getByTestId('composer-roundtable')).toBeVisible();
  await page.getByTestId('composer-roundtable').click();
  await expect(page.getByTestId('roundtable-launch-dialog')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('tip-roundtable')).toHaveCount(0);

  await page.getByTestId('roundtable-launch-cancel').click();
  await expect(page.getByTestId('roundtable-launch-dialog')).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByTestId('tip-roundtable')).toBeVisible({ timeout: 5_000 });
});

test('B2 roundtable dont-show does not suppress image tip later', async ({ page }) => {
  await seedVisionChatModel();

  await expectWorkspaceReady(page);
  await dismissTip(page, 'roundtable', 'dont-show');

  await dropImage(page);
  await expect(page.getByTestId('attachment-thumb')).toBeVisible();
  await expect(page.getByTestId('tip-image')).toBeVisible({ timeout: 5_000 });
});

test('B2 image dont-show persists across reload and second image drop', async ({ page }) => {
  await seedVisionChatModel();
  await suppressTips(page, ['roundtable']);

  await expectWorkspaceReady(page);
  await dropImage(page);
  await dismissTip(page, 'image', 'dont-show');

  await page.reload();
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await dropImage(page);
  await expect(page.getByTestId('tip-image')).toHaveCount(0);
});

test('B2 image got-it returns in a fresh tab after a second image drop', async ({ page }) => {
  await seedVisionChatModel();
  await suppressTips(page, ['roundtable']);

  await expectWorkspaceReady(page);
  await dropImage(page);
  await dismissTip(page, 'image', 'got-it');

  const freshPage = await page.context().newPage();
  await suppressTips(freshPage, ['roundtable']);
  await expectWorkspaceReady(freshPage);
  await dropImage(freshPage);
  await expect(freshPage.getByTestId('tip-image')).toBeVisible({ timeout: 5_000 });
  await freshPage.close();
});

test('B2 fallback dont-show persists across reload and second failure', async ({ page }) => {
  await seedFallbackModels();
  await suppressTips(page, ['roundtable']);

  await page.route('**/v1/chat', async (route) => {
    const headers = {
      ...route.request().headers(),
      'x-test-force-classification': 'rate_limit',
    };
    await route.continue({ headers });
  });

  await expectWorkspaceReady(page);
  await triggerFallback(page, 'first failure for dont-show');
  await dismissTip(page, 'fallback', 'dont-show');

  await page.reload();
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await triggerFallback(page, 'second failure after reload');
  await expect(page.getByTestId('tip-fallback')).toHaveCount(0);
});

test('B2 fallback got-it returns in a fresh tab after a second failure', async ({ page }) => {
  await seedFallbackModels();
  await suppressTips(page, ['roundtable']);

  await page.route('**/v1/chat', async (route) => {
    const headers = {
      ...route.request().headers(),
      'x-test-force-classification': 'rate_limit',
    };
    await route.continue({ headers });
  });

  await expectWorkspaceReady(page);
  await triggerFallback(page, 'first failure for got it');
  await dismissTip(page, 'fallback', 'got-it');

  const freshPage = await page.context().newPage();
  await suppressTips(freshPage, ['roundtable']);
  await freshPage.route('**/v1/chat', async (route) => {
    const headers = {
      ...route.request().headers(),
      'x-test-force-classification': 'rate_limit',
    };
    await route.continue({ headers });
  });
  await expectWorkspaceReady(freshPage);
  await triggerFallback(freshPage, 'second failure in fresh tab');
  await expect(freshPage.getByTestId('tip-fallback')).toBeVisible({ timeout: 5_000 });
  await freshPage.close();
});

test('B2 cost got-it is session-only and returns in a fresh tab while spend remains over threshold', async ({ page }) => {
  await seedPricedChatModel();
  await suppressTips(page, ['roundtable']);

  await expectWorkspaceReady(page);
  await triggerCostTip(page, 'first priced request');
  await dismissTip(page, 'cost', 'got-it');

  const freshPage = await page.context().newPage();
  await suppressTips(freshPage, ['roundtable']);
  await expectWorkspaceReady(freshPage);
  await expect(freshPage.getByTestId('tip-cost')).toBeVisible({ timeout: 5_000 });
  await freshPage.close();
});

test('B2 cost dont-show persists across reload while spend remains over threshold', async ({ page }) => {
  await seedPricedChatModel();
  await suppressTips(page, ['roundtable']);

  await expectWorkspaceReady(page);
  await triggerCostTip(page, 'first priced request');
  await dismissTip(page, 'cost', 'dont-show');

  await page.reload();
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('tip-cost')).toHaveCount(0);
});

test('B2 image tip waits in queue until roundtable tip is dismissed', async ({ page }) => {
  await seedVisionChatModel();
  await suppressTips(page, ['fallback', 'cost']);

  await expectWorkspaceReady(page);
  await expect(page.getByTestId('tip-roundtable')).toBeVisible({ timeout: 5_000 });

  await dropImage(page);
  await expect(page.getByTestId('attachment-thumb')).toBeVisible();
  await expect(page.getByTestId('tip-image')).toHaveCount(0);

  await dismissTip(page, 'roundtable', 'got-it');
  await expect(page.getByTestId('tip-image')).toBeVisible({ timeout: 5_000 });
});

test('B2 fallback tip waits in queue until roundtable tip is dismissed', async ({ page }) => {
  await seedFallbackModels();
  await suppressTips(page, ['image', 'cost']);

  await page.route('**/v1/chat', async (route) => {
    const headers = {
      ...route.request().headers(),
      'x-test-force-classification': 'rate_limit',
    };
    await route.continue({ headers });
  });

  await expectWorkspaceReady(page);
  await expect(page.getByTestId('tip-roundtable')).toBeVisible({ timeout: 5_000 });

  await triggerFallback(page, 'queue fallback tip behind roundtable');
  await expect(page.getByTestId('tip-fallback')).toHaveCount(0);

  await dismissTip(page, 'roundtable', 'got-it');
  await expect(page.getByTestId('tip-fallback')).toBeVisible({ timeout: 5_000 });
});

test('B2 cost tip waits in queue until roundtable tip is dismissed', async ({ page }) => {
  await seedPricedChatModel();
  await suppressTips(page, ['image', 'fallback']);

  await expectWorkspaceReady(page);
  await expect(page.getByTestId('tip-roundtable')).toBeVisible({ timeout: 5_000 });

  await triggerCostTip(page, 'queue cost tip behind roundtable');
  await expect(page.getByTestId('tip-cost')).toHaveCount(0);

  await dismissTip(page, 'roundtable', 'got-it');
  await expect(page.getByTestId('tip-cost')).toBeVisible({ timeout: 5_000 });
});

test('B2 roundtable tip hides behind cost confirm and returns after cancel', async ({ page }) => {
  await seedPricedChatModel();
  await suppressTips(page, ['image', 'fallback', 'cost']);
  await setThresholdConfirmMemory('0.0000000001');

  await expectWorkspaceReady(page);
  await expect(page.getByTestId('tip-roundtable')).toBeVisible({ timeout: 5_000 });

  await page.getByTestId('composer-input').fill('trigger cost confirm');
  await page.getByTestId('composer-send').click();

  await expect(page.getByTestId('cost-confirm-dialog')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('tip-roundtable')).toHaveCount(0);

  await page.getByTestId('cost-confirm-cancel').click();
  await expect(page.getByTestId('cost-confirm-dialog')).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByTestId('tip-roundtable')).toBeVisible({ timeout: 5_000 });
});

test('B2 roundtable tip hides behind image picker and returns after cancel', async ({ page }) => {
  await seedImageGeneratorModels();
  await suppressTips(page, ['image', 'fallback', 'cost']);

  await expectWorkspaceReady(page);
  await expect(page.getByTestId('tip-roundtable')).toBeVisible({ timeout: 5_000 });

  await page.getByTestId('composer-input').fill('/image 画一张测试图');
  await page.getByTestId('composer-send').click();

  await expect(page.getByTestId('image-picker-dialog')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('tip-roundtable')).toHaveCount(0);

  await page.getByTestId('image-picker-cancel').click();
  await expect(page.getByTestId('image-picker-dialog')).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByTestId('tip-roundtable')).toBeVisible({ timeout: 5_000 });
});
