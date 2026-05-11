/**
 * Mixed model + mixed tool collaboration journeys.
 *
 * These scenarios keep one realistic work thread moving across multiple turns,
 * switching chat models and using different tools from the Web UI. API calls
 * only seed BYOK-style model configuration and verify persisted state where the
 * renderer cannot directly observe sidecar-internal tool invocations.
 */
import { test, expect, type Page } from '@playwright/test';
import {
  authedFetch,
  readSidecarEnv,
  resetSidecar,
  type SidecarEnv,
} from './_helpers';
import { startMockOpenAI } from './_mock-openai-server';

const MOCK_PORT = 17912;
const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}/v1`;
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

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
    fixedReply: '混合协作回复：已结合当前模型、工具结果和上下文继续处理。',
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
  if (server) await new Promise<void>((r) => server!.close(() => r()));
});

test.beforeEach(async () => {
  mockRequests.length = 0;
  await resetSidecar(env);
});

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) {
    await testInfo.attach('mock-openai-chat-requests.json', {
      body: JSON.stringify(mockRequests, null, 2),
      contentType: 'application/json',
    });
    await testInfo.attach('sidecar-cost-call-logs.json', {
      body: JSON.stringify(await getCostCallLogs().catch(() => []), null, 2),
      contentType: 'application/json',
    });
  }
});

async function seedProvider(name = 'Mixed Collaboration Mock'): Promise<string> {
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

async function seedStack(): Promise<{
  fastId: string;
  toolId: string;
  visionId: string;
  imageId: string;
}> {
  const providerId = await seedProvider();
  const fastId = await seedModel(providerId, {
    model_name: 'mock-fast-planner',
    display_name: 'Fast Planner',
    capability: 'chat',
    is_default_for: 'chat',
    price_input_per_1m: 0.1,
    price_output_per_1m: 0.2,
  });
  const toolId = await seedModel(providerId, {
    model_name: 'mock-tool-researcher',
    display_name: 'Tool Researcher',
    capability: 'chat',
    supports_tools: true,
    price_input_per_1m: 1,
    price_output_per_1m: 2,
  });
  const visionId = await seedModel(providerId, {
    model_name: 'mock-vision-reviewer',
    display_name: 'Vision Reviewer',
    capability: 'chat',
    supports_vision: true,
    price_input_per_1m: 1.5,
    price_output_per_1m: 3,
  });
  const imageId = await seedModel(providerId, {
    model_name: 'mock-image-maker',
    display_name: 'Image Maker',
    capability: 'image',
    is_default_for: 'image',
    price_per_call: 0.03,
  });
  return { fastId, toolId, visionId, imageId };
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
      timeout: 30_000,
    })
    .toBeGreaterThan(before);
  await expect(page.locator('.msg.assistant').last()).toContainText('混合协作回复', {
    timeout: 20_000,
  });
}

async function sendCurrentComposerAndWait(page: Page): Promise<void> {
  const before = await page.locator('.msg.assistant').count();
  await page.getByTestId('composer-send').click();
  await expect
    .poll(async () => await page.locator('.msg.assistant').count(), {
      timeout: 30_000,
    })
    .toBeGreaterThan(before);
  await expect(page.locator('.msg.assistant').last()).toContainText('混合协作回复', {
    timeout: 20_000,
  });
}

async function dropTinyImage(page: Page): Promise<void> {
  await page.getByTestId('composer-form').evaluate((el, b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], 'pixel.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, TINY_PNG_B64);
}

async function continueCostConfirmIfVisible(page: Page): Promise<void> {
  const dialog = page.getByTestId('cost-confirm-dialog');
  const visible = await dialog
    .waitFor({ state: 'visible', timeout: 2_000 })
    .then(() => true)
    .catch(() => false);
  if (visible) {
    await dialog.getByTestId('cost-confirm-continue').click();
  }
}

async function runQuickCompare(
  page: Page,
  prompt: string,
  options?: { selectedCount?: 2 | 3 },
): Promise<void> {
  const selectedCount = options?.selectedCount ?? 3;
  await page.getByTestId('composer-input').fill(prompt);
  await page.getByTestId('composer-quick-compare').click();
  const picker = page.getByTestId('quick-compare-picker');
  await expect(picker).toBeVisible({ timeout: 10_000 });
  await expect(picker.getByTestId('quick-compare-picker-count')).toContainText('已选 3/3');
  if (selectedCount === 2) {
    await picker.locator('[data-testid^="quick-compare-model-check-"]').nth(2).uncheck();
    await expect(picker.getByTestId('quick-compare-picker-count')).toContainText('已选 2/3');
  }
  await picker.getByTestId('quick-compare-picker-submit').click();
  await expect(page.getByTestId('quick-compare-card')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('quick-compare-output')).toHaveCount(selectedCount, {
    timeout: 20_000,
  });
  await expect(page.getByTestId('quick-compare-decision-report')).toBeVisible();
}

async function expectActiveConversationId(page: Page): Promise<string> {
  const convId = await page.getByTestId('chat-panel').getAttribute('data-active-conv');
  expect(convId).toBeTruthy();
  return convId!;
}

type CostCallLogRow = {
  feature: string;
  model_name_snapshot?: string | null;
  model_id?: string | null;
  success: boolean;
};

async function getCostCallLogs(): Promise<CostCallLogRow[]> {
  const res = await authedFetch(env, '/v1/costs/calls?limit=50');
  expect(res.ok).toBeTruthy();
  const json = (await res.json()) as { data?: { rows?: CostCallLogRow[] } };
  return json.data?.rows ?? [];
}

async function costLogShouldContain(
  match: (row: CostCallLogRow) => boolean,
): Promise<void> {
  await expect
    .poll(async () => (await getCostCallLogs()).some(match), { timeout: 20_000 })
    .toBe(true);
}

async function visibleCostDashboardShouldLoad(page: Page): Promise<void> {
  await expect
    .poll(async () => await page.getByTestId('cost-call-log-row').count(), {
      timeout: 15_000,
    })
    .toBeGreaterThan(0);
}

test('multi-turn research thread uses fast chat, web fetch tool, image tool, then returns to cheap model', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { fastId, toolId } = await seedStack();
  await suppressTips(page);

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('active-model')).toHaveValue(fastId);

  const firstReq = page.waitForRequest((req) => req.url().endsWith('/v1/chat') && req.method() === 'POST');
  await sendAndWait(page, '先用快速模型列出这次发布复盘的三个问题');
  const firstBody = JSON.parse((await firstReq).postData() ?? '{}') as { model_id?: string };
  expect(firstBody.model_id).toBe(fastId);
  const convId = await page.getByTestId('chat-panel').getAttribute('data-active-conv');
  expect(convId).toBeTruthy();

  await page.getByTestId('active-model').selectOption(toolId);
  const fetchReq = page.waitForRequest((req) => req.url().endsWith('/v1/chat') && req.method() === 'POST');
  await sendAndWait(page, '请抓取网页 https://example.com/ 的要点，并结合上一步继续分析');
  const fetchBody = JSON.parse((await fetchReq).postData() ?? '{}') as {
    model_id?: string;
    conversation_id?: string;
  };
  expect(fetchBody.model_id).toBe(toolId);
  expect(fetchBody.conversation_id).toBe(convId);

  await expect(page.getByTestId('chat-panel')).toHaveAttribute('data-active-conv', convId!);
  await page.getByTestId('composer-input').fill('基于刚才的网页材料，生成一张发布复盘海报');
  await page.getByTestId('composer-send').click();
  await expect(page.getByTestId('msg-tool-images')).toHaveCount(1, { timeout: 30_000 });
  await expect(page.locator('.msg.assistant').last()).toContainText('混合协作回复', {
    timeout: 20_000,
  });

  await page.getByTestId('active-model').selectOption(fastId);
  const finalReq = page.waitForRequest((req) => req.url().endsWith('/v1/chat') && req.method() === 'POST');
  await sendAndWait(page, '回到快速模型，把前面网页和海报结果压缩成三条行动项');
  const finalBody = JSON.parse((await finalReq).postData() ?? '{}') as {
    model_id?: string;
    conversation_id?: string;
  };
  expect(finalBody.model_id).toBe(fastId);
  expect(finalBody.conversation_id).toBe(convId);
  await expect(page.getByTestId('msg-cost')).toHaveCount(4, { timeout: 10_000 });

  await page.getByTestId('open-cost-dashboard').click();
  await expect(page.getByTestId('cost-dashboard-panel')).toBeVisible();
  await visibleCostDashboardShouldLoad(page);
  await costLogShouldContain(
    (row) => row.model_name_snapshot === 'builtin.web_fetch' && row.success,
  );
  await costLogShouldContain((row) => row.model_name_snapshot === 'mock-fast-planner');
  await costLogShouldContain((row) => row.model_name_snapshot === 'mock-tool-researcher');
});

test('vision handoff plus image generation keeps one conversation while models change by task', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { fastId, toolId, visionId, imageId } = await seedStack();
  await suppressTips(page);

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('active-model')).toHaveValue(fastId);

  await sendAndWait(page, '先建立这次视觉物料交付的工作会话');
  const convId = await page.getByTestId('chat-panel').getAttribute('data-active-conv');
  expect(convId).toBeTruthy();

  await dropTinyImage(page);
  await expect(page.getByTestId('attachment-thumb')).toHaveAttribute('data-kind', 'image');
  await expect(page.getByTestId('active-model')).toHaveValue(visionId, { timeout: 10_000 });
  await expect(page.getByTestId('drop-error')).toContainText('已自动切换至视觉模型');

  const visionReq = page.waitForRequest((req) => req.url().endsWith('/v1/chat') && req.method() === 'POST');
  await sendAndWait(page, '先理解这张图，并给出适合做海报的三个视觉元素');
  const visionBody = JSON.parse((await visionReq).postData() ?? '{}') as {
    model_id?: string;
    conversation_id?: string;
    attachments?: unknown[];
  };
  expect(visionBody.model_id).toBe(visionId);
  expect(visionBody.conversation_id).toBe(convId);
  expect(visionBody.attachments?.length).toBeGreaterThan(0);
  await expect(page.getByTestId('attachments-bar')).toHaveCount(0, { timeout: 10_000 });

  await page.getByTestId('active-model').selectOption(toolId);
  await expect(page.getByTestId('active-model')).toHaveValue(toolId);
  await page.getByTestId('composer-input').fill('/image 根据上一轮视觉元素生成一张横版海报');
  await page.getByTestId('composer-send').click();
  const picker = page.getByTestId('image-picker-dialog');
  await expect(picker).toBeVisible({ timeout: 10_000 });
  await expect(picker.getByTestId(`image-model-radio-${imageId}`)).toBeChecked();
  await picker.getByTestId('image-picker-submit').click();
  await continueCostConfirmIfVisible(page);
  await expect(page.getByTestId('msg-tool-images')).toHaveCount(1, { timeout: 30_000 });
  await expect(page.getByTestId('chat-panel')).toHaveAttribute('data-active-conv', convId!);

  await page.getByTestId('active-model').selectOption(fastId);
  const closeReq = page.waitForRequest((req) => req.url().endsWith('/v1/chat') && req.method() === 'POST');
  await sendAndWait(page, '最后用快速模型总结图片理解和生成结果，给出交付说明');
  const closeBody = JSON.parse((await closeReq).postData() ?? '{}') as {
    model_id?: string;
    conversation_id?: string;
  };
  expect(closeBody.model_id).toBe(fastId);
  expect(closeBody.conversation_id).toBe(convId);
  await expect(page.locator('.msg.user')).toHaveCount(4);
  await expect(page.locator('.msg.assistant')).toHaveCount(4);
});

test('tool capability toggles can disable web fetch while image generation still works in the same thread', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { toolId, imageId } = await seedStack();
  await suppressTips(page);

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await sendAndWait(page, '先建立一个排障会话，主题是发布流程里哪些环节会阻塞');
  const convId = await page.getByTestId('chat-panel').getAttribute('data-active-conv');
  expect(convId).toBeTruthy();

  await page.getByTestId('active-model').selectOption(toolId);
  await expect(page.getByTestId('active-model')).toHaveValue(toolId);

  await page.getByTestId('open-settings').click();
  await page.getByTestId('settings-tab-tools').click();
  const fetchToggle = page.getByTestId('tool-toggle-builtin.web_fetch');
  await expect(fetchToggle).toContainText('已启用');
  await fetchToggle.click();
  await expect(fetchToggle).toContainText('已关闭');
  await page.getByTestId('settings-close').click();

  await expect(page.getByTestId('active-model')).toHaveValue(toolId);
  await page.getByTestId('composer-input').fill('/image 网页抓取先暂停，改生成一张说明阻塞点的简洁流程图');
  await page.getByTestId('composer-send').click();
  const picker = page.getByTestId('image-picker-dialog');
  await expect(picker).toBeVisible({ timeout: 10_000 });
  await expect(picker.getByTestId(`image-model-radio-${imageId}`)).toBeChecked();
  await picker.getByTestId('image-picker-submit').click();
  await continueCostConfirmIfVisible(page);
  await expect(page.getByTestId('msg-tool-images')).toHaveCount(1, { timeout: 30_000 });
  await expect(page.getByTestId('chat-panel')).toHaveAttribute('data-active-conv', convId!);

  await page.getByTestId('open-settings').click();
  await page.getByTestId('settings-tab-tools').click();
  await fetchToggle.click();
  await expect(fetchToggle).toContainText('已启用');
  await page.getByTestId('settings-close').click();

  await sendAndWait(page, '现在抓取网页 https://example.com/，把网页内容和刚才的流程图放在同一份结论里');
  await expect(page.getByTestId('chat-panel')).toHaveAttribute('data-active-conv', convId!);

  await page.getByTestId('open-cost-dashboard').click();
  await expect(page.getByTestId('cost-dashboard-panel')).toBeVisible();
  await visibleCostDashboardShouldLoad(page);
  await costLogShouldContain(
    (row) => row.model_name_snapshot === 'builtin.web_fetch' && row.success,
  );
});

test('session profile shows context and session tool policy blocks only the current conversation', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { toolId } = await seedStack();
  await suppressTips(page);

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('active-model').selectOption(toolId);

  await sendAndWait(page, '建立一个带工具策略的调研会话');
  const convId = await page.getByTestId('chat-panel').getAttribute('data-active-conv');
  expect(convId).toBeTruthy();
  await expect(page.getByTestId('session-profile-strip')).toBeVisible();
  await expect(page.getByTestId('session-profile-model')).toContainText('Tool Researcher');
  const contextCard = page.getByTestId('context-snapshot-card').first();
  await expect(contextCard).toBeVisible();
  await contextCard.locator('summary').click();
  await expect(page.getByTestId('context-source-chip').first()).toBeVisible();

  const webFetchChip = page.getByTestId('session-tool-policy-builtin.web_fetch');
  await expect(webFetchChip).toContainText('抓网页 开');
  await webFetchChip.click();
  await expect(webFetchChip).toContainText('抓网页 关');

  const before = mockRequests.length;
  await sendAndWait(page, '请抓取网页 https://example.com/ 并说明要点');
  const afterDisableReqs = mockRequests.slice(before);
  expect(afterDisableReqs.some((req) => req.toolNames.includes('web_fetch'))).toBe(false);

  await webFetchChip.click();
  await expect(webFetchChip).toContainText('抓网页 开');
  await sendAndWait(page, '再次抓取网页 https://example.com/，这次可以使用工具');
  await expect
    .poll(() => mockRequests.some((req) => req.toolNames.includes('web_fetch')), {
      timeout: 15_000,
    })
    .toBe(true);

  await expect(page.getByTestId('chat-panel')).toHaveAttribute('data-active-conv', convId!);
});

test('research journey chains web search, web fetch, image generation, and cheap synthesis in one conversation', async ({
  page,
}) => {
  test.setTimeout(150_000);
  const { fastId, toolId } = await seedStack();
  await suppressTips(page);

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  await page.getByTestId('active-model').selectOption(toolId);
  await expect(page.getByTestId('active-model')).toHaveValue(toolId);

  const searchReq = page.waitForRequest((req) => req.url().endsWith('/v1/chat') && req.method() === 'POST');
  await sendAndWait(page, '请先搜索 Taori 多模型助手相关资料，提炼我应该关注的两个方向');
  const searchBody = JSON.parse((await searchReq).postData() ?? '{}') as {
    model_id?: string;
    conversation_id?: string;
  };
  expect(searchBody.model_id).toBe(toolId);
  const convId = await page.getByTestId('chat-panel').getAttribute('data-active-conv');
  expect(convId).toBeTruthy();
  await expect
    .poll(() => mockRequests.some((r) => r.toolNames.includes('web_search')), {
      timeout: 15_000,
    })
    .toBe(true);
  await expect
    .poll(() => mockRequests.some((r) => r.hasToolResult && r.lastUserText.includes('搜索')), {
      timeout: 15_000,
    })
    .toBe(true);

  const fetchReq = page.waitForRequest((req) => req.url().endsWith('/v1/chat') && req.method() === 'POST');
  await sendAndWait(page, '继续抓取网页 https://example.com/，把它和上一步搜索结果合并');
  const fetchBody = JSON.parse((await fetchReq).postData() ?? '{}') as {
    model_id?: string;
    conversation_id?: string;
  };
  expect(fetchBody.model_id).toBe(toolId);
  expect(fetchBody.conversation_id).toBe(convId);
  await expect
    .poll(() => mockRequests.some((r) => r.toolNames.includes('web_fetch')), {
      timeout: 15_000,
    })
    .toBe(true);

  await page.getByTestId('composer-input').fill('基于搜索和网页材料，生成一张给团队看的路线图海报');
  await page.getByTestId('composer-send').click();
  await expect(page.getByTestId('msg-tool-images')).toHaveCount(1, { timeout: 30_000 });
  await expect
    .poll(() => mockRequests.some((r) => r.toolNames.includes('image_generate')), {
      timeout: 15_000,
    })
    .toBe(true);
  await expect(page.getByTestId('chat-panel')).toHaveAttribute('data-active-conv', convId!);

  await page.getByTestId('active-model').selectOption(fastId);
  const summaryReq = page.waitForRequest((req) => req.url().endsWith('/v1/chat') && req.method() === 'POST');
  await sendAndWait(page, '切回快速模型，压缩成一段可发给团队的结论');
  const summaryBody = JSON.parse((await summaryReq).postData() ?? '{}') as {
    model_id?: string;
    conversation_id?: string;
  };
  expect(summaryBody.model_id).toBe(fastId);
  expect(summaryBody.conversation_id).toBe(convId);
  await expect(page.locator('.msg.user')).toHaveCount(4);
  await expect(page.locator('.msg.assistant')).toHaveCount(4);

  await page.getByTestId('open-cost-dashboard').click();
  await expect(page.getByTestId('cost-dashboard-panel')).toBeVisible();
  await visibleCostDashboardShouldLoad(page);
  await costLogShouldContain(
    (row) => row.model_name_snapshot === 'builtin.web_search' && row.success,
  );
  await costLogShouldContain(
    (row) => row.model_name_snapshot === 'builtin.web_fetch' && row.success,
  );
  await costLogShouldContain((row) => row.model_name_snapshot === 'mock-fast-planner');
  await costLogShouldContain((row) => row.model_name_snapshot === 'mock-tool-researcher');
});

test('generated image can be re-attached for vision review, then summarized by a fast model', async ({
  page,
}) => {
  test.setTimeout(150_000);
  const { fastId, toolId, visionId, imageId } = await seedStack();
  await suppressTips(page);

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await sendAndWait(page, '建立一条面向市场活动物料的工作线');
  const convId = await page.getByTestId('chat-panel').getAttribute('data-active-conv');
  expect(convId).toBeTruthy();

  await page.getByTestId('active-model').selectOption(toolId);
  await page.getByTestId('composer-input').fill('/image 生成一张活动报名页主视觉，简洁、明亮、有标题区域');
  await page.getByTestId('composer-send').click();
  const picker = page.getByTestId('image-picker-dialog');
  await expect(picker).toBeVisible({ timeout: 10_000 });
  await expect(picker.getByTestId(`image-model-radio-${imageId}`)).toBeChecked();
  await picker.getByTestId('image-picker-submit').click();
  await continueCostConfirmIfVisible(page);
  await expect(page.getByTestId('msg-tool-images')).toHaveCount(1, { timeout: 30_000 });
  await expect(page.getByTestId('chat-panel')).toHaveAttribute('data-active-conv', convId!);

  await page.getByTestId('tool-image-understand').last().click();
  await expect(page.getByTestId('attachment-thumb')).toHaveAttribute('data-kind', 'image');
  await expect(page.getByTestId('active-model')).toHaveValue(visionId, { timeout: 10_000 });
  await expect(page.getByTestId('drop-error')).toContainText('已自动切换至视觉模型');
  await expect(page.getByTestId('composer-input')).toContainText('请理解这张图片');

  const visionReq = page.waitForRequest((req) => req.url().endsWith('/v1/chat') && req.method() === 'POST');
  await sendAndWait(page, '重点检查这张图是否适合作为活动报名页主视觉，并指出一个改进点');
  const visionBody = JSON.parse((await visionReq).postData() ?? '{}') as {
    model_id?: string;
    conversation_id?: string;
    attachments?: unknown[];
  };
  expect(visionBody.model_id).toBe(visionId);
  expect(visionBody.conversation_id).toBe(convId);
  expect(visionBody.attachments?.length).toBeGreaterThan(0);
  await expect(page.getByTestId('attachments-bar')).toHaveCount(0, { timeout: 10_000 });

  await page.getByTestId('active-model').selectOption(fastId);
  const finalReq = page.waitForRequest((req) => req.url().endsWith('/v1/chat') && req.method() === 'POST');
  await sendAndWait(page, '最后用快速模型输出给设计师的三条修改建议');
  const finalBody = JSON.parse((await finalReq).postData() ?? '{}') as {
    model_id?: string;
    conversation_id?: string;
  };
  expect(finalBody.model_id).toBe(fastId);
  expect(finalBody.conversation_id).toBe(convId);
  await expect(page.locator('.msg.user')).toHaveCount(4);
  await expect(page.locator('.msg.assistant')).toHaveCount(4);
  await costLogShouldContain((row) => row.model_name_snapshot === 'mock-image-maker' && row.success);
  await costLogShouldContain((row) => row.model_name_snapshot === 'mock-vision-reviewer' && row.success);
});

test('quick compare adoption can hand off to tool fetch in the same conversation', async ({
  page,
}) => {
  test.setTimeout(150_000);
  const { toolId } = await seedStack();
  await suppressTips(page);

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  await runQuickCompare(page, '给我三个适合发布复盘的行动方向');
  await page.getByTestId('quick-compare-adopt-recommended').click();
  await expect(page.getByTestId('quick-compare-card')).toHaveCount(0, { timeout: 20_000 });
  const convId = await expectActiveConversationId(page);

  const before = mockRequests.length;
  const fetchReq = page.waitForRequest((req) => req.url().endsWith('/v1/chat') && req.method() === 'POST');
  await page.getByTestId('active-model').selectOption(toolId);
  await sendAndWait(page, '抓取网页 https://example.com/ ，并沿用刚才的推荐方案展开执行建议');
  const fetchBody = JSON.parse((await fetchReq).postData() ?? '{}') as {
    model_id?: string;
    conversation_id?: string;
  };
  expect(fetchBody.model_id).toBe(toolId);
  expect(fetchBody.conversation_id).toBe(convId);
  await expect
    .poll(() => mockRequests.slice(before).some((req) => req.toolNames.includes('web_fetch')), {
      timeout: 15_000,
    })
    .toBe(true);
  await expect(page.locator('[data-testid="tool-trace-step"][data-tool="builtin.web_fetch"]').last()).toBeVisible();
});

test('quick compare follow-up draft can be sent by the fast model in the same conversation', async ({
  page,
}) => {
  test.setTimeout(150_000);
  const { fastId } = await seedStack();
  await suppressTips(page);

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await sendAndWait(page, '先建立一条用于比较发布方案的会话');
  const convId = await expectActiveConversationId(page);

  await runQuickCompare(page, '并行比较一下同一发布方案的三个表达版本');
  await page.getByTestId('quick-compare-draft-follow-up').click();
  await expect(page.getByTestId('composer-input')).toContainText('最终推荐方案');

  const followReq = page.waitForRequest((req) => req.url().endsWith('/v1/chat') && req.method() === 'POST');
  await page.getByTestId('active-model').selectOption(fastId);
  await sendCurrentComposerAndWait(page);
  const followBody = JSON.parse((await followReq).postData() ?? '{}') as {
    model_id?: string;
    conversation_id?: string;
  };
  expect(followBody.model_id).toBe(fastId);
  expect(followBody.conversation_id).toBe(convId);
  await expect(page.getByTestId('chat-panel')).toHaveAttribute('data-active-conv', convId);
});

test('quick compare minority review can switch to a tool model and trigger web search in one thread', async ({
  page,
}) => {
  test.setTimeout(150_000);
  const { toolId } = await seedStack();
  await suppressTips(page);

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await sendAndWait(page, '先建立一条需要挑战推荐结论的讨论会话');
  const convId = await expectActiveConversationId(page);

  await runQuickCompare(page, '并行比较一下这次方案里最可能被忽略的风险');
  await page.getByTestId('quick-compare-draft-minority-review').click();
  await expect(page.getByTestId('composer-input')).toContainText('少数意见最强论据');
  const drafted = await page.getByTestId('composer-input').inputValue();
  await page
    .getByTestId('composer-input')
    .fill(`${drafted}\n\n请搜索 Taori 多模型助手相关资料，再用少数意见反驳推荐结论。`);

  const before = mockRequests.length;
  const searchReq = page.waitForRequest((req) => req.url().endsWith('/v1/chat') && req.method() === 'POST');
  await page.getByTestId('active-model').selectOption(toolId);
  await sendCurrentComposerAndWait(page);
  const searchBody = JSON.parse((await searchReq).postData() ?? '{}') as {
    model_id?: string;
    conversation_id?: string;
  };
  expect(searchBody.model_id).toBe(toolId);
  expect(searchBody.conversation_id).toBe(convId);
  await expect
    .poll(() => mockRequests.slice(before).some((req) => req.toolNames.includes('web_search')), {
      timeout: 15_000,
    })
    .toBe(true);
});

test('quick compare recommended cost focus opens the cost dashboard and highlights the suggested record', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await seedStack();
  await suppressTips(page);

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  await runQuickCompare(page, '比较三个适合用在产品评审里的结论模板');
  await expect(page.getByTestId('quick-compare-open-cost-focus')).toBeVisible();
  await page.getByTestId('quick-compare-open-cost-focus').click();

  await expect(page.getByTestId('cost-dashboard-panel')).toBeVisible();
  await visibleCostDashboardShouldLoad(page);
  const focusedCall = page.locator('[data-testid="cost-call-log-row"][data-focused="1"]').first();
  await expect(focusedCall).toBeVisible();
  await expect(focusedCall.getByTestId('cost-call-source-id')).toContainText('Cost');
});

test('image session memory survives quick compare adoption and skips the picker on the next image turn', async ({
  page,
}) => {
  test.setTimeout(150_000);
  const { imageId } = await seedStack();
  await suppressTips(page);
  await page.route('**/v1/tools/invoke', async (route) => {
    await route.continue({
      headers: {
        ...route.request().headers(),
        'x-test-force-image-result': 'success',
      },
    });
  });

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  await page.getByTestId('composer-input').fill('/image 先生成第一张发布路线图');
  await page.getByTestId('composer-send').click();
  const firstPicker = page.getByTestId('image-picker-dialog');
  await expect(firstPicker).toBeVisible({ timeout: 10_000 });
  await expect(firstPicker.getByTestId(`image-model-radio-${imageId}`)).toBeChecked();
  await firstPicker.getByTestId('image-memory-session').check();
  await firstPicker.getByTestId('image-picker-submit').click();
  await continueCostConfirmIfVisible(page);
  await expect(page.getByTestId('msg-tool-images')).toHaveCount(1, { timeout: 30_000 });
  const convId = await expectActiveConversationId(page);

  await runQuickCompare(page, '基于刚才的路线图，比较三个不同的复盘摘要版本');
  await page.getByTestId('quick-compare-adopt-recommended').click();
  await expect(page.getByTestId('quick-compare-card')).toHaveCount(0, { timeout: 20_000 });
  await expect(page.getByTestId('chat-panel')).toHaveAttribute('data-active-conv', convId);

  await page.getByTestId('composer-input').fill('/image 再生成一张第二阶段路线图');
  await page.getByTestId('composer-send').click();
  await expect(page.getByTestId('image-picker-dialog')).toHaveCount(0);
  await continueCostConfirmIfVisible(page);
  await expect(page.getByTestId('msg-tool-images')).toHaveCount(2, { timeout: 30_000 });
});

test('fast to vision to tool to quick compare adoption stays on one conversation', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { toolId, visionId } = await seedStack();
  await suppressTips(page);

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await sendAndWait(page, '先建立一条跨模型协作的视觉交付会话');
  const convId = await expectActiveConversationId(page);

  await dropTinyImage(page);
  await expect(page.getByTestId('attachment-thumb')).toHaveAttribute('data-kind', 'image');
  await expect(page.getByTestId('active-model')).toHaveValue(visionId, { timeout: 10_000 });
  const visionReq = page.waitForRequest((req) => req.url().endsWith('/v1/chat') && req.method() === 'POST');
  await sendAndWait(page, '先理解这张图，再给出适合发布页的三个视觉元素');
  const visionBody = JSON.parse((await visionReq).postData() ?? '{}') as {
    model_id?: string;
    conversation_id?: string;
    attachments?: unknown[];
  };
  expect(visionBody.model_id).toBe(visionId);
  expect(visionBody.conversation_id).toBe(convId);
  expect(visionBody.attachments?.length).toBeGreaterThan(0);

  const before = mockRequests.length;
  const toolReq = page.waitForRequest((req) => req.url().endsWith('/v1/chat') && req.method() === 'POST');
  await page.getByTestId('active-model').selectOption(toolId);
  await sendAndWait(page, '抓取网页 https://example.com/ ，并结合图片元素给出落地建议');
  const toolBody = JSON.parse((await toolReq).postData() ?? '{}') as {
    model_id?: string;
    conversation_id?: string;
  };
  expect(toolBody.model_id).toBe(toolId);
  expect(toolBody.conversation_id).toBe(convId);
  await expect
    .poll(() => mockRequests.slice(before).some((req) => req.toolNames.includes('web_fetch')), {
      timeout: 15_000,
    })
    .toBe(true);

  await runQuickCompare(page, '把刚才的图片理解和网页建议再做一次多模型对比');
  await page.getByTestId('quick-compare-adopt-recommended').click();
  await expect(page.getByTestId('quick-compare-card')).toHaveCount(0, { timeout: 20_000 });
  await expect(page.getByTestId('chat-panel')).toHaveAttribute('data-active-conv', convId);
});

test('two conversations keep quick compare adoptions isolated and restorable from the sidebar', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await seedStack();
  await suppressTips(page);

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  await runQuickCompare(page, '会话 A：比较三种适合给管理层汇报的表达方式');
  await page.getByTestId('quick-compare-adopt-recommended').click();
  await expect(page.getByTestId('quick-compare-card')).toHaveCount(0, { timeout: 20_000 });
  const convA = await expectActiveConversationId(page);
  await expect(page.locator('.msg.user').last()).toContainText('会话 A：比较三种适合给管理层汇报的表达方式');

  await page.getByTestId('sidebar-new').click();
  await expect(page.getByTestId('chat-panel')).toHaveAttribute('data-active-conv', '');

  await runQuickCompare(page, '会话 B：比较三种适合给执行团队同步的表达方式');
  await page.getByTestId('quick-compare-adopt-recommended').click();
  await expect(page.getByTestId('quick-compare-card')).toHaveCount(0, { timeout: 20_000 });
  const convB = await expectActiveConversationId(page);
  expect(convB).not.toBe(convA);
  await expect(page.locator('.msg.user').last()).toContainText('会话 B：比较三种适合给执行团队同步的表达方式');

  await page.locator(`[data-testid="conv-item"][data-conv-id="${convA}"]`).click();
  await expect(page.getByTestId('chat-panel')).toHaveAttribute('data-active-conv', convA);
  await expect(page.locator('.msg.user').last()).toContainText('会话 A：比较三种适合给管理层汇报的表达方式');

  await page.locator(`[data-testid="conv-item"][data-conv-id="${convB}"]`).click();
  await expect(page.getByTestId('chat-panel')).toHaveAttribute('data-active-conv', convB);
  await expect(page.locator('.msg.user').last()).toContainText('会话 B：比较三种适合给执行团队同步的表达方式');
});

test('quick compare adoption can be followed by image generation, image understanding, and fast summary', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { fastId, toolId, visionId, imageId } = await seedStack();
  await suppressTips(page);
  await page.route('**/v1/tools/invoke', async (route) => {
    await route.continue({
      headers: {
        ...route.request().headers(),
        'x-test-force-image-result': 'success',
      },
    });
  });

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  await runQuickCompare(page, '先比较三种适合活动海报的创意方向');
  await page.getByTestId('quick-compare-adopt-recommended').click();
  await expect(page.getByTestId('quick-compare-card')).toHaveCount(0, { timeout: 20_000 });
  const convId = await expectActiveConversationId(page);

  await page.getByTestId('active-model').selectOption(toolId);
  await page.getByTestId('composer-input').fill('/image 根据刚才推荐方向生成一张活动海报');
  await page.getByTestId('composer-send').click();
  const picker = page.getByTestId('image-picker-dialog');
  await expect(picker).toBeVisible({ timeout: 10_000 });
  await expect(picker.getByTestId(`image-model-radio-${imageId}`)).toBeChecked();
  await picker.getByTestId('image-picker-submit').click();
  await continueCostConfirmIfVisible(page);
  await expect(page.getByTestId('msg-tool-images')).toHaveCount(1, { timeout: 30_000 });
  await expect(page.getByTestId('chat-panel')).toHaveAttribute('data-active-conv', convId);

  await page.getByTestId('tool-image-understand').last().click();
  await expect(page.getByTestId('active-model')).toHaveValue(visionId, { timeout: 10_000 });
  const visionReq = page.waitForRequest((req) => req.url().endsWith('/v1/chat') && req.method() === 'POST');
  await sendAndWait(page, '理解这张图片，并指出一个最值得强化的细节');
  const visionBody = JSON.parse((await visionReq).postData() ?? '{}') as {
    model_id?: string;
    conversation_id?: string;
    attachments?: unknown[];
  };
  expect(visionBody.model_id).toBe(visionId);
  expect(visionBody.conversation_id).toBe(convId);
  expect(visionBody.attachments?.length).toBeGreaterThan(0);

  const finalReq = page.waitForRequest((req) => req.url().endsWith('/v1/chat') && req.method() === 'POST');
  await page.getByTestId('active-model').selectOption(fastId);
  await sendAndWait(page, '最后用快速模型压缩成给设计师的三条修改建议');
  const finalBody = JSON.parse((await finalReq).postData() ?? '{}') as {
    model_id?: string;
    conversation_id?: string;
  };
  expect(finalBody.model_id).toBe(fastId);
  expect(finalBody.conversation_id).toBe(convId);
});

test('research thread can switch from search and fetch to quick compare adoption and back to fast synthesis', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { fastId, toolId } = await seedStack();
  await suppressTips(page);

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('active-model').selectOption(toolId);

  let before = mockRequests.length;
  await sendAndWait(page, '请搜索 Taori 多模型助手相关资料，给我两个调研方向');
  await expect
    .poll(() => mockRequests.slice(before).some((req) => req.toolNames.includes('web_search')), {
      timeout: 15_000,
    })
    .toBe(true);
  const convId = await expectActiveConversationId(page);

  before = mockRequests.length;
  await sendAndWait(page, '继续抓取网页 https://example.com/ ，把它和上一步搜索结果合并');
  await expect
    .poll(() => mockRequests.slice(before).some((req) => req.toolNames.includes('web_fetch')), {
      timeout: 15_000,
    })
    .toBe(true);

  await runQuickCompare(page, '把刚才的调研资料整理成两个可执行方案进行比较');
  await page.getByTestId('quick-compare-adopt-recommended').click();
  await expect(page.getByTestId('quick-compare-card')).toHaveCount(0, { timeout: 20_000 });
  await expect(page.getByTestId('chat-panel')).toHaveAttribute('data-active-conv', convId);

  const summaryReq = page.waitForRequest((req) => req.url().endsWith('/v1/chat') && req.method() === 'POST');
  await page.getByTestId('active-model').selectOption(fastId);
  await sendAndWait(page, '回到快速模型，输出一段适合团队同步的结论');
  const summaryBody = JSON.parse((await summaryReq).postData() ?? '{}') as {
    model_id?: string;
    conversation_id?: string;
  };
  expect(summaryBody.model_id).toBe(fastId);
  expect(summaryBody.conversation_id).toBe(convId);
});

test('one conversation can run quick compare twice, first with two models and then with three', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { fastId } = await seedStack();
  await suppressTips(page);

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await sendAndWait(page, '先建立一条会连续做多轮模型对比的工作线');
  const convId = await expectActiveConversationId(page);

  await runQuickCompare(page, '第一轮先只比较两个模型的结论', { selectedCount: 2 });
  await page.getByTestId('quick-compare-draft-follow-up').click();
  await expect(page.getByTestId('composer-input')).toContainText('最终推荐方案');
  const followReq = page.waitForRequest((req) => req.url().endsWith('/v1/chat') && req.method() === 'POST');
  await page.getByTestId('active-model').selectOption(fastId);
  await sendCurrentComposerAndWait(page);
  const followBody = JSON.parse((await followReq).postData() ?? '{}') as {
    model_id?: string;
    conversation_id?: string;
  };
  expect(followBody.model_id).toBe(fastId);
  expect(followBody.conversation_id).toBe(convId);

  await runQuickCompare(page, '第二轮再用三个模型做完整对比');
  await page.getByTestId('quick-compare-adopt-recommended').click();
  await expect(page.getByTestId('quick-compare-card')).toHaveCount(0, { timeout: 20_000 });
  await expect(page.getByTestId('chat-panel')).toHaveAttribute('data-active-conv', convId);
});
