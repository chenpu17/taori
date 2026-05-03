/**
 * Conservative guidance journeys.
 *
 * These specs verify the product does not auto-route the user's selected chat
 * model. It surfaces capability suggestions, lets the user explicitly switch,
 * and then makes tool execution visible in the assistant message.
 */
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

let server: ReturnType<typeof startMockOpenAI> | null = null;
let env: SidecarEnv;

test.beforeAll(() => {
  server = startMockOpenAI(MOCK_PORT, {
    imageToolCalls: true,
    webToolCalls: true,
    fixedReply: '保守引导回复：已在用户确认的模型和工具上下文中完成。',
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
      name: 'Conservative Guidance Mock',
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
    supports_vision?: boolean;
    is_default_for?: 'chat' | null;
    price_per_call?: number;
  },
): Promise<string> {
  const res = await authedFetch(env, '/v1/models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider_id: providerId,
      capability: spec.capability ?? 'chat',
      price_input_per_1m: 0.5,
      price_output_per_1m: 1,
      price_per_call: spec.price_per_call ?? null,
      supports_tools: spec.supports_tools ?? false,
      supports_vision: spec.supports_vision ?? false,
      ...spec,
    }),
  });
  expect(res.ok).toBeTruthy();
  return ((await res.json()) as { id: string }).id;
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
  await expect(page.locator('.msg.assistant').last()).toContainText('保守引导回复', {
    timeout: 20_000,
  });
}

async function suppressTips(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('tip_image_first_seen', 'true');
    localStorage.setItem('tip_fallback_first_seen', 'true');
    localStorage.setItem('tip_cost_first_seen', 'true');
    localStorage.setItem('tip_roundtable_first_seen', 'true');
  });
}

test('capability guidance suggests but does not auto-switch, then tool timeline explains execution', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const providerId = await seedProvider();
  const fastId = await seedModel(providerId, {
    model_name: 'mock-fast-no-tools',
    display_name: 'Fast No Tools',
    is_default_for: 'chat',
  });
  const toolId = await seedModel(providerId, {
    model_name: 'mock-tool-guided',
    display_name: 'Tool Guided',
    supports_tools: true,
  });
  await suppressTips(page);

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('active-model')).toHaveValue(fastId);

  await page.getByTestId('composer-input').fill('请搜索 Taori 多模型助手的最新资料并总结');
  const suggestion = page.getByTestId('capability-suggestion');
  await expect(suggestion).toBeVisible();
  await expect(suggestion).toHaveAttribute('data-kind', 'tools');
  await expect(page.getByTestId('active-model')).toHaveValue(fastId);

  await page.getByTestId('capability-suggestion-switch').click();
  await expect(page.getByTestId('active-model')).toHaveValue(toolId);

  await page.getByTestId('composer-send').click();
  await expect(page.locator('.msg.assistant').last()).toContainText('保守引导回复', {
    timeout: 30_000,
  });
  const timeline = page.getByTestId('tool-trace-timeline').last();
  await expect(timeline).toBeVisible();
  await expect(timeline.getByTestId('tool-trace-step').first()).toHaveAttribute(
    'data-tool',
    'builtin.web_search',
  );
  await expect(timeline.getByTestId('tool-trace-step').first()).toHaveAttribute(
    'data-status',
    'ok',
  );
});

test('built-in workflow templates fill the composer without changing the selected model', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const providerId = await seedProvider();
  const fastId = await seedModel(providerId, {
    model_name: 'mock-workflow-fast',
    display_name: 'Workflow Fast',
    is_default_for: 'chat',
  });
  await suppressTips(page);

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('active-model')).toHaveValue(fastId);

  await page.getByTestId('open-template-picker').click();
  const template = page.getByTestId('workflow-template-item').filter({ hasText: '网页调研报告' });
  await expect(template).toBeVisible();
  await template.click();
  await expect(page.getByTestId('template-vars-overlay')).toBeVisible();
  await page.getByTestId('template-var-input-主题').fill('Taori 产品竞争力');
  await page.getByTestId('template-vars-apply').click();

  await expect(page.getByTestId('composer-input')).toContainText('Taori 产品竞争力');
  await expect(page.getByTestId('composer-input')).toContainText('网页调研');
  await expect(page.getByTestId('active-model')).toHaveValue(fastId);
});

test('web fetch and image generation tool timelines are visible from normal chat turns', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const providerId = await seedProvider();
  const toolId = await seedModel(providerId, {
    model_name: 'mock-tool-timeline',
    display_name: 'Tool Timeline',
    supports_tools: true,
    is_default_for: 'chat',
  });
  await seedModel(providerId, {
    model_name: 'mock-image-timeline',
    display_name: 'Image Timeline',
    capability: 'image',
    price_per_call: 0.02,
  });
  await suppressTips(page);

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('active-model')).toHaveValue(toolId);

  await sendAndWait(page, '请抓取网页 https://example.com/ 并总结三点');
  const fetchTimeline = page.getByTestId('tool-trace-timeline').last();
  await expect(fetchTimeline).toBeVisible();
  await expect(fetchTimeline.getByTestId('tool-trace-step').first()).toHaveAttribute(
    'data-tool',
    'builtin.web_fetch',
  );
  await expect(fetchTimeline.getByTestId('tool-trace-step').first()).toHaveAttribute(
    'data-status',
    'ok',
  );

  await sendAndWait(page, '请生成一张用于产品介绍的简洁海报');
  await expect(page.getByTestId('msg-tool-images')).toHaveCount(1, { timeout: 30_000 });
  const imageTimeline = page.getByTestId('tool-trace-timeline').last();
  await expect(imageTimeline).toBeVisible();
  await expect(imageTimeline.getByTestId('tool-trace-step').first()).toHaveAttribute(
    'data-tool',
    'builtin.image_generate',
  );
  await expect(imageTimeline.getByTestId('tool-trace-step').first()).toHaveAttribute(
    'data-status',
    'ok',
  );
});

test('image tool off guidance opens the tools settings instead of switching models', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const providerId = await seedProvider();
  const chatId = await seedModel(providerId, {
    model_name: 'mock-image-off-chat',
    display_name: 'Image Off Chat',
    supports_tools: true,
    is_default_for: 'chat',
  });
  await seedModel(providerId, {
    model_name: 'mock-image-off-target',
    display_name: 'Image Off Target',
    capability: 'image',
    price_per_call: 0.02,
  });
  await suppressTips(page);

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('active-model')).toHaveValue(chatId);

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
  await expect(page.getByTestId('active-model')).toHaveValue(chatId);

  await page.getByTestId('capability-suggestion-configure').click();
  await expect(page.getByTestId('control-center')).toBeVisible();
  await expect(page.getByTestId('settings-tools')).toBeVisible();
});

test('custom templates coexist with built-in workflow templates and do not change model selection', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const providerId = await seedProvider();
  const fastId = await seedModel(providerId, {
    model_name: 'mock-custom-template-fast',
    display_name: 'Custom Template Fast',
    is_default_for: 'chat',
  });
  await suppressTips(page);

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('active-model')).toHaveValue(fastId);

  await page.getByTestId('open-settings').click();
  await page.getByTestId('settings-tab-prompts').click();
  await page.getByTestId('template-name-input').fill('我的复盘模板');
  await page.getByTestId('template-description-input').fill('自定义用户模板');
  await page
    .getByTestId('template-content-input')
    .fill('请围绕 {{项目}} 输出复盘结论、风险和下一步。');
  await page.getByTestId('template-save').click();
  await expect(page.getByTestId('template-card').filter({ hasText: '我的复盘模板' })).toBeVisible();
  await page.getByTestId('settings-close').click();

  await page.getByTestId('open-template-picker').click();
  await expect(page.getByTestId('workflow-template-item').filter({ hasText: '网页调研报告' })).toBeVisible();
  await page.getByTestId('template-picker-item').filter({ hasText: '我的复盘模板' }).click();
  await expect(page.getByTestId('template-vars-overlay')).toBeVisible();
  await page.getByTestId('template-var-input-项目').fill('Taori 内测');
  await page.getByTestId('template-vars-apply').click();

  await expect(page.getByTestId('composer-input')).toContainText('Taori 内测');
  await expect(page.getByTestId('composer-input')).toContainText('复盘结论');
  await expect(page.getByTestId('active-model')).toHaveValue(fastId);
});
