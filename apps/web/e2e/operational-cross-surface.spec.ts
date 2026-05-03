/**
 * Operational cross-surface journeys.
 *
 * These specs model a user who keeps moving between chat, model operations,
 * cost monitoring, settings, and tools. API calls only seed BYOK-style
 * configuration or verify persisted state; all product behavior is exercised
 * through the Web UI.
 */
import { test, expect, type Page } from '@playwright/test';
import {
  authedFetch,
  readSidecarEnv,
  resetSidecar,
  type SidecarEnv,
} from './_helpers';
import { startMockOpenAI } from './_mock-openai-server';

const MOCK_PORT = 17910;
const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}/v1`;

let server: ReturnType<typeof startMockOpenAI> | null = null;
let env: SidecarEnv;

test.beforeAll(() => {
  server = startMockOpenAI(MOCK_PORT, {
    imageToolCalls: true,
    fixedReply: '运营验证回复：已结合当前模型、设置与上下文完成处理。',
  });
  env = readSidecarEnv();
});

test.afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
});

test.beforeEach(async () => {
  await resetSidecar(env);
});

async function seedProvider(name = 'Ops Mock'): Promise<string> {
  const res = await authedFetch(env, '/v1/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name,
      type: 'openai',
      base_url: MOCK_URL,
      api_key: 'sk-test',
    }),
  });
  expect(res.ok).toBeTruthy();
  return ((await res.json()) as { id: string }).id;
}

async function seedModel(
  providerId: string,
  spec: {
    model_name: string;
    display_name: string;
    capability: 'chat' | 'image';
    is_default_for?: 'chat' | 'image' | null;
    price_input_per_1m?: number;
    price_output_per_1m?: number;
    price_per_call?: number;
    supports_tools?: boolean;
    supports_vision?: boolean;
  },
): Promise<string> {
  const res = await authedFetch(env, '/v1/models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider_id: providerId,
      supports_tools: spec.supports_tools ?? false,
      supports_vision: spec.supports_vision ?? false,
      ...spec,
    }),
  });
  expect(res.ok).toBeTruthy();
  return ((await res.json()) as { id: string }).id;
}

async function suppressTips(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('tip_image_first_seen', 'true');
    localStorage.setItem('tip_fallback_first_seen', 'true');
    localStorage.setItem('tip_cost_first_seen', 'true');
    localStorage.setItem('tip_roundtable_first_seen', 'true');
  });
}

async function sendChat(page: Page, modelId: string, text: string): Promise<void> {
  await expect(page.getByTestId('composer-input')).toBeEnabled({ timeout: 20_000 });
  await page.getByTestId('active-model').selectOption(modelId);
  const before = await page.locator('.msg.assistant').count();
  await page.getByTestId('composer-input').fill(text);
  await page.getByTestId('composer-send').click();
  await expect
    .poll(async () => await page.locator('.msg.assistant').count(), {
      timeout: 25_000,
    })
    .toBeGreaterThan(before);
  await expect(page.getByTestId('composer-input')).toBeEnabled({ timeout: 20_000 });
}

test('chat to monitoring journey: multi-model usage appears in cost dashboard and model health', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const providerId = await seedProvider('Ops Monitoring Mock');
  const fastId = await seedModel(providerId, {
    model_name: 'mock-fast-ops',
    display_name: 'Fast Ops',
    capability: 'chat',
    is_default_for: 'chat',
    price_input_per_1m: 0.2,
    price_output_per_1m: 0.4,
  });
  const deepId = await seedModel(providerId, {
    model_name: 'mock-deep-ops',
    display_name: 'Deep Ops',
    capability: 'chat',
    price_input_per_1m: 2,
    price_output_per_1m: 4,
  });

  await suppressTips(page);
  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  await sendChat(page, fastId, '先用快速模型整理今天客服投诉的三个主题');
  const convId = await page.getByTestId('chat-panel').getAttribute('data-active-conv');
  expect(convId).toBeTruthy();
  await sendChat(page, deepId, '同一会话里切到深度模型，补充风险优先级');

  await expect(page.getByTestId('chat-panel')).toHaveAttribute('data-active-conv', convId!);
  await expect(page.getByTestId('msg-cost')).toHaveCount(2, { timeout: 10_000 });

  await page.getByTestId('open-cost-dashboard').click();
  await expect(page.getByTestId('cost-dashboard-panel')).toBeVisible();
  await expect(page.getByTestId('cost-dashboard-total')).toBeVisible();
  await page.getByTestId('cost-dashboard-group-model').click();
  await expect
    .poll(async () => await page.getByTestId('cost-dashboard-row').count(), {
      timeout: 10_000,
    })
    .toBeGreaterThanOrEqual(2);
  await expect
    .poll(async () => await page.getByTestId('cost-call-log-row').count(), {
      timeout: 10_000,
    })
    .toBeGreaterThanOrEqual(2);

  await page.getByTestId('control-center-nav-models').click();
  await expect(page.getByTestId('model-center')).toBeVisible();
  await page.getByTestId(`model-health-toggle-${deepId}`).click();
  const healthPanel = page.getByTestId(`model-health-panel-${deepId}`);
  await expect(healthPanel).toBeVisible();
  await expect
    .poll(async () => Number((await healthPanel.getByTestId('model-health-calls').textContent()) ?? '0'), {
      timeout: 10_000,
    })
    .toBeGreaterThanOrEqual(1);
});

test('settings and tools journey: budget gate and image tool toggle affect the next chat action', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const providerId = await seedProvider('Ops Settings Tools Mock');
  const chatId = await seedModel(providerId, {
    model_name: 'mock-tool-chat',
    display_name: 'Tool Chat',
    capability: 'chat',
    is_default_for: 'chat',
    supports_tools: true,
    price_input_per_1m: 1,
    price_output_per_1m: 2,
  });
  await seedModel(providerId, {
    model_name: 'mock-image',
    display_name: 'Image Ops',
    capability: 'image',
    is_default_for: 'image',
    price_per_call: 0.04,
  });

  await suppressTips(page);
  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('active-model')).toHaveValue(chatId);
  await expect(page.getByTestId('preflight-image')).toContainText('自主调用工具');

  await sendChat(page, chatId, '先生成一条运营监控基线消息');

  await page.getByTestId('open-settings').click();
  await expect(page.getByTestId('settings-monthly-budget')).toBeVisible();
  await page.getByTestId('monthly-budget-input').fill('0.000001');
  await page.getByTestId('monthly-budget-save').click();
  await expect(page.getByTestId('monthly-budget-message')).toContainText('月度软预算已保存');
  await page.getByTestId('settings-close').click();
  await expect(page.getByTestId('cost-bar')).toHaveAttribute('data-budget-level', 'over', {
    timeout: 10_000,
  });

  await page.getByTestId('composer-input').fill('预算超限后这条消息应该先确认');
  await page.getByTestId('composer-send').click();
  await expect(page.getByTestId('cost-confirm-dialog')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('cost-confirm-dialog')).toContainText('本月预算已达');
  await page.getByTestId('cost-confirm-cancel').click();
  await expect(page.getByTestId('cost-confirm-dialog')).toHaveCount(0);

  await page.getByTestId('open-settings').click();
  await expect(page.getByTestId('settings-monthly-budget')).toBeVisible();
  await page.getByTestId('monthly-budget-clear').click();
  await expect(page.getByTestId('monthly-budget-message')).toContainText('已关闭月度软预算');
  await page.getByTestId('settings-close').click();
  await expect(page.getByTestId('cost-bar')).toHaveAttribute('data-budget-level', 'none', {
    timeout: 10_000,
  });

  await page.getByTestId('open-settings').click();
  await page.getByTestId('settings-tab-tools').click();
  const imageToggle = page.getByTestId('tool-toggle-builtin.image_generate');
  await expect(imageToggle).toContainText('已启用');
  await imageToggle.click();
  await expect(imageToggle).toContainText('已关闭');
  await page.getByTestId('settings-close').click();

  await expect(page.getByTestId('preflight-image')).toHaveAttribute('data-state', 'warn');
  await expect(page.getByTestId('preflight-image')).toContainText('工具已关闭');
  await page.getByTestId('composer-input').fill('/image 预算与工具关闭后的测试图');
  await page.getByTestId('composer-send').click();
  await expect(page.getByTestId('image-picker-dialog')).toHaveCount(0);
  await expect(page.getByTestId('drop-error')).toContainText('图像生成工具已关闭', {
    timeout: 10_000,
  });

  await page.getByTestId('open-settings').click();
  await page.getByTestId('settings-tab-tools').click();
  await imageToggle.click();
  await expect(imageToggle).toContainText('已启用');
  await page.getByTestId('settings-close').click();

  await expect(page.getByTestId('preflight-image')).toHaveAttribute('data-state', 'ready');
  await page.getByTestId('composer-input').fill('/image 重新启用后应打开图像模型选择');
  await page.getByTestId('composer-send').click();
  await expect(page.getByTestId('image-picker-dialog')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('image-picker-cancel').click();
});
