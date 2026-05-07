/**
 * Resilience user-journey validation.
 *
 * Covers higher-risk real workflows that combine configuration correction,
 * roundtable handoff, cost controls, tools, and Run Timeline visibility.
 */
import { test, expect, type Locator, type Page } from '@playwright/test';
import {
  authedFetch,
  readSidecarEnv,
  resetSidecar,
  type SidecarEnv,
} from './_helpers';
import { startMockOpenAI } from './_mock-openai-server';

const MOCK_PORT = 17933;
const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}/v1`;

let server: ReturnType<typeof startMockOpenAI> | null = null;
let env: SidecarEnv;

test.beforeAll(() => {
  server = startMockOpenAI(MOCK_PORT, {
    imageToolCalls: true,
    webToolCalls: true,
    streamDelayMs: 40,
  });
  env = readSidecarEnv();
});

test.afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
});

test.beforeEach(async ({ page }) => {
  await resetSidecar(env);
  await suppressTips(page);
});

async function suppressTips(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('tip_image_first_seen', 'true');
    localStorage.setItem('tip_fallback_first_seen', 'true');
    localStorage.setItem('tip_cost_first_seen', 'true');
    localStorage.setItem('tip_roundtable_first_seen', 'true');
  });
}

async function seedProvider(name = 'Resilience Journey Mock'): Promise<string> {
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
    supports_tools?: boolean;
    price_input_per_1m?: number;
    price_output_per_1m?: number;
    price_per_call?: number;
  },
): Promise<string> {
  const res = await authedFetch(env, '/v1/models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider_id: providerId,
      supports_tools: spec.supports_tools ?? false,
      supports_vision: false,
      price_input_per_1m: spec.capability === 'chat' ? 0.5 : undefined,
      price_output_per_1m: spec.capability === 'chat' ? 1.5 : undefined,
      ...spec,
    }),
  });
  expect(res.ok).toBeTruthy();
  return ((await res.json()) as { id: string }).id;
}

async function seedToolImageStack(options: { toolCapable: boolean }): Promise<{
  chatId: string;
  imageId: string;
}> {
  const providerId = await seedProvider();
  const chatId = await seedModel(providerId, {
    model_name: options.toolCapable ? 'res-tool-chat' : 'res-plain-chat',
    display_name: options.toolCapable ? 'Res Tool Chat' : 'Res Plain Chat',
    capability: 'chat',
    is_default_for: 'chat',
    supports_tools: options.toolCapable,
  });
  const imageId = await seedModel(providerId, {
    model_name: 'res-image',
    display_name: 'Res Image',
    capability: 'image',
    is_default_for: 'image',
    price_per_call: 0.04,
  });
  return { chatId, imageId };
}

async function seedRoundtableStack(): Promise<void> {
  const providerId = await seedProvider('Resilience Roundtable Mock');
  for (let i = 0; i < 3; i++) {
    await seedModel(providerId, {
      model_name: i === 0 ? 'mock-strategy' : i === 1 ? 'mock-user' : 'mock-tech',
      display_name: i === 0 ? '战略模型' : i === 1 ? '用户模型' : '技术模型',
      capability: 'chat',
      is_default_for: i === 0 ? 'chat' : null,
    });
  }
}

async function sendAndWait(page: Page, text: string, timeout = 45_000): Promise<void> {
  const before = await page.locator('.msg.assistant').count();
  await page.getByTestId('composer-input').fill(text);
  await page.getByTestId('composer-send').click();
  await expect
    .poll(async () => await page.locator('.msg.assistant').count(), { timeout })
    .toBeGreaterThan(before);
  await expect(page.getByTestId('composer-stop')).toBeHidden({ timeout });
}

async function openTimeline(page: Page): Promise<Locator> {
  await page.getByTestId('open-run-timeline').click();
  const panel = page.getByTestId('run-timeline-panel');
  await expect(panel).toBeVisible({ timeout: 10_000 });
  await expect(panel.getByTestId('run-event').first()).toBeVisible({ timeout: 10_000 });
  return panel;
}

async function expectNoHorizontalOverflow(root: Locator): Promise<void> {
  const overflow = await root.evaluate((node) => {
    const rootRect = node.getBoundingClientRect();
    const bad: string[] = [];
    for (const el of node.querySelectorAll<HTMLElement>('*')) {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      if (rect.left < rootRect.left - 1 || rect.right > rootRect.right + 1) {
        bad.push(`${el.tagName.toLowerCase()}.${el.className}`);
      }
    }
    return bad.slice(0, 6);
  });
  expect(overflow).toEqual([]);
}

async function currentMonthUsd(): Promise<number> {
  const res = await authedFetch(env, '/v1/costs/realtime');
  const body = (await res.json()) as { data: { month_usd: number } };
  return body.data.month_usd;
}

async function setMonthlyBudget(value: number): Promise<void> {
  await authedFetch(env, '/v1/memories', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      scope: 'global',
      scope_id: null,
      key: 'monthly_budget_usd',
      value: String(value),
    }),
  });
  await authedFetch(env, '/v1/memories?scope=global&key=monthly_budget_alert_state', {
    method: 'DELETE',
  });
}

test('model capability correction turns image requests from picker flow into tool-call flow', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await seedToolImageStack({ toolCapable: false });

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('preflight-image')).toHaveAttribute('data-state', 'warn');
  await expect(page.getByTestId('preflight-image')).toContainText('不支持工具');

  await page.getByTestId('composer-input').fill('生成一张产品路线图海报');
  await page.getByTestId('composer-send').click();
  await expect(page.getByTestId('image-picker-dialog')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('image-picker-cancel').click();
  await expect(page.getByTestId('image-picker-dialog')).toHaveCount(0);

  await page.getByTestId('preflight-open-model-center').click();
  await expect(page.getByTestId('model-center')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('model-center-tab-chat').click();
  await page.locator('[data-testid^="model-edit-"]').first().click();
  await expect(page.getByTestId('model-editor')).toBeVisible();
  await page.getByTestId('model-editor-supports-tools').check();
  await page.getByTestId('model-editor-save').click();
  await expect(page.getByTestId('model-editor')).toHaveCount(0, { timeout: 10_000 });
  await page.getByTestId('model-center-close').click();

  await expect(page.getByTestId('preflight-image')).toHaveAttribute('data-state', 'ready', {
    timeout: 10_000,
  });
  await expect(page.getByTestId('preflight-image')).toContainText('自主调用工具');
  await sendAndWait(page, '现在直接生成一张产品路线图海报');
  await expect(page.getByTestId('image-picker-dialog')).toHaveCount(0);
  await expect(page.getByTestId('msg-tool-images')).toBeVisible({ timeout: 30_000 });

  const timeline = await openTimeline(page);
  await expect(timeline.getByTestId('run-event').filter({ hasText: '4 个工具可见' }).first()).toBeVisible();
  await expect(timeline.getByTestId('run-event').filter({ hasText: '生成图片' }).first()).toBeVisible();
  await expectNoHorizontalOverflow(timeline);
});

test('chat research can branch into roundtable, return the conclusion, and continue in chat', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await seedRoundtableStack();

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await sendAndWait(page, '先帮我整理 SaaS 计费模型的背景信息');
  const originalConvId = await page.getByTestId('chat-panel').getAttribute('data-active-conv');
  expect(originalConvId).toBeTruthy();

  await page.getByTestId('composer-input').fill('围绕 SaaS 计费模型，请发起圆桌讨论');
  await page.getByTestId('composer-roundtable').click();
  const dlg = page.getByTestId('roundtable-launch-dialog');
  await expect(dlg).toBeVisible();
  await dlg.getByTestId('roundtable-mode-select').selectOption('deep');
  await dlg.getByTestId('roundtable-launch-start').click();
  await expect(dlg.getByTestId('roundtable-preview')).toBeVisible({ timeout: 20_000 });
  await dlg.getByTestId('roundtable-launch-continue').click();

  const panel = page.getByTestId('roundtable-panel');
  await expect(panel).toBeVisible({ timeout: 15_000 });
  await panel.getByTestId('roundtable-action-start-round').click();
  await expect(panel.getByTestId('roundtable-cell-0-1')).toHaveClass(/roundtable-cell-complete/, {
    timeout: 30_000,
  });
  await panel.getByTestId('roundtable-action-next-round').click();
  await expect(panel.getByTestId('roundtable-cell-0-2')).toHaveClass(/roundtable-cell-complete/, {
    timeout: 30_000,
  });
  await panel.getByTestId('roundtable-action-summarize').click();
  await expect(panel.getByTestId('roundtable-summary')).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByTestId('roundtable-summary')).toContainText('推荐决策');
  await expect(panel.getByTestId('roundtable-total-cost')).toContainText('$');

  const loopback = panel.getByTestId('roundtable-loopback');
  await expect(loopback).toContainText('已带回', { timeout: 10_000 });
  await loopback.click();
  await expect(panel).toBeHidden({ timeout: 10_000 });
  await expect(page.getByTestId('chat-panel')).toHaveAttribute('data-active-conv', originalConvId!);
  await expect(page.getByTestId('messages')).toContainText('来自圆桌讨论');

  await sendAndWait(page, '基于圆桌结论，给我三条可以明天执行的动作');
  await expect(page.getByTestId('chat-panel')).toHaveAttribute('data-active-conv', originalConvId!);
  await expect(page.getByTestId('messages')).toContainText('基于圆桌结论');
  await expect(page.getByTestId('roundtable-associated-banner')).toBeVisible();
  await page.getByTestId('roundtable-associated-open').click();
  await expect(page.getByTestId('roundtable-panel')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('roundtable-summary')).toBeVisible();
});

test('over-budget confirmation still allows an intentional web tool run with visible cost trail', async ({
  page,
}) => {
  test.setTimeout(150_000);
  const { chatId } = await seedToolImageStack({ toolCapable: true });

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('active-model').selectOption(chatId);
  await sendAndWait(page, '先产生一笔基础成本，用于触发预算上限');

  const spent = await currentMonthUsd();
  await setMonthlyBudget(Math.max(spent / 2, 0.000001));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('cost-bar')).toHaveAttribute('data-budget-level', 'over', {
    timeout: 10_000,
  });

  await page.getByTestId('composer-input').fill('预算已超，但我确认继续：请抓取网页 https://example.com/ 并总结');
  await page.getByTestId('composer-send').click();
  const confirm = page.getByTestId('cost-confirm-dialog');
  await expect(confirm).toBeVisible({ timeout: 10_000 });
  await expect(confirm).toContainText('本月预算已达');
  await confirm.getByTestId('cost-confirm-continue').click();
  await expect(confirm).toHaveCount(0, { timeout: 10_000 });

  await expect(page.locator('[data-testid="tool-trace-step"][data-tool="builtin.web_fetch"]').last()).toBeVisible({
    timeout: 30_000,
  });
  const timeline = await openTimeline(page);
  await expect(timeline.getByTestId('run-event').filter({ hasText: '抓取网页' }).first()).toBeVisible();
  await expect(timeline.getByTestId('run-event').filter({ hasText: '成本记录' }).first()).toBeVisible();
  await expectNoHorizontalOverflow(timeline);
  await timeline.getByTestId('run-timeline-close').click();

  await page.getByTestId('open-cost-dashboard').click();
  await expect(page.getByTestId('cost-dashboard-panel')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('cost-dashboard-group-feature').click();
  await expect(page.getByTestId('cost-dashboard-row').filter({ hasText: 'tool_call' }).first()).toBeVisible({
    timeout: 10_000,
  });
});
