import { test, expect, type Page } from '@playwright/test';
import { authedFetch, readSidecarEnv, resetSidecar } from './_helpers';

const env = readSidecarEnv();

const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

async function suppressTips(page: Page, tipIds: Array<'roundtable' | 'image' | 'fallback' | 'cost'>) {
  await page.addInitScript((ids) => {
    for (const id of ids) {
      localStorage.setItem(`tip_${id}_first_seen`, 'true');
    }
  }, tipIds);
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
