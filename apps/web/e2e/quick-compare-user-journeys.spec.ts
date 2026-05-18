import { test, expect, type Page } from '@playwright/test';
import {
  authedFetch,
  readSidecarEnv,
  resetSidecar,
  type SidecarEnv,
} from './_helpers';
import { startMockOpenAI } from './_mock-openai-server';

const MOCK_PORT = 17913;
const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}/v1`;
const LONG_REPLY = [
  '第一部分：结论先行，建议优先收敛为一个可上线的轻量版本。',
  '第二部分：把关键风险写成明确的守门条件，避免团队在执行中反复返工。',
  '第三部分：如果需要联网补证据，先抓最关键的用户反馈与竞品信息，再补充细节。',
  '第四部分：上线前请给出一句话价值、核心路径和失败兜底，确保普通用户第一次就能理解。',
  '第五部分：把这份方案当作可继续追问的工作草稿，而不是一次性结论。',
].join('\n\n');

let server: ReturnType<typeof startMockOpenAI> | null = null;
let env: SidecarEnv;

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  server = startMockOpenAI(MOCK_PORT, {
    fixedReply: LONG_REPLY,
    webToolCalls: true,
    streamPlanByModel: {
      'qc-stream-fast': { mode: 'chunked', chunkDelayMs: 120, stepChars: 10 },
      'qc-buffered-a': { mode: 'buffered', initialDelayMs: 1200 },
      'qc-buffered-b': { mode: 'buffered', initialDelayMs: 1800 },
      'qc-tool-researcher': { mode: 'chunked', chunkDelayMs: 90, stepChars: 12 },
      'qc-reviewer': { mode: 'chunked', chunkDelayMs: 100, stepChars: 10 },
    },
  });
  env = readSidecarEnv();
});

test.afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
});

test.beforeEach(async () => {
  await resetSidecar(env);
});

async function seedProvider(name = 'Quick Compare Journey Mock'): Promise<string> {
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
    capability?: 'chat' | 'image';
    is_default_for?: 'chat' | 'image' | null;
    supports_tools?: boolean;
    supports_vision?: boolean;
  },
): Promise<string> {
  const res = await authedFetch(env, '/v1/models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider_id: providerId,
      capability: spec.capability ?? 'chat',
      price_input_per_1m: 0.2,
      price_output_per_1m: 0.4,
      supports_tools: spec.supports_tools ?? false,
      supports_vision: spec.supports_vision ?? false,
      ...spec,
    }),
  });
  expect(res.ok).toBeTruthy();
  return ((await res.json()) as { id: string }).id;
}

async function seedStreamingCompareStack(): Promise<{
  fastId: string;
  bufferedAId: string;
  bufferedBId: string;
}> {
  const providerId = await seedProvider('Quick Compare Streaming Mock');
  const fastId = await seedModel(providerId, {
    model_name: 'qc-stream-fast',
    display_name: 'QC Stream Fast',
    is_default_for: 'chat',
  });
  const bufferedAId = await seedModel(providerId, {
    model_name: 'qc-buffered-a',
    display_name: 'QC Buffered A',
  });
  const bufferedBId = await seedModel(providerId, {
    model_name: 'qc-buffered-b',
    display_name: 'QC Buffered B',
  });
  return { fastId, bufferedAId, bufferedBId };
}

async function seedMixedJourneyStack(): Promise<{
  fastId: string;
  toolId: string;
  reviewerId: string;
}> {
  const providerId = await seedProvider('Quick Compare Mixed Journey Mock');
  const fastId = await seedModel(providerId, {
    model_name: 'qc-stream-fast',
    display_name: 'QC Stream Fast',
    is_default_for: 'chat',
  });
  const toolId = await seedModel(providerId, {
    model_name: 'qc-tool-researcher',
    display_name: 'QC Tool Researcher',
    supports_tools: true,
  });
  const reviewerId = await seedModel(providerId, {
    model_name: 'qc-reviewer',
    display_name: 'QC Reviewer',
  });
  return { fastId, toolId, reviewerId };
}

async function suppressTips(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('tip_roundtable_first_seen', 'true');
    localStorage.setItem('tip_cost_first_seen', 'true');
    localStorage.setItem('tip_image_first_seen', 'true');
    localStorage.setItem('tip_fallback_first_seen', 'true');
  });
}

async function gotoChat(page: Page): Promise<void> {
  await suppressTips(page);
  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 20_000 });
}

async function sendAndWait(page: Page, text: string): Promise<void> {
  const before = await page.locator('.msg.assistant').count();
  await page.getByTestId('composer-input').fill(text);
  await page.getByTestId('composer-send').click();
  await expect
    .poll(async () => await page.locator('.msg.assistant').count(), { timeout: 30_000 })
    .toBeGreaterThan(before);
  await expect(page.locator('.msg.assistant').last()).toContainText('第一部分：结论先行', {
    timeout: 20_000,
  });
}

async function switchModel(page: Page, modelId: string): Promise<void> {
  await page.getByTestId('active-model').selectOption(modelId);
  await expect(page.getByTestId('active-model')).toHaveValue(modelId);
}

async function runQuickCompare(page: Page, prompt: string): Promise<void> {
  await page.getByTestId('composer-input').fill(prompt);
  await page.getByTestId('composer-tools-toggle').click();
  await expect(page.getByTestId('composer-quick-compare')).toBeVisible();
  await page.getByTestId('composer-quick-compare').click();
  const picker = page.getByTestId('quick-compare-picker');
  await expect(picker).toBeVisible({ timeout: 10_000 });
  await expect(picker.getByTestId('quick-compare-picker-count')).toContainText('已选 3/3');
  await picker.getByTestId('quick-compare-picker-submit').click();
  await expect(page.getByTestId('quick-compare-card')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('quick-compare-output')).toHaveCount(3, { timeout: 20_000 });
}

async function waitQuickCompareCompleted(page: Page): Promise<void> {
  await expect(page.locator('.quick-compare-output.quick-compare-complete')).toHaveCount(3, {
    timeout: 30_000,
  });
  await expect(page.getByTestId('quick-compare-decision-report')).toBeVisible();
}

async function getQuickCompareDetail(compareId: string): Promise<{
  compare: { conversation_id: string };
  outputs: Array<{ model_id: string; first_token_ms: number | null; duration_ms: number | null }>;
}> {
  const res = await authedFetch(env, `/v1/quick-compare/${compareId}`);
  expect(res.ok).toBeTruthy();
  return ((await res.json()) as { ok: true; data: {
    compare: { conversation_id: string };
    outputs: Array<{ model_id: string; first_token_ms: number | null; duration_ms: number | null }>;
  } }).data;
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(overflow.scroll).toBeLessThanOrEqual(overflow.client + 1);
}

test('Quick Compare visibly mixes incremental and buffered columns and records first-token gaps', async ({ page }) => {
  const ids = await seedStreamingCompareStack();
  await gotoChat(page);

  await runQuickCompare(page, '请从三种不同风格给出上线建议，并解释差异。');

  const outputs = page.getByTestId('quick-compare-output');
  await page.waitForTimeout(700);
  await expect(outputs.nth(0)).not.toContainText('（暂无内容）');
  await expect(outputs.nth(1)).toContainText('（暂无内容）');
  await expect(outputs.nth(2)).toContainText('（暂无内容）');

  await waitQuickCompareCompleted(page);

  const compareId = await page.getByTestId('quick-compare-card').getAttribute('data-compare-id');
  expect(compareId).toBeTruthy();
  const detail = await getQuickCompareDetail(compareId!);
  const fast = detail.outputs.find((item) => item.model_id === ids.fastId);
  const bufferedA = detail.outputs.find((item) => item.model_id === ids.bufferedAId);
  const bufferedB = detail.outputs.find((item) => item.model_id === ids.bufferedBId);
  expect(fast?.first_token_ms).not.toBeNull();
  expect(bufferedA?.first_token_ms).not.toBeNull();
  expect(bufferedB?.first_token_ms).not.toBeNull();
  expect((fast?.first_token_ms ?? 0)).toBeLessThan((bufferedA?.first_token_ms ?? 0));
  expect((bufferedA?.first_token_ms ?? 0)).toBeLessThan((bufferedB?.first_token_ms ?? 0));
});

test('multi-turn quick compare keeps context across model switch, tool use, and adopt scrolls to latest reply', async ({ page }) => {
  const ids = await seedMixedJourneyStack();
  await gotoChat(page);

  await sendAndWait(page, '先给我一版发布说明草稿。');
  const conversationId = await page.getByTestId('chat-panel').getAttribute('data-active-conv');
  expect(conversationId).toBeTruthy();

  await switchModel(page, ids.toolId);
  await sendAndWait(page, '请抓取 https://example.com/ 的信息，并把能用于发布说明的要点补进去。');

  await runQuickCompare(page, '基于前两轮上下文，对比三种上线建议并给出推荐。');
  await waitQuickCompareCompleted(page);
  await page.getByTestId('quick-compare-adopt-recommended').click();

  await expect(page.getByTestId('quick-compare-card')).toHaveCount(0, { timeout: 20_000 });
  await expect(page.locator('.msg.assistant').last()).toContainText('第一部分：结论先行', {
    timeout: 20_000,
  });

  const activeConversationId = await page.getByTestId('chat-panel').getAttribute('data-active-conv');
  expect(activeConversationId).toBe(conversationId);
  const bottomGap = await page.locator('.messages').evaluate((node) => {
    return node.scrollHeight - node.scrollTop - node.clientHeight;
  });
  expect(bottomGap).toBeLessThanOrEqual(24);
});

test('small viewport quick compare keeps scrollable content and adopt actions reachable without horizontal overflow', async ({ page }) => {
  await seedMixedJourneyStack();
  await page.setViewportSize({ width: 390, height: 560 });
  await gotoChat(page);

  await runQuickCompare(page, '请给我一份较长的方案比较，便于我在手机宽度下检查阅读和滚动体验。');
  await waitQuickCompareCompleted(page);

  const beforeScrollY = await page.evaluate(() => window.scrollY);
  const lastAdopt = page.getByTestId('quick-compare-adopt').last();
  await lastAdopt.scrollIntoViewIfNeeded();
  const afterScrollY = await page.evaluate(() => window.scrollY);
  expect(afterScrollY).toBeGreaterThanOrEqual(beforeScrollY);
  await expect(lastAdopt).toBeInViewport();
  await expectNoHorizontalOverflow(page);
});
