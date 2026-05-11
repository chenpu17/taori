import { test, expect } from '@playwright/test';
import { authedFetch, readSidecarEnv, resetSidecar, type SidecarEnv } from './_helpers';
import { startMockOpenAI } from './_mock-openai-server';

const MOCK_PORT = 17904;
const MOCK_BASE_URL = `http://127.0.0.1:${MOCK_PORT}/openai/v1`;

let server: ReturnType<typeof startMockOpenAI> | null = null;
let env: SidecarEnv;

test.beforeAll(() => {
  server = startMockOpenAI(MOCK_PORT, {
    imageToolCalls: true,
    models: [
      { id: 'deepseek-v3.2', name: 'DeepSeek V3.2', object: 'model' },
      { id: 'qwen2.5-vl-72b', name: 'Qwen2.5 VL 72B', object: 'model' },
      { id: 'qwen-image', name: 'Qwen Image', object: 'model' },
      { id: 'Wan2.2-T2V-A14B', name: 'Wan2.2 T2V A14B', object: 'model' },
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

test('Huawei MaaS onboarding imports chat, vision, image and video models with correct capabilities', async ({
  page,
}) => {
  test.setTimeout(120_000);

  await page.goto('/');
  await expect(page.getByTestId('onboarding')).toBeVisible({ timeout: 10_000 });

  const select = page.getByTestId('onb-provider-type');
  await expect(select.locator('option', { hasText: '华为云 MaaS' })).toHaveCount(1);
  await select.selectOption('huawei_maas');
  await expect(page.getByTestId('onb-base-url')).toHaveValue(
    'https://api.modelarts-maas.com/openai/v1',
  );
  await page.getByTestId('onb-base-url').fill(MOCK_BASE_URL);
  await page.getByTestId('onb-api-key').fill('hw-maas-test-key');
  await page.getByTestId('onb-submit').click();

  await expect(page.getByTestId('onb-pick')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('onb-finish')).toContainText('导入 0 个模型');
  for (const name of ['deepseek-v3.2', 'qwen2.5-vl-72b', 'qwen-image', 'Wan2.2-T2V-A14B']) {
    await expect(
      page.locator(`[data-testid="onb-candidate-check"][data-model-name="${name}"]`),
    ).not.toBeChecked();
    await page.locator(`[data-testid="onb-candidate-check"][data-model-name="${name}"]`).check();
  }
  await page.getByTestId('onb-finish').click();

  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 15_000 });
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
  const chat = body.models.find((m) => m.model_name === 'deepseek-v3.2');
  const vision = body.models.find((m) => m.model_name === 'qwen2.5-vl-72b');
  const image = body.models.find((m) => m.model_name === 'qwen-image');
  const video = body.models.find((m) => m.model_name === 'Wan2.2-T2V-A14B');
  expect(chat?.capability).toBe('chat');
  expect(chat?.supports_tools).toBe(true);
  expect(chat?.is_default_for).toBe('chat');
  expect(vision?.capability).toBe('multimodal');
  expect(vision?.supports_vision).toBe(true);
  expect(image?.capability).toBe('image');
  expect(video?.capability).toBe('video');

  await expect(page.getByTestId('preflight-image')).toHaveAttribute('data-state', 'ready');
  await expect(
    page.getByTestId('active-model').locator('option', { hasText: 'DeepSeek V3.2 · 华为云 MaaS' }),
  ).toHaveCount(1);
  await page.getByTestId('composer-input').fill('帮我生成一张熊猫图片');
  await page.getByTestId('composer-send').click();
  await expect(page.getByTestId('image-picker-dialog')).toHaveCount(0);
  await expect(page.getByTestId('msg-tool-images')).toBeVisible({ timeout: 30_000 });
});
