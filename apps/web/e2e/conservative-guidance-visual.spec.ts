/**
 * Visual verification for conservative guidance surfaces.
 *
 * These journeys intentionally capture screenshots around the new Web UI states:
 * capability suggestions, tool timelines, built-in workflow templates, and the
 * tools settings entry opened from disabled-tool guidance.
 */
import { test, expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import {
  authedFetch,
  readSidecarEnv,
  resetSidecar,
  type SidecarEnv,
} from './_helpers';
import { startMockOpenAI } from './_mock-openai-server';

const MOCK_PORT = 17914;
const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}/v1`;

let server: ReturnType<typeof startMockOpenAI> | null = null;
let env: SidecarEnv;

test.beforeAll(() => {
  server = startMockOpenAI(MOCK_PORT, {
    imageToolCalls: true,
    webToolCalls: true,
    fixedReply: '视觉验证回复：工具和模型选择均由用户确认后继续。',
  });
  env = readSidecarEnv();
});

test.afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
});

test.beforeEach(async () => {
  await resetSidecar(env);
});

async function seedProvider(): Promise<string> {
  const res = await authedFetch(env, '/v1/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Visual Conservative Mock',
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
    supports_tools?: boolean;
    is_default_for?: 'chat' | 'image' | null;
    price_per_call?: number;
  },
): Promise<string> {
  const res = await authedFetch(env, '/v1/models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider_id: providerId,
      capability: spec.capability ?? 'chat',
      supports_tools: spec.supports_tools ?? false,
      price_input_per_1m: 0.5,
      price_output_per_1m: 1,
      price_per_call: spec.price_per_call ?? null,
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

async function capture(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name}.png`);
  await page.waitForTimeout(250);
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

test('desktop visual: capability suggestion and tool timeline are legible in the chat surface', async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const providerId = await seedProvider();
  const fastId = await seedModel(providerId, {
    model_name: 'visual-fast-no-tools',
    display_name: 'Visual Fast No Tools',
    is_default_for: 'chat',
  });
  const toolId = await seedModel(providerId, {
    model_name: 'visual-tool-researcher',
    display_name: 'Visual Tool Researcher',
    supports_tools: true,
  });
  await suppressTips(page);
  await page.setViewportSize({ width: 1280, height: 760 });

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('active-model')).toHaveValue(fastId);

  await page.getByTestId('composer-input').fill('请搜索 Taori 多模型助手并给出可执行摘要');
  const suggestion = page.getByTestId('capability-suggestion');
  await expect(suggestion).toBeVisible();
  await expect(suggestion).toContainText('建议切到工具模型');
  await expect(suggestion.getByTestId('capability-suggestion-switch')).toBeInViewport();
  await expectHorizontallyWithinViewport(page, suggestion);
  await expectPageHasNoHorizontalOverflow(page);
  await capture(page, testInfo, 'desktop-capability-suggestion');

  await suggestion.getByTestId('capability-suggestion-switch').click();
  await expect(page.getByTestId('active-model')).toHaveValue(toolId);
  await page.getByTestId('composer-send').click();
  await expect(page.locator('.msg.assistant').last()).toContainText('视觉验证回复', {
    timeout: 30_000,
  });

  const settledAssistant = page.locator('.msg.assistant:not(.streaming)').last();
  await expect(settledAssistant).toContainText('视觉验证回复', { timeout: 30_000 });
  const timeline = settledAssistant.getByTestId('tool-trace-timeline');
  await expect(timeline).toBeVisible();
  await expect(timeline).toContainText('工具执行');
  await expect(timeline.getByTestId('tool-trace-step').first()).toHaveAttribute(
    'data-tool',
    'builtin.web_search',
  );
  await expectElementHasNoHorizontalOverflow(timeline);
  await expectPageHasNoHorizontalOverflow(page);
  await capture(page, testInfo, 'desktop-tool-timeline');
});

test('small viewport visual: workflow templates and disabled-tool guidance stay usable', async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const providerId = await seedProvider();
  const chatId = await seedModel(providerId, {
    model_name: 'visual-mobile-chat',
    display_name: 'Visual Mobile Chat',
    supports_tools: true,
    is_default_for: 'chat',
  });
  await seedModel(providerId, {
    model_name: 'visual-mobile-image',
    display_name: 'Visual Mobile Image',
    capability: 'image',
    price_per_call: 0.02,
  });
  await suppressTips(page);
  await page.setViewportSize({ width: 390, height: 720 });

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('active-model')).toHaveValue(chatId);

  await page.getByTestId('open-template-picker').click();
  const picker = page.getByTestId('template-picker-overlay');
  const pickerDialog = picker.locator('.picker-dialog');
  await expect(picker).toBeVisible();
  await expect(page.getByTestId('workflow-template-item').filter({ hasText: '网页调研报告' })).toBeVisible();
  await expectHorizontallyWithinViewport(page, pickerDialog);
  await expectPageHasNoHorizontalOverflow(page);
  await capture(page, testInfo, 'mobile-template-picker');

  await page.getByTestId('workflow-template-item').filter({ hasText: '网页调研报告' }).click();
  const varsOverlay = page.getByTestId('template-vars-overlay');
  const varsDialog = varsOverlay.locator('.picker-dialog');
  await expect(varsOverlay).toBeVisible();
  await page.getByTestId('template-var-input-主题').fill('Taori 小屏验证');
  await expect(page.getByTestId('template-vars-apply')).toBeInViewport();
  await expectHorizontallyWithinViewport(page, varsDialog);
  await expectPageHasNoHorizontalOverflow(page);
  await capture(page, testInfo, 'mobile-template-vars');
  await page.getByTestId('template-vars-apply').click();

  await page.getByTestId('open-settings').click();
  await page.getByTestId('settings-tab-tools').click();
  const imageToggle = page.getByTestId('tool-toggle-builtin.image_generate');
  await expect(imageToggle).toContainText('已启用');
  await imageToggle.click();
  await expect(imageToggle).toContainText('已关闭');
  await page.getByTestId('settings-close').click();

  await page.getByTestId('composer-input').fill('请生成一张产品发布海报');
  const suggestion = page.getByTestId('capability-suggestion');
  await expect(suggestion).toBeVisible();
  await expect(suggestion).toHaveAttribute('data-kind', 'image-tool-off');
  await expect(suggestion.getByTestId('capability-suggestion-configure')).toBeInViewport();
  await expectHorizontallyWithinViewport(page, suggestion);
  await expectPageHasNoHorizontalOverflow(page);
  await capture(page, testInfo, 'mobile-image-tool-off-suggestion');

  await suggestion.getByTestId('capability-suggestion-configure').click();
  const controlCenter = page.getByTestId('control-center');
  await expect(controlCenter).toBeVisible();
  await expect(page.getByTestId('settings-tools')).toBeVisible();
  await expect(page.getByTestId('settings-close')).toBeInViewport();
  await expectHorizontallyWithinViewport(page, controlCenter);
  await expectPageHasNoHorizontalOverflow(page);
  await capture(page, testInfo, 'mobile-tools-control-center');
});
