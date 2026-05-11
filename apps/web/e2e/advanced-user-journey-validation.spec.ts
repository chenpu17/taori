/**
 * Advanced user-journey validation.
 *
 * These specs drive the Web UI through realistic recovery and collaboration
 * paths: first setup after a mistake, reload while a response is running, and
 * two browser windows sharing a conversation with session-level tool policy.
 */
import { test, expect, type Locator, type Page } from '@playwright/test';
import {
  authedFetch,
  readSidecarEnv,
  resetSidecar,
  type SidecarEnv,
} from './_helpers';
import { startMockOpenAI } from './_mock-openai-server';

const MOCK_PORT = 17932;
const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}/v1`;
const MOCK_ARK_URL = `http://127.0.0.1:${MOCK_PORT}/api/v3`;

let server: ReturnType<typeof startMockOpenAI> | null = null;
let env: SidecarEnv;
const mockRequests: Array<{
  model: string;
  toolNames: string[];
  lastUserText: string;
}> = [];

test.beforeAll(() => {
  server = startMockOpenAI(MOCK_PORT, {
    imageToolCalls: true,
    webToolCalls: true,
    streamDelayMs: 350,
    fixedReply:
      '高级用户旅程验证回复：我已根据当前上下文继续处理，并保持会话状态一致。',
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
    onChatRequest: (body) => {
      const tools = Array.isArray(body.tools) ? body.tools : [];
      const toolNames = tools
        .map((item) => {
          if (!item || typeof item !== 'object') return null;
          const fn = (item as { function?: { name?: unknown } }).function;
          return typeof fn?.name === 'string' ? fn.name : null;
        })
        .filter((name): name is string => Boolean(name));
      const lastUser = [...body.messages].reverse().find((m) => m.role === 'user');
      const content = lastUser?.content;
      const lastUserText =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content.map((p) => p.text ?? '').join('')
            : '';
      mockRequests.push({ model: body.model, toolNames, lastUserText });
    },
  });
  env = readSidecarEnv();
});

test.afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
});

test.beforeEach(async ({ page }) => {
  mockRequests.length = 0;
  await resetSidecar(env);
  await suppressTips(page);
});

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) {
    await testInfo.attach('mock-openai-chat-requests.json', {
      body: JSON.stringify(mockRequests, null, 2),
      contentType: 'application/json',
    });
    await testInfo.attach('advanced-user-journey-failure.png', {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });
  }
});

async function suppressTips(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('tip_image_first_seen', 'true');
    localStorage.setItem('tip_fallback_first_seen', 'true');
    localStorage.setItem('tip_cost_first_seen', 'true');
    localStorage.setItem('tip_roundtable_first_seen', 'true');
  });
}

async function seedProvider(name = 'Advanced Journey Mock'): Promise<string> {
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
    capability: 'chat' | 'image' | 'multimodal';
    is_default_for?: 'chat' | 'image' | null;
    supports_tools?: boolean;
    supports_vision?: boolean;
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
      supports_vision: spec.supports_vision ?? false,
      price_input_per_1m: spec.capability === 'image' ? undefined : 0.2,
      price_output_per_1m: spec.capability === 'image' ? undefined : 0.4,
      ...spec,
    }),
  });
  expect(res.ok).toBeTruthy();
  return ((await res.json()) as { id: string }).id;
}

async function seedToolStack(): Promise<{ toolId: string; imageId: string }> {
  const providerId = await seedProvider();
  const toolId = await seedModel(providerId, {
    model_name: 'advanced-tool-chat',
    display_name: 'Advanced Tool Chat',
    capability: 'chat',
    is_default_for: 'chat',
    supports_tools: true,
  });
  const imageId = await seedModel(providerId, {
    model_name: 'advanced-image',
    display_name: 'Advanced Image',
    capability: 'image',
    is_default_for: 'image',
    price_per_call: 0.03,
  });
  return { toolId, imageId };
}

async function sendAndWait(page: Page, text: string, timeout = 60_000): Promise<void> {
  const before = await page.locator('.msg.assistant').count();
  await page.getByTestId('composer-input').fill(text);
  await page.getByTestId('composer-send').click();
  await expect
    .poll(async () => await page.locator('.msg.assistant').count(), { timeout })
    .toBeGreaterThan(before);
  await expect(page.locator('.msg.assistant').last()).toContainText('高级用户旅程验证回复', {
    timeout,
  });
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

test('first setup recovers from a user mistake and reaches first successful chat with visible timeline', async ({
  page,
}) => {
  test.setTimeout(150_000);

  await page.goto('/');
  await expect(page.getByTestId('onboarding')).toBeVisible({ timeout: 10_000 });

  await page.getByTestId('onb-submit').click();
  await expect(page.getByTestId('onb-error')).toContainText('请输入 API Key');
  await expect(page.getByTestId('onboarding')).toBeVisible();

  await page.getByTestId('onb-provider-type').selectOption('volcengine_ark');
  await page.getByTestId('onb-base-url').fill(MOCK_ARK_URL);
  await page.getByTestId('onb-api-key').fill('sk-valid-after-user-correction');
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
      '[data-testid="onb-candidate-check"][data-model-name="doubao-seedream-3-0-t2i-250415"]',
    ),
  ).not.toBeChecked();
  await page
    .locator('[data-testid="onb-candidate-check"][data-model-name="doubao-1-5-pro-32k-250115"]')
    .check();
  await page
    .locator('[data-testid="onb-candidate-check"][data-model-name="doubao-seedream-3-0-t2i-250415"]')
    .check();
  await page.getByTestId('onb-finish').click();

  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('onboarding')).toHaveCount(0);
  await expect(page.getByTestId('preflight-image')).toHaveAttribute('data-state', 'ready');

  await sendAndWait(page, '第一次配置完成后，帮我确认当前系统可以正常对话');
  await expect(page.getByTestId('context-snapshot-card').last()).toContainText('4 个工具可见');

  const timeline = await openTimeline(page);
  await expect(timeline.getByTestId('run-event').filter({ hasText: '上下文快照' })).toBeVisible();
  await expect(timeline.getByTestId('run-event').filter({ hasText: '模型调用完成' })).toBeVisible();
  await expect(timeline.getByTestId('run-event').filter({ hasText: '成本记录' })).toBeVisible();
  await expectNoHorizontalOverflow(timeline);
});

test('reload during a running response leaves the conversation usable and timeline readable', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await seedToolStack();

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('composer-input').fill('开始一个较慢的长回复，稍后我会刷新页面');
  await page.getByTestId('composer-send').click();
  await expect(page.getByTestId('composer-stop')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('chat-panel')).not.toHaveAttribute('data-active-conv', '', {
    timeout: 10_000,
  });
  const conversationId = await page.getByTestId('chat-panel').getAttribute('data-active-conv');
  expect(conversationId).toBeTruthy();

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 15_000 });
  await page.locator(`[data-testid="conv-item"][data-conv-id="${conversationId}"]`).click();
  await expect(page.locator('.msg.user', { hasText: '开始一个较慢的长回复' })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId('composer-input')).toBeEnabled({ timeout: 10_000 });
  await expect(page.getByTestId('composer-stop')).toBeHidden({ timeout: 10_000 });

  await sendAndWait(page, '刷新后继续，给我一个简短结论');
  const timeline = await openTimeline(page);
  await expect(timeline.getByTestId('run-group')).toHaveCount(2);
  await expect(timeline.getByTestId('run-event').filter({ hasText: '上下文快照' }).first()).toBeVisible();
  await expect(timeline.getByTestId('run-event').filter({ hasText: '用户回合完成' }).first()).toBeVisible();
  await expectNoHorizontalOverflow(timeline);
});

test('two windows keep session tool policy isolated while another conversation can still use tools', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { toolId } = await seedToolStack();

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('active-model').selectOption(toolId);
  await sendAndWait(page, '窗口一建立 A 会话：稍后会测试网页抓取策略');
  const convA = await page.getByTestId('chat-panel').getAttribute('data-active-conv');
  expect(convA).toBeTruthy();

  const page2 = await page.context().newPage();
  await suppressTips(page2);
  await page2.goto('/');
  await expect(page2.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await page2.locator(`[data-testid="conv-item"][data-conv-id="${convA}"]`).click();
  await expect(page2.getByTestId('session-tool-policy-builtin.web_fetch')).toContainText('抓网页 开');

  await page.getByTestId('session-tool-policy-builtin.web_fetch').click();
  await expect(page.getByTestId('session-tool-policy-builtin.web_fetch')).toContainText('抓网页 关');

  await page2.reload({ waitUntil: 'domcontentloaded' });
  await expect(page2.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await page2.locator(`[data-testid="conv-item"][data-conv-id="${convA}"]`).click();
  await expect(page2.getByTestId('session-tool-policy-builtin.web_fetch')).toContainText('抓网页 关');

  const beforeDisabled = mockRequests.length;
  await sendAndWait(page2, '窗口二在 A 会话尝试抓取网页 https://example.com/，不可用就说明限制');
  const disabledReqs = mockRequests.slice(beforeDisabled);
  expect(disabledReqs.some((req) => req.toolNames.includes('web_fetch'))).toBe(false);
  await expect(page2.locator('[data-testid="tool-trace-step"][data-tool="builtin.web_fetch"]')).toHaveCount(0);

  const timelineA = await openTimeline(page2);
  const topA = timelineA.getByTestId('run-group').first();
  await expect(topA.getByTestId('run-event').filter({ hasText: '3 个工具可见' })).toBeVisible();
  await timelineA.getByTestId('run-timeline-close').click();

  await page.getByTestId('sidebar-new').click();
  await expect(page.locator('.msg')).toHaveCount(0);
  await page.getByTestId('active-model').selectOption(toolId);
  await sendAndWait(page, '窗口一建立 B 会话并抓取网页 https://example.com/，这次应该使用工具');
  const convB = await page.getByTestId('chat-panel').getAttribute('data-active-conv');
  expect(convB).toBeTruthy();
  expect(convB).not.toBe(convA);
  await expect(page.locator('[data-testid="tool-trace-step"][data-tool="builtin.web_fetch"]').last()).toBeVisible({
    timeout: 20_000,
  });
  const timelineB = await openTimeline(page);
  await expect(timelineB.getByTestId('run-event').filter({ hasText: '4 个工具可见' }).first()).toBeVisible();
  await expect(timelineB.getByTestId('run-event').filter({ hasText: '抓取网页' }).first()).toBeVisible();
  await expectNoHorizontalOverflow(timelineB);

  await page2.close();
});
