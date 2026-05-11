import { test, expect } from '@playwright/test';
import { authedFetch, readSidecarEnv, resetSidecar, type SidecarEnv } from './_helpers';
import { startMockOpenAI } from './_mock-openai-server';

const MOCK_PORT = 17902;
const MOCK_BASE_URL = `http://127.0.0.1:${MOCK_PORT}/api/v3`;

let server: ReturnType<typeof startMockOpenAI> | null = null;
let env: SidecarEnv;

test.beforeAll(() => {
  server = startMockOpenAI(MOCK_PORT, {
    imageToolCalls: true,
    models: [
      {
        id: 'doubao-1-5-pro-32k-250115',
        name: 'doubao-1-5-pro-32k',
        object: 'model',
        status: null,
        created: 1,
        version: '250115',
      },
      {
        id: 'doubao-1-5-vision-pro-32k-250115',
        name: 'doubao-1-5-vision-pro-32k',
        object: 'model',
        status: null,
        created: 1,
        version: '250115',
      },
      {
        id: 'doubao-seedream-3-0-t2i-250415',
        name: 'doubao-seedream-3-0-t2i',
        object: 'model',
        status: null,
        created: 1,
        version: '250415',
      },
    ],
  });
  env = readSidecarEnv();
});

test.afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
});

test.beforeEach(async () => {
  await resetSidecar(env);
});

test('Ark onboarding preserves discovered tool/image/vision capabilities and the configured stack works after reload', async ({
  page,
}) => {
  test.setTimeout(120_000);

  await page.goto('/');
  await expect(page.getByTestId('onboarding')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('onb-provider-name')).toHaveValue('OpenRouter');
  await page.getByTestId('onb-provider-type').selectOption('volcengine_ark');
  await expect(page.getByTestId('onb-provider-name')).toHaveValue('火山方舟');
  await page.getByTestId('onb-provider-name').fill('PackyAPI 主账号');
  await page.getByTestId('onb-base-url').fill(MOCK_BASE_URL);
  await page.getByTestId('onb-api-key').fill('sk-ark-test');
  await page.getByTestId('onb-submit').click();

  await expect(page.getByTestId('onb-pick')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('onb-finish')).toContainText('导入 0 个模型');
  await expect(
    page.locator(
      '[data-testid="onb-candidate-check"][data-model-name="doubao-1-5-pro-32k-250115"]',
    ),
  ).not.toBeChecked();
  await expect(
    page.locator(
      '[data-testid="onb-candidate-check"][data-model-name="doubao-1-5-vision-pro-32k-250115"]',
    ),
  ).not.toBeChecked();
  await expect(
    page.locator(
      '[data-testid="onb-candidate-check"][data-model-name="doubao-seedream-3-0-t2i-250415"]',
    ),
  ).not.toBeChecked();
  await page
    .locator('[data-testid="onb-candidate-check"][data-model-name="doubao-1-5-pro-32k-250115"]')
    .check();
  await page
    .locator('[data-testid="onb-candidate-check"][data-model-name="doubao-1-5-vision-pro-32k-250115"]')
    .check();
  await page
    .locator('[data-testid="onb-candidate-check"][data-model-name="doubao-seedream-3-0-t2i-250415"]')
    .check();
  await page.getByTestId('onb-finish').click();

  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 15_000 });

  const providersRes = await authedFetch(env, '/v1/providers');
  const providersBody = (await providersRes.json()) as {
    providers: Array<{ name: string; type: string; base_url: string }>;
  };
  expect(providersBody.providers).toContainEqual(
    expect.objectContaining({
      name: 'PackyAPI 主账号',
      type: 'volcengine_ark',
      base_url: MOCK_BASE_URL,
    }),
  );

  const modelsRes = await authedFetch(env, '/v1/models');
  const body = (await modelsRes.json()) as {
    models: Array<{
      model_name: string;
      capability: string;
      supports_tools: boolean;
      supports_vision: boolean;
      is_default_for: string | null;
    }>;
  };
  const chat = body.models.find((m) => m.model_name === 'doubao-1-5-pro-32k-250115');
  const vision = body.models.find((m) => m.model_name === 'doubao-1-5-vision-pro-32k-250115');
  const image = body.models.find((m) => m.model_name === 'doubao-seedream-3-0-t2i-250415');
  expect(chat?.capability).toBe('chat');
  expect(chat?.supports_tools).toBe(true);
  expect(chat?.is_default_for).toBe('chat');
  expect(vision?.capability).toBe('multimodal');
  expect(vision?.supports_vision).toBe(true);
  expect(image?.capability).toBe('image');

  await expect(page.getByTestId('preflight-image')).toHaveAttribute('data-state', 'ready');
  await expect(page.getByTestId('preflight-image')).toContainText('自主调用工具');
  await expect(page.getByTestId('preflight-vision')).toHaveAttribute('data-state', 'fallback');

  await page.reload();
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('onboarding')).toHaveCount(0);
  await expect(page.getByTestId('preflight-image')).toHaveAttribute('data-state', 'ready');

  await page.getByTestId('composer-input').fill('帮我生成一张鸭子图片');
  await page.getByTestId('composer-send').click();
  await expect(page.getByTestId('image-picker-dialog')).toHaveCount(0);
  await expect(page.getByTestId('msg-tool-images')).toBeVisible({ timeout: 30_000 });
});
