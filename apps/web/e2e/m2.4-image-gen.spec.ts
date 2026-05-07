import { test, expect } from '@playwright/test';
import { readSidecarEnv, resetSidecar, authedFetch } from './_helpers';

/**
 * M2.4 — explicit command → picker → image_generate flow.
 *
 * We seed:
 *   - one chat-capable model (so onboarding completes / chat works)
 *   - one image-capable model (so the picker has a valid choice)
 * Then we type "/image 画一张机器人", expect the picker dialog, click the
 * X-Test-Force-Image-Result=success path, and verify a new assistant
 * message lands.
 */

let env: ReturnType<typeof readSidecarEnv>;
let imageModelId: string;
let chatModelId: string;

test.beforeEach(async () => {
  env = readSidecarEnv();
  await resetSidecar(env);
  const pr = await authedFetch(env, '/v1/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'OAI',
      type: 'openai',
      base_url: 'https://api.openai.example.com/v1',
      api_key: 'sk-test',
    }),
  });
  const provider = (await pr.json()) as { id: string };
  const cm = await authedFetch(env, '/v1/models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider_id: provider.id,
      model_name: 'gpt-4o',
      capability: 'chat',
      display_name: 'Chat 4o',
      is_default_for: 'chat',
    }),
  });
  chatModelId = ((await cm.json()) as { id: string }).id;
  const im = await authedFetch(env, '/v1/models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider_id: provider.id,
      model_name: 'dall-e-3',
      capability: 'image',
      display_name: 'DALL-E 3',
      price_per_call: 0.04,
    }),
  });
  imageModelId = ((await im.json()) as { id: string }).id;
});

test('M2.4 preflight explains explicit image command for non-tool chat model', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  const image = page.getByTestId('preflight-image');
  await expect(image).toBeVisible({ timeout: 10_000 });
  await expect(image).toHaveAttribute('data-state', 'warn');
  await expect(image).toContainText('打开生成器');
});

test('M2.4 preflight explains tool-call image generation for tool-capable chat model', async ({ page }) => {
  await authedFetch(env, `/v1/models/${chatModelId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ supports_tools: true }),
  });

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  const image = page.getByTestId('preflight-image');
  await expect(image).toBeVisible({ timeout: 10_000 });
  await expect(image).toHaveAttribute('data-state', 'ready');
  await expect(image).toContainText('自主调用工具');
});

test('M2.4 preflight updates after editing model tool capability in Model Center', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  const image = page.getByTestId('preflight-image');
  await expect(image).toHaveAttribute('data-state', 'warn');

  await page.getByTestId('preflight-open-model-center').click();
  await expect(page.getByTestId('model-center')).toBeVisible();
  await page.getByTestId(`model-edit-${chatModelId}`).click();
  await expect(page.getByTestId('model-editor')).toBeVisible();
  await page.getByTestId('model-editor-supports-tools').check();
  await page.getByTestId('model-editor-save').click();
  await expect(page.getByTestId('model-editor')).toHaveCount(0);
  await page.getByTestId('model-center-close').click();

  await expect(image).toHaveAttribute('data-state', 'ready', { timeout: 10_000 });
  await expect(image).toContainText('自主调用工具');
});

test('M2.4 explicit image command → picker opens → force=success → assistant message arrives', async ({ page }) => {
  // Inject the test-force header on tool invokes (renderer-driven calls).
  await page.route('**/v1/tools/invoke', async (route) => {
    const headers = {
      ...route.request().headers(),
      'x-test-force-image-result': 'success',
    };
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.continue({ headers });
  });

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  await page.getByTestId('composer-input').fill('/image 画一张机器人');
  await page.getByTestId('composer-send').click();

  const dialog = page.getByTestId('image-picker-dialog');
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await expect(dialog.getByTestId('image-picker-prompt')).toContainText('画一张机器人');
  await expect(dialog.getByTestId(`image-model-radio-${imageModelId}`)).toBeChecked();

  await dialog.getByTestId('image-picker-submit').click();

  // M2 §7 step 6 — high-cost confirm dialog appears (image_always default ON).
  const confirm = page.getByTestId('cost-confirm-dialog');
  await expect(confirm).toBeVisible({ timeout: 10_000 });
  await confirm.getByTestId('cost-confirm-continue').click();
  await expect(page.getByTestId('image-generation-progress')).toBeVisible({ timeout: 10_000 });

  // Picker closes once the tool succeeds + history reload completes.
  await expect(dialog).toBeHidden({ timeout: 10_000 });

  // Inserted assistant message should be visible in the chat panel.
  const assistant = page.locator('.msg.assistant').last();
  await expect(assistant).toContainText(/Generated with|DALL-E/i, { timeout: 10_000 });
  await expect(page.getByTestId('msg-tool-images')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('tool-image-open')).toBeVisible();

  await page.getByTestId('tool-image-open').click();
  const lightbox = page.getByTestId('image-lightbox');
  await expect(lightbox).toBeVisible();
  await expect(lightbox.locator('.image-lightbox__stage img')).toBeVisible();
  await lightbox.getByTestId('image-lightbox-zoom-in').click();
  await expect(lightbox.getByTestId('image-lightbox-zoom-reset')).toContainText('125%');
  const downloadPromise = page.waitForEvent('download');
  await lightbox.getByTestId('image-lightbox-save').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.(png|jpg|jpeg|webp)$/i);
  await lightbox.getByTestId('image-lightbox-close').click();
  await expect(lightbox).toHaveCount(0);
});

test('M2.4 explicit /image command opens picker', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  await page.getByTestId('composer-input').fill('/image a robot');
  await page.getByTestId('composer-send').click();

  const dialog = page.getByTestId('image-picker-dialog');
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await expect(dialog.getByTestId('image-picker-prompt')).toContainText('a robot');
  await expect(dialog.getByTestId('image-memory-hint')).toContainText('仅本次不会写入偏好');
  await expect(dialog.getByTestId(`image-model-radio-${imageModelId}`)).toBeChecked();
});

test('M2.4 model selectors distinguish same model names by provider', async ({ page }) => {
  const pr = await authedFetch(env, '/v1/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Huawei MaaS',
      type: 'huawei_maas',
      base_url: 'https://huawei.example.com/openai/v1',
      api_key: 'hw-test',
    }),
  });
  const huawei = (await pr.json()) as { id: string };
  await authedFetch(env, '/v1/models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider_id: huawei.id,
      model_name: 'gpt-4o',
      capability: 'chat',
      display_name: 'Chat 4o',
    }),
  });
  await authedFetch(env, '/v1/models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider_id: huawei.id,
      model_name: 'dall-e-3-compatible',
      capability: 'image',
      display_name: 'DALL-E 3',
      price_per_call: 0.03,
    }),
  });

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  const activeOptions = page.getByTestId('active-model').locator('option');
  await expect(activeOptions.filter({ hasText: 'Chat 4o · OAI' })).toHaveCount(1);
  await expect(activeOptions.filter({ hasText: 'Chat 4o · Huawei MaaS' })).toHaveCount(1);

  await page.getByTestId('composer-input').fill('/image a robot');
  await page.getByTestId('composer-send').click();
  const dialog = page.getByTestId('image-picker-dialog');
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  const imageOptions = dialog.getByTestId('image-model-list').locator('label');
  await expect(imageOptions.filter({ hasText: 'DALL-E 3 · OAI' })).toHaveCount(1);
  await expect(imageOptions.filter({ hasText: 'DALL-E 3 · Huawei MaaS' })).toHaveCount(1);
});

test('M2.4 preflight image model selector controls the picker default', async ({ page }) => {
  const pr = await authedFetch(env, '/v1/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'PackyAPI',
      type: 'packyapi',
      base_url: 'https://www.packyapi.com/v1',
      api_key: 'sk-packy-test',
    }),
  });
  const provider = (await pr.json()) as { id: string };
  const im = await authedFetch(env, '/v1/models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider_id: provider.id,
      model_name: 'gpt-image-2',
      capability: 'image',
      display_name: 'GPT Image 2',
      price_per_call: 0.01,
    }),
  });
  const cheaperImageModelId = ((await im.json()) as { id: string }).id;

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  const imageSelect = page.getByTestId('preflight-image-model-select');
  await expect(imageSelect).toBeVisible({ timeout: 10_000 });
  await expect(imageSelect).toHaveValue(cheaperImageModelId);

  await imageSelect.selectOption(imageModelId);
  await expect(page.getByTestId('preflight-image-model-scope')).toContainText('全局');

  const memory = await authedFetch(env, '/v1/memories?scope=global&key=image_model_default');
  expect(((await memory.json()) as { data: { value: string | null } }).data.value).toBe(imageModelId);

  await page.getByTestId('composer-input').fill('/image a robot');
  await page.getByTestId('composer-send').click();

  const dialog = page.getByTestId('image-picker-dialog');
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await expect(dialog.getByTestId(`image-model-radio-${imageModelId}`)).toBeChecked();
});

test('M2.4 natural-language image request opens picker for non-tool chat model', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  await page.getByTestId('composer-input').fill('画一张机器人');
  await page.getByTestId('composer-send').click();

  // Non-tool chat models cannot autonomously call image_generate, so clear
  // image intents fall back to the same picker as /image.
  await expect(page.getByTestId('image-picker-dialog')).toBeVisible({ timeout: 10_000 });
});
