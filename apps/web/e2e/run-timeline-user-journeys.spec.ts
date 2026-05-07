/**
 * Run Timeline user journeys.
 *
 * These scenarios validate observability from the actual Web UI: users send
 * multi-turn work, switch models, use tools, stop a stream, and inspect the
 * Run Timeline panel instead of calling run-events APIs directly.
 */
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import {
  authedFetch,
  readSidecarEnv,
  resetSidecar,
  type SidecarEnv,
} from './_helpers';
import { startMockOpenAI } from './_mock-openai-server';

const MOCK_PORT = 17921;
const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}/v1`;

let server: ReturnType<typeof startMockOpenAI> | null = null;
let env: SidecarEnv;
const mockRequests: Array<{
  model: string;
  toolNames: string[];
  hasToolResult: boolean;
  lastUserText: string;
}> = [];

test.beforeAll(() => {
  server = startMockOpenAI(MOCK_PORT, {
    imageToolCalls: true,
    webToolCalls: true,
    streamDelayMs: 250,
    fixedReply: '运行过程验证回复：已根据当前上下文继续推进。',
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
      const lastUserText = typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.map((p) => p.text ?? '').join('')
          : '';
      mockRequests.push({
        model: body.model,
        toolNames,
        hasToolResult: body.messages.some((m) => m.role === 'tool'),
        lastUserText,
      });
    },
  });
  env = readSidecarEnv();
});

test.afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
});

test.beforeEach(async () => {
  mockRequests.length = 0;
  await resetSidecar(env);
});

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) {
    await testInfo.attach('mock-openai-chat-requests.json', {
      body: JSON.stringify(mockRequests, null, 2),
      contentType: 'application/json',
    });
    await testInfo.attach('run-timeline-failure.png', {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });
  }
});

async function seedProvider(): Promise<string> {
  const res = await authedFetch(env, '/v1/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Run Timeline Journey Mock',
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
    supports_vision?: boolean;
    price_input_per_1m?: number;
    price_output_per_1m?: number;
    price_per_call?: number;
    context_length?: number;
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

async function seedStack(): Promise<{
  fastId: string;
  toolId: string;
  imageId: string;
}> {
  const providerId = await seedProvider();
  const fastId = await seedModel(providerId, {
    model_name: 'rt-fast-chat',
    display_name: 'RT Fast Chat',
    capability: 'chat',
    is_default_for: 'chat',
    context_length: 900,
    price_input_per_1m: 0.1,
    price_output_per_1m: 0.2,
  });
  const toolId = await seedModel(providerId, {
    model_name: 'rt-tool-chat',
    display_name: 'RT Tool Chat',
    capability: 'chat',
    supports_tools: true,
    price_input_per_1m: 1,
    price_output_per_1m: 2,
  });
  const imageId = await seedModel(providerId, {
    model_name: 'rt-image',
    display_name: 'RT Image',
    capability: 'image',
    is_default_for: 'image',
    price_per_call: 0.03,
  });
  return { fastId, toolId, imageId };
}

async function suppressTips(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('tip_image_first_seen', 'true');
    localStorage.setItem('tip_fallback_first_seen', 'true');
    localStorage.setItem('tip_cost_first_seen', 'true');
    localStorage.setItem('tip_roundtable_first_seen', 'true');
  });
}

async function sendAndWait(page: Page, text: string): Promise<void> {
  const before = await page.locator('.msg.assistant').count();
  await page.getByTestId('composer-input').fill(text);
  await page.getByTestId('composer-send').click();
  await expect
    .poll(async () => await page.locator('.msg.assistant').count(), {
      timeout: 45_000,
    })
    .toBeGreaterThan(before);
  await expect(page.locator('.msg.assistant').last()).toContainText('运行过程验证回复', {
    timeout: 30_000,
  });
}

async function openTimeline(page: Page): Promise<void> {
  await page.getByTestId('open-run-timeline').click();
  await expect(page.getByTestId('run-timeline-panel')).toBeVisible({ timeout: 10_000 });
}

async function expectRunEvent(
  page: Page,
  kind: string,
  text?: string,
): Promise<void> {
  const event = page.locator(`[data-testid="run-event"][data-kind="${kind}"]`);
  const target = text ? event.filter({ hasText: text }) : event;
  await expect(target.first()).toBeVisible({ timeout: 15_000 });
}

async function expectTopRunEvent(
  page: Page,
  kind: string,
  text?: string,
): Promise<void> {
  const topGroup = page.getByTestId('run-group').first();
  const event = topGroup.locator(`[data-testid="run-event"][data-kind="${kind}"]`);
  const target = text ? event.filter({ hasText: text }) : event;
  await expect(target.first()).toBeVisible({ timeout: 15_000 });
}

async function expectRunTimelineLayout(page: Page): Promise<void> {
  const panel = page.getByTestId('run-timeline-panel');
  await expect(panel).toBeInViewport();
  const overflow = await panel.evaluate((root) => {
    const rootRect = root.getBoundingClientRect();
    const bad: string[] = [];
    for (const el of root.querySelectorAll<HTMLElement>('*')) {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      if (rect.left < rootRect.left - 1 || rect.right > rootRect.right + 1) {
        bad.push(`${el.tagName.toLowerCase()}.${el.className}`);
      }
    }
    return bad.slice(0, 8);
  });
  expect(overflow).toEqual([]);
}

async function attachTimelineScreenshot(
  page: Page,
  testInfo: TestInfo,
  name: string,
): Promise<void> {
  await testInfo.attach(name, {
    body: await page.getByTestId('run-timeline-panel').screenshot(),
    contentType: 'image/png',
  });
}

test('research work thread shows search, fetch, image and model-switch events in Run Timeline', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const { fastId, toolId } = await seedStack();
  await suppressTips(page);

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('active-model').selectOption(toolId);

  await sendAndWait(page, '请搜索 Taori 多模型助手资料，给出两个调研方向');
  await expect(page.locator('[data-testid="tool-trace-step"][data-tool="builtin.web_search"]').last()).toBeVisible();

  await sendAndWait(page, '继续抓取网页 https://example.com/，合并上一轮搜索材料');
  await expect(page.locator('[data-testid="tool-trace-step"][data-tool="builtin.web_fetch"]').last()).toBeVisible();

  await page.getByTestId('composer-input').fill('基于前面材料，生成一张路线图海报');
  await page.getByTestId('composer-send').click();
  await expect(page.getByTestId('msg-tool-images')).toBeVisible({ timeout: 45_000 });
  await expect(page.locator('[data-testid="tool-trace-step"][data-tool="builtin.image_generate"]').last()).toBeVisible();

  await page.getByTestId('active-model').selectOption(fastId);
  await sendAndWait(page, '切回快速模型，把搜索、网页和海报结果压缩成三条行动项');

  await openTimeline(page);
  await expect(page.getByTestId('run-group')).toHaveCount(4);
  await expectRunEvent(page, 'context.snapshot', '上下文快照');
  await expectRunEvent(page, 'model.completed', '模型调用完成');
  await expectRunEvent(page, 'tool.completed', '搜索网页');
  await expectRunEvent(page, 'tool.completed', '抓取网页');
  await expectRunEvent(page, 'tool.completed', '生成图片');
  await expectRunEvent(page, 'cost.recorded', '成本记录');
  await expect(page.locator('[data-testid="run-event"][data-kind="cost.recorded"]').first()).toContainText('Cost');
  await expectRunEvent(page, 'turn.completed', '用户回合完成');
  await expectRunTimelineLayout(page);
  await attachTimelineScreenshot(page, testInfo, 'run-timeline-research-thread.png');
});

test('session tool policy is isolated between conversations and visible in Run Timeline', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const { toolId } = await seedStack();
  await suppressTips(page);

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('active-model').selectOption(toolId);

  await sendAndWait(page, '建立 A 会话：需要做网页资料核验');
  const convA = await page.getByTestId('chat-panel').getAttribute('data-active-conv');
  expect(convA).toBeTruthy();

  const fetchChip = page.getByTestId('session-tool-policy-builtin.web_fetch');
  await expect(fetchChip).toContainText('抓网页 开');
  await fetchChip.click();
  await expect(fetchChip).toContainText('抓网页 关');
  await expect(page.getByTestId('active-model')).toHaveValue(toolId);

  const beforeDisable = mockRequests.length;
  await sendAndWait(page, 'A 会话请抓取网页 https://example.com/，如果工具不可用就说明限制');
  const disabledReqs = mockRequests.slice(beforeDisable);
  expect(disabledReqs.some((req) => req.toolNames.includes('web_fetch'))).toBe(false);

  await openTimeline(page);
  const topA = page.getByTestId('run-group').first();
  await expect(topA.locator('[data-testid="run-event"][data-kind="context.snapshot"]')).toContainText('上下文快照');
  await expect(topA.locator('[data-testid="run-event"][data-kind="context.snapshot"]')).toContainText('3 个工具可见');
  await expect(topA.locator('[data-testid="run-event"][data-kind="tool.started"]')).toHaveCount(0);
  await expect(topA.locator('[data-testid="run-event"][data-kind="tool.completed"]')).toHaveCount(0);
  await page.getByTestId('run-timeline-close').click();

  await page.getByTestId('sidebar-new').click();
  await expect(page.locator('.msg')).toHaveCount(0);
  await page.getByTestId('active-model').selectOption(toolId);
  await sendAndWait(page, '建立 B 会话并抓取网页 https://example.com/，这次应使用工具');
  const convB = await page.getByTestId('chat-panel').getAttribute('data-active-conv');
  expect(convB).toBeTruthy();
  expect(convB).not.toBe(convA);
  await expect(page.locator('[data-testid="tool-trace-step"][data-tool="builtin.web_fetch"]').last()).toBeVisible();

  await openTimeline(page);
  await expectTopRunEvent(page, 'tool.completed', '抓取网页');
  await expectRunTimelineLayout(page);
  await attachTimelineScreenshot(page, testInfo, 'run-timeline-session-policy-b.png');
  await page.getByTestId('run-timeline-close').click();

  await page.locator(`[data-testid="conv-item"][data-conv-id="${convA}"]`).click();
  await expect(page.getByTestId('session-tool-policy-builtin.web_fetch')).toContainText('抓网页 关', {
    timeout: 10_000,
  });
});

test('roundtable discussion writes analyzer and participant events into Run Timeline', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  await seedStack();
  await suppressTips(page);

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  await page.getByTestId('composer-roundtable').click();
  const dialog = page.getByTestId('roundtable-launch-dialog');
  await dialog.getByTestId('roundtable-mode-select').selectOption('deep');
  await dialog.getByTestId('roundtable-topic-input').fill('是否应该把圆桌运行过程纳入 Timeline');
  await dialog.getByTestId('roundtable-launch-start').click();
  await expect(dialog.getByTestId('roundtable-preview')).toBeVisible({ timeout: 30_000 });
  await dialog.getByTestId('roundtable-launch-continue').click();

  const panel = page.getByTestId('roundtable-panel');
  await expect(panel).toBeVisible({ timeout: 10_000 });
  await panel.getByTestId('roundtable-action-start-round').click();
  await expect(panel.getByTestId('roundtable-cell-0-1')).toHaveClass(
    /roundtable-cell-complete/,
    { timeout: 45_000 },
  );

  await openTimeline(page);
  await expect(page.getByTestId('run-group')).toHaveCount(2);
  await expectRunEvent(page, 'turn.started', '圆桌分析');
  await expectRunEvent(page, 'turn.completed', '圆桌分析完成');
  await expectTopRunEvent(page, 'turn.started', '圆桌第 1 轮');
  await expectTopRunEvent(page, 'model.started');
  await expectTopRunEvent(page, 'model.completed');
  await expectTopRunEvent(page, 'cost.recorded', '参与者成本');
  await expect(
    page.getByTestId('run-timeline-panel')
      .getByTestId('run-group')
      .first()
      .locator('[data-testid="run-event"][data-kind="cost.recorded"]')
      .first(),
  ).toContainText('Cost');
  await expectTopRunEvent(page, 'turn.completed', '圆桌第 1 轮完成');
  await expectRunTimelineLayout(page);
  await attachTimelineScreenshot(page, testInfo, 'run-timeline-roundtable.png');
});

test('failure and user-stop journeys are observable from the Run Timeline panel', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  await seedStack();
  await suppressTips(page);

  await page.route('**/v1/chat', async (route) => {
    let lastUserText = '';
    try {
      const body = JSON.parse(route.request().postData() ?? '{}') as {
        messages?: Array<{ role?: string; content?: unknown }>;
      };
      const lastUser = [...(body.messages ?? [])].reverse().find((m) => m.role === 'user');
      const content = lastUser?.content;
      lastUserText = typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('')
          : '';
    } catch {
      lastUserText = '';
    }
    if (lastUserText.includes('触发一次 rate_limit 失败')) {
      await route.continue({
        headers: {
          ...route.request().headers(),
          'x-test-force-classification': 'rate_limit',
        },
      });
      return;
    }
    await route.continue();
  });

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  await page.getByTestId('composer-input').fill('触发一次 rate_limit 失败，检查运行过程');
  await page.getByTestId('composer-send').click();
  await expect(page.getByTestId('failure-decision-card')).toBeVisible({ timeout: 20_000 });

  await openTimeline(page);
  await expectTopRunEvent(page, 'model.failed', '模型调用失败');
  await expectTopRunEvent(page, 'turn.failed', '用户回合失败');
  await expectRunTimelineLayout(page);
  await page.getByTestId('run-timeline-close').click();

  await page.getByTestId('composer-input').fill('这次请正常长一点输出，我会中途停止');
  await page.getByTestId('composer-send').click();
  await expect(page.getByTestId('composer-stop')).toBeVisible({ timeout: 10_000 });
  await page.evaluate(() => {
    document
      .querySelector<HTMLElement>('[data-testid="composer-stop"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await expect(page.getByTestId('composer-stop')).toBeHidden({ timeout: 10_000 });
  await expect(page.getByTestId('composer-input')).toBeEnabled();

  await openTimeline(page);
  await expectRunEvent(page, 'turn.cancelled', '用户回合已停止');
  await expectRunTimelineLayout(page);
  await attachTimelineScreenshot(page, testInfo, 'run-timeline-failure-and-stop.png');
});

test('long multi-turn conversation keeps Run Timeline readable and persisted after reload', async ({
  page,
}, testInfo) => {
  test.setTimeout(210_000);
  const { fastId } = await seedStack();
  await suppressTips(page);

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('active-model').selectOption(fastId);

  for (let i = 1; i <= 8; i++) {
    await sendAndWait(page, `第 ${i} 轮：继续完善同一个发布复盘任务，保留上下文。${'长上下文材料'.repeat(80)}`);
  }
  const convId = await page.getByTestId('chat-panel').getAttribute('data-active-conv');
  expect(convId).toBeTruthy();

  await openTimeline(page);
  await expect(page.getByTestId('run-group')).toHaveCount(8);
  await expect
    .poll(async () => await page.getByTestId('run-event').count(), { timeout: 15_000 })
    .toBeGreaterThanOrEqual(40);
  await expectRunEvent(page, 'context.snapshot', '上下文快照');
  await expectRunEvent(page, 'context.snapshot', '滑动窗口');
  await expect(page.getByTestId('context-window-detail').filter({ hasText: '裁剪' }).first()).toBeVisible();
  await expect(page.getByTestId('context-window-detail').filter({ hasText: /[1-9]\d* 条/ }).first()).toBeVisible();
  await expectRunEvent(page, 'cost.recorded', '成本记录');
  await expectRunTimelineLayout(page);
  await attachTimelineScreenshot(page, testInfo, 'run-timeline-long-thread-before-reload.png');

  await page.reload();
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 15_000 });
  await page.locator(`[data-testid="conv-item"][data-conv-id="${convId}"]`).click();
  await expect(page.locator('.msg.user')).toHaveCount(8, { timeout: 10_000 });
  await openTimeline(page);
  await expect(page.getByTestId('run-group')).toHaveCount(8);
  await expectRunTimelineLayout(page);
  await attachTimelineScreenshot(page, testInfo, 'run-timeline-long-thread-after-reload.png');
});
