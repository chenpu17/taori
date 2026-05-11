/**
 * Operational cross-surface journeys.
 *
 * These specs model a user who keeps moving between chat, model operations,
 * cost monitoring, settings, and tools. API calls only seed BYOK-style
 * configuration or verify persisted state; all product behavior is exercised
 * through the Web UI.
 */
import { test, expect, type Locator, type Page } from '@playwright/test';
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

async function expectHorizontallyWithinViewport(page: Page, locator: Locator): Promise<void> {
  const box = await locator.boundingBox();
  expect(box).toBeTruthy();
  const viewport = page.viewportSize();
  expect(viewport).toBeTruthy();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width);
}

async function expectPageHasNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    return Math.max(doc.scrollWidth, document.body.scrollWidth) - doc.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(1);
}

async function expectElementHasNoHorizontalOverflow(locator: Locator): Promise<void> {
  const overflow = await locator.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

async function seedBrokenProvider(name = 'Broken Ops Provider'): Promise<string> {
  const res = await authedFetch(env, '/v1/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name,
      type: 'custom',
      base_url: 'https://broken-provider.invalid/v1',
    }),
  });
  expect(res.ok).toBeTruthy();
  return ((await res.json()) as { id: string }).id;
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

test('small viewport control center journey keeps budget, provider-risk, and focused costs readable', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const providerId = await seedProvider('Ops Small Viewport Mock');
  const chatId = await seedModel(providerId, {
    model_name: 'mock-small-chat',
    display_name: 'Small Viewport Chat',
    capability: 'chat',
    is_default_for: 'chat',
    supports_tools: true,
    price_input_per_1m: 1.2,
    price_output_per_1m: 2.4,
  });
  await seedModel(providerId, {
    model_name: 'mock-small-image',
    display_name: 'Small Viewport Image',
    capability: 'image',
    is_default_for: 'image',
    price_per_call: 0.04,
  });
  await seedBrokenProvider();

  await suppressTips(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  await sendChat(page, chatId, '生成一条会在控制中心看到预算与成本归因的基线消息');
  const realtimeRes = await authedFetch(env, '/v1/costs/realtime');
  const realtime = (await realtimeRes.json()) as { data: { month_usd: number } };
  const monthlyBudget = Math.max(realtime.data.month_usd / 2, 0.000001);
  await authedFetch(env, '/v1/memories', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      scope: 'global',
      scope_id: null,
      key: 'monthly_budget_usd',
      value: String(monthlyBudget),
    }),
  });
  await authedFetch(env, '/v1/memories?scope=global&key=monthly_budget_alert_state', {
    method: 'DELETE',
  });

  await page.reload();
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('open-settings').click();

  const controlCenter = page.getByTestId('control-center');
  await expect(controlCenter).toBeVisible();
  await page.getByTestId('control-center-nav-overview').click();
  await expect(page.getByTestId('control-center-overview')).toBeVisible();
  await expect(page.getByTestId('control-budget-alerts')).toContainText('本月预算已超出');
  await expect(page.getByTestId('control-provider-risk-queue')).toContainText('补 Provider Key');
  await expect(page.getByTestId('control-cost-attribution-overview')).toBeVisible();
  await expectHorizontallyWithinViewport(page, controlCenter);
  await expectElementHasNoHorizontalOverflow(controlCenter);
  await expectPageHasNoHorizontalOverflow(page);

  const providerRiskQueue = page.getByTestId('control-provider-risk-queue');
  await providerRiskQueue.getByRole('button', { name: '看成本影响' }).first().click();
  const costDashboard = page.getByTestId('cost-dashboard-panel');
  await expect(costDashboard).toBeVisible();
  const firstProviderCard = page.getByTestId('cost-dashboard-provider-card').first();
  await expect(firstProviderCard).toBeVisible();
  await firstProviderCard.getByRole('button', { name: /只看这个 Provider|当前聚焦中/ }).click();
  await expect(page.getByTestId('cost-dashboard-provider-focus-banner')).toBeVisible();
  await expect(
    page.locator('[data-testid="cost-dashboard-provider-card"][data-focused="1"]').first(),
  ).toBeVisible();
  await expectHorizontallyWithinViewport(page, costDashboard);
  await expectPageHasNoHorizontalOverflow(page);

  await page
    .locator('[data-testid="cost-dashboard-provider-card"][data-focused="1"]')
    .first()
    .getByRole('button', { name: '去模型中心' })
    .click();
  const modelCenter = page.getByTestId('model-center');
  await expect(modelCenter).toBeVisible();
  await expectHorizontallyWithinViewport(page, modelCenter);
  await expectElementHasNoHorizontalOverflow(modelCenter);
  await expectPageHasNoHorizontalOverflow(page);
});

test('control center search journey keeps overview shortcuts and runtime monitor coherent', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const providerId = await seedProvider('Ops Search Journey Mock');
  const chatId = await seedModel(providerId, {
    model_name: 'mock-search-chat',
    display_name: 'Search Journey Chat',
    capability: 'chat',
    is_default_for: 'chat',
    supports_tools: true,
    price_input_per_1m: 0.8,
    price_output_per_1m: 1.6,
  });
  await seedModel(providerId, {
    model_name: 'mock-search-image',
    display_name: 'Search Journey Image',
    capability: 'image',
    is_default_for: 'image',
    price_per_call: 0.03,
  });

  await suppressTips(page);
  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await sendChat(page, chatId, '先生成一条让控制中心监控、工具与成本面板都有数据的消息');

  await page.getByTestId('open-settings').click();
  const controlCenter = page.getByTestId('control-center');
  await expect(controlCenter).toBeVisible();

  const search = page.getByTestId('control-center-search');
  await search.fill('监控');
  await expect(page.getByTestId('control-runtime-section')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('control-runtime-cpu-detail')).toBeVisible();
  await expect(page.getByTestId('control-runtime-mode-detail')).toBeVisible();
  await expect(page.getByTestId('control-center-search-empty')).toHaveCount(0);

  await search.fill('工具');
  await expect(page.getByTestId('settings-tools')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('tool-toggle-builtin.image_generate')).toBeVisible();

  await search.fill('zzzz-control-center-empty');
  await expect(page.getByTestId('control-center-search-empty')).toBeVisible();

  await search.fill('');
  await page.getByTestId('control-center-nav-overview').click();
  await expect(page.getByTestId('control-center-overview')).toBeVisible();

  await page.getByTestId('control-center-open-costs').click();
  await expect(page.getByTestId('cost-dashboard-panel')).toBeVisible();
  await expect(page.getByTestId('cost-dashboard-total')).toBeVisible();

  await page.getByTestId('control-center-nav-overview').click();
  await page.getByTestId('control-center-open-tools').click();
  await expect(page.getByTestId('settings-tools')).toBeVisible();

  await page.getByTestId('control-center-nav-overview').click();
  await page.getByTestId('control-center-open-models').click();
  await expect(page.getByTestId('model-center')).toBeVisible();

  await page.getByTestId('control-center-nav-overview').click();
  await page.getByTestId('control-center-open-monitor').click();
  await expect(page.getByTestId('control-runtime-section')).toBeVisible();
  await expectHorizontallyWithinViewport(page, controlCenter);
  await expectElementHasNoHorizontalOverflow(controlCenter);
  await expectPageHasNoHorizontalOverflow(page);

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('control-center')).toHaveCount(0);
});
