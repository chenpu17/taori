/**
 * Visual layout journeys for small desktop/mobile-sized windows.
 *
 * These tests guard the UI issues that are hard to catch with data-only e2e:
 * modal overflow, unreachable primary actions, and non-scrollable long panels.
 */
import { test, expect, type Locator, type Page } from '@playwright/test';
import { authedFetch, readSidecarEnv, resetSidecar, type SidecarEnv } from './_helpers';
import { startMockOpenAI } from './_mock-openai-server';

let env: SidecarEnv;
const MOCK_PORT = 17910;
const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}/v1`;
let server: ReturnType<typeof startMockOpenAI> | null = null;

test.beforeAll(() => {
  server = startMockOpenAI(MOCK_PORT);
});

test.afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
});

test.beforeEach(async () => {
  env = readSidecarEnv();
  await resetSidecar(env);
});

async function seedProvider(): Promise<string> {
  const res = await authedFetch(env, '/v1/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Visual Mock',
      type: 'custom',
      base_url: 'https://visual.invalid/v1',
    }),
  });
  expect(res.ok).toBeTruthy();
  return ((await res.json()) as { id: string }).id;
}

async function seedChatModels(count = 1): Promise<void> {
  const providerId = await seedProvider();
  for (let i = 0; i < count; i++) {
    const res = await authedFetch(env, '/v1/models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider_id: providerId,
        model_name: `visual-chat-${i}`,
        capability: 'chat',
        display_name: `Visual Chat ${i}`,
        ...(i === 0 ? { is_default_for: 'chat' } : {}),
        price_input_per_1m: 0.5,
        price_output_per_1m: 1.5,
      }),
    });
    expect(res.ok).toBeTruthy();
  }
}

async function seedStreamingChatModels(count = 3): Promise<void> {
  const res = await authedFetch(env, '/v1/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Visual Streaming Mock',
      type: 'openai',
      base_url: MOCK_URL,
      api_key: 'sk-test',
    }),
  });
  expect(res.ok).toBeTruthy();
  const providerId = ((await res.json()) as { id: string }).id;
  for (let i = 0; i < count; i++) {
    const modelRes = await authedFetch(env, '/v1/models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider_id: providerId,
        model_name: `visual-streaming-chat-${i}`,
        capability: 'chat',
        display_name: `Visual Streaming Chat ${i}`,
        ...(i === 0 ? { is_default_for: 'chat' } : {}),
        price_input_per_1m: 0.5,
        price_output_per_1m: 1.5,
      }),
    });
    expect(modelRes.ok).toBeTruthy();
  }
}

async function seedFailoverChatModels(): Promise<{ primaryId: string; fallbackId: string }> {
  const providerId = await seedProvider();
  const primaryRes = await authedFetch(env, '/v1/models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider_id: providerId,
      model_name: 'visual-primary',
      capability: 'chat',
      display_name: 'Visual Primary',
      is_default_for: 'chat',
      price_input_per_1m: 0.5,
      price_output_per_1m: 1.5,
    }),
  });
  expect(primaryRes.ok).toBeTruthy();
  const fallbackRes = await authedFetch(env, '/v1/models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider_id: providerId,
      model_name: 'visual-fallback',
      capability: 'chat',
      display_name: 'Visual Fallback',
      price_input_per_1m: 0.2,
      price_output_per_1m: 0.8,
    }),
  });
  expect(fallbackRes.ok).toBeTruthy();
  return {
    primaryId: ((await primaryRes.json()) as { id: string }).id,
    fallbackId: ((await fallbackRes.json()) as { id: string }).id,
  };
}

async function seedImageModels(count = 1): Promise<void> {
  const providersRes = await authedFetch(env, '/v1/providers');
  const providers = (await providersRes.json()) as { providers: Array<{ id: string }> };
  const providerId = providers.providers[0]?.id ?? (await seedProvider());
  for (let i = 0; i < count; i++) {
    const res = await authedFetch(env, '/v1/models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider_id: providerId,
        model_name: `visual-image-${i}`,
        capability: 'image',
        display_name: `Very Long Visual Image Model Name ${i}`,
        ...(i === 0 ? { is_default_for: 'image' } : {}),
        price_per_call: 0.02 + i * 0.01,
      }),
    });
    expect(res.ok).toBeTruthy();
  }
}

async function seedChatCost(content: string): Promise<void> {
  const modelsRes = await authedFetch(env, '/v1/models');
  const models = (await modelsRes.json()) as { models: Array<{ id: string }> };
  const modelId = models.models[0]!.id;
  const chatRes = await authedFetch(env, '/v1/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model_id: modelId,
      messages: [{ role: 'user', content }],
    }),
  });
  expect(chatRes.ok).toBeTruthy();
  await chatRes.text();
}

async function findConversationContaining(text: string): Promise<string> {
  const convsRes = await authedFetch(env, '/v1/conversations');
  const convs = (await convsRes.json()) as {
    conversations: Array<{ id: string }>;
  };
  for (const conv of convs.conversations) {
    const msgsRes = await authedFetch(env, `/v1/conversations/${conv.id}/messages`);
    const msgs = (await msgsRes.json()) as {
      messages: Array<{ content: string | null }>;
    };
    if (msgs.messages.some((m) => (m.content ?? '').includes(text))) {
      return conv.id;
    }
  }
  throw new Error(`conversation containing "${text}" not found`);
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

async function scrollToBottom(locator: Locator): Promise<void> {
  await locator.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
}

async function expectReadableContrast(locator: Locator): Promise<void> {
  const contrast = await locator.evaluate((el) => {
    const style = getComputedStyle(el);
    const parse = (color: string): [number, number, number] => {
      const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (!match) throw new Error(`Unsupported CSS color: ${color}`);
      return [Number(match[1]), Number(match[2]), Number(match[3])];
    };
    const luminance = ([r, g, b]: [number, number, number]): number => {
      const linear = [r, g, b].map((channel) => {
        const value = channel / 255;
        return value <= 0.03928
          ? value / 12.92
          : Math.pow((value + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
    };
    const fg = luminance(parse(style.color));
    const bg = luminance(parse(style.backgroundColor));
    const lighter = Math.max(fg, bg);
    const darker = Math.min(fg, bg);
    return (lighter + 0.05) / (darker + 0.05);
  });
  expect(contrast).toBeGreaterThanOrEqual(4.5);
}

test('small viewport: image picker remains scrollable and actions reachable with many models', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await seedChatModels(1);
  await seedImageModels(12);

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('composer-input').fill('/image 画一张长颈鹿在城市里散步');
  await page.getByTestId('composer-send').click();

  const dialog = page.getByTestId('image-picker-dialog');
  const card = dialog.locator('.modal-card');
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await expectHorizontallyWithinViewport(page, card);

  const needsScroll = await card.evaluate((el) => el.scrollHeight > el.clientHeight);
  if (needsScroll) {
    await card.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
  }
  await expect(dialog.getByTestId('image-picker-submit')).toBeInViewport();
  await expect(dialog.getByTestId('image-picker-cancel')).toBeInViewport();
});

test('small viewport: roundtable launch dialog keeps primary actions reachable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await seedChatModels(3);

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('composer-input').fill('小屏圆桌：是否采用新计费策略');
  await page.getByTestId('composer-roundtable').click();

  const dialog = page.getByTestId('roundtable-launch-dialog');
  const card = dialog.locator('.modal-card');
  await expect(dialog).toBeVisible();
  await expectHorizontallyWithinViewport(page, card);
  await expect(dialog.getByTestId('roundtable-launch-start')).toBeInViewport();
  await expect(dialog.getByTestId('roundtable-launch-cancel')).toBeInViewport();
});

test('small viewport: completed roundtable panel scrolls and loopback process entry is reachable', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 360, height: 560 });
  await seedStreamingChatModels(3);

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('composer-input').fill('小屏圆桌面板：第二轮与总结滚动验证');
  await page.getByTestId('composer-roundtable').click();

  const dialog = page.getByTestId('roundtable-launch-dialog');
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await dialog.getByTestId('roundtable-mode-select').selectOption('deep');
  await dialog.getByTestId('roundtable-launch-start').click();
  await expect(dialog.getByTestId('roundtable-preview')).toBeVisible({ timeout: 30_000 });
  await dialog.getByTestId('roundtable-launch-continue').click();

  const panel = page.getByTestId('roundtable-panel');
  await expect(panel).toBeVisible({ timeout: 15_000 });
  await expectHorizontallyWithinViewport(page, panel);
  await expectPageHasNoHorizontalOverflow(page);

  await panel.getByTestId('roundtable-action-start-round').click();
  await expect(panel.getByTestId('roundtable-cell-0-1')).toHaveClass(
    /roundtable-cell-complete/,
    { timeout: 60_000 },
  );
  await scrollToBottom(panel);
  await expect(panel.getByTestId('roundtable-action-next-round')).toBeInViewport();

  await panel.getByTestId('roundtable-action-next-round').click();
  await expect(panel.getByTestId('roundtable-cell-0-2')).toHaveClass(
    /roundtable-cell-complete/,
    { timeout: 60_000 },
  );
  await scrollToBottom(panel);
  await expect(panel.getByTestId('roundtable-action-summarize')).toBeInViewport();

  await panel.getByTestId('roundtable-action-summarize').click();
  await expect(panel.getByTestId('roundtable-summary')).toBeVisible({
    timeout: 60_000,
  });
  await expect(panel.getByTestId('roundtable-summary')).toContainText('推荐决策');
  await expect(panel.getByTestId('roundtable-summary')).not.toContainText('{');

  const loopback = panel.getByTestId('roundtable-loopback');
  await expect(loopback).toContainText('已带回', { timeout: 10_000 });
  await scrollToBottom(panel);
  await expect(loopback).toBeInViewport();
  await loopback.click();

  await expect(panel).toBeHidden({ timeout: 10_000 });
  await expect(page.getByTestId('messages')).toContainText('来自圆桌讨论', {
    timeout: 10_000,
  });
  const banner = page.getByTestId('roundtable-associated-banner');
  await expect(banner).toBeVisible({ timeout: 10_000 });
  await expect(banner).toBeInViewport();
  await expect(page.getByTestId('roundtable-associated-open')).toBeInViewport();
});

test('small viewport: model center fits horizontally and can scroll to close', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await seedChatModels(6);

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('open-model-center').click();

  const center = page.getByTestId('model-center');
  await expect(center).toBeVisible();
  await expectHorizontallyWithinViewport(page, center);
  await expect(page.getByTestId('model-center-close')).toBeInViewport();
});

test('visual contrast: sidebar search, import filters, and edit cancel remain readable', async ({
  page,
}) => {
  await seedChatModels(1);
  await seedChatCost('视觉对比回归：按钮和过滤输入框');
  const conversationId = await findConversationContaining('视觉对比回归');

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await expectReadableContrast(page.getByTestId('conv-search'));

  await page.getByTestId('open-model-center').click();
  await expect(page.getByTestId('model-center')).toBeVisible();
  await page.getByTestId('model-center-import').click();
  await expect(page.getByTestId('import-drawer')).toBeVisible();
  await expectReadableContrast(page.getByTestId('import-drawer-provider'));
  await expectReadableContrast(page.getByTestId('import-drawer-capability'));
  await expectReadableContrast(page.getByTestId('import-drawer-filter'));
  await page.getByTestId('import-drawer').getByLabel('关闭').click();
  await page.getByTestId('model-center-close').click();

  await page.locator(`[data-testid="conv-item"][data-conv-id="${conversationId}"]`).click();
  const firstUser = page.locator('.msg.user').first();
  await firstUser.hover();
  await firstUser.getByTestId('msg-edit').click();
  await expect(firstUser.getByTestId('msg-edit-cancel')).toBeVisible();
  await expectReadableContrast(firstUser.getByTestId('msg-edit-cancel'));
});

test('small viewport: settings long content can scroll to danger zone and actions stay reachable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await seedChatModels(1);

  for (let i = 0; i < 6; i++) {
    const res = await authedFetch(env, '/v1/prompt-templates', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: `长内容模板 ${i}`,
        description: '用于验证设置面板长列表在小屏下不会遮挡危险区动作',
        content: `请分析 {{问题${i}}} 的用户旅程，并给出一段足够长的上下文：${'很长的模板内容。'.repeat(20)}`,
      }),
    });
    expect(res.ok).toBeTruthy();
  }

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('open-settings').click();

  const overlay = page.getByTestId('settings-overlay');
  const modal = overlay.locator('.settings-modal');
  await expect(overlay).toBeVisible();
  await expectHorizontallyWithinViewport(page, modal);
  await expectPageHasNoHorizontalOverflow(page);

  await scrollToBottom(modal);
  await expect(page.getByTestId('settings-danger-zone')).toBeInViewport();
  await expect(page.getByTestId('settings-clear-all')).toBeInViewport();
});

test('small viewport: help center self-check remains scrollable after results render', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await seedChatModels(1);

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('open-help').click();

  const center = page.getByTestId('help-center');
  await expect(center).toBeVisible();
  await expectHorizontallyWithinViewport(page, center);
  await page.getByTestId('help-selfcheck-run').click();
  await expect(page.getByTestId('help-selfcheck-overall')).toBeVisible({ timeout: 10_000 });
  await scrollToBottom(center);
  await expect(page.getByTestId('help-selfcheck-list')).toBeInViewport();
  await expect(page.getByTestId('help-center-close')).toBeInViewport();
});

test('small viewport: cost dashboard with long labels fits and can close', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await seedChatModels(1);

  const modelRes = await authedFetch(env, '/v1/models');
  const modelBody = (await modelRes.json()) as { models: Array<{ id: string }> };
  const modelId = modelBody.models[0]!.id;
  for (let i = 0; i < 4; i++) {
    const chatRes = await authedFetch(env, '/v1/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model_id: modelId,
        messages: [
          {
            role: 'user',
            content: `成本看板小屏长内容 ${i} ${'非常长的会话标题片段'.repeat(8)}`,
          },
        ],
      }),
    });
    expect(chatRes.ok).toBeTruthy();
    await chatRes.text();
  }

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('open-cost-dashboard').click();

  const dashboard = page.getByTestId('cost-dashboard-panel');
  await expect(dashboard).toBeVisible();
  await expectHorizontallyWithinViewport(page, dashboard);
  await expectPageHasNoHorizontalOverflow(page);
  await expect(page.getByTestId('cost-dashboard-row').first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('cost-dashboard-close')).toBeInViewport();
});

test('small viewport: template variable dialog with many variables keeps apply reachable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await seedChatModels(1);

  const vars = Array.from({ length: 12 }, (_, i) => `变量${i + 1}`);
  const res = await authedFetch(env, '/v1/prompt-templates', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: '多变量模板',
      description: '验证变量弹层滚动',
      content: vars.map((v) => `${v}: {{${v}}}`).join('\n'),
    }),
  });
  expect(res.ok).toBeTruthy();

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('open-template-picker').click();
  await expect(page.getByTestId('template-picker-overlay')).toBeVisible();
  await page.getByTestId('template-picker-item').first().click();

  const overlay = page.getByTestId('template-vars-overlay');
  const dialog = overlay.locator('.picker-dialog');
  await expect(overlay).toBeVisible();
  await expectHorizontallyWithinViewport(page, dialog);
  await expectPageHasNoHorizontalOverflow(page);
  await scrollToBottom(dialog);
  await expect(page.getByTestId('template-vars-apply')).toBeInViewport();
});

test('small viewport: command palette fixed commands open their target surfaces', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await seedChatModels(1);

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
  const palette = page.locator('.cmd-palette-panel');
  await expect(page.getByTestId('cmd-palette-input')).toBeVisible();
  await expectHorizontallyWithinViewport(page, palette);
  await expectPageHasNoHorizontalOverflow(page);

  await page.locator('[data-testid="cmd-result"][data-category="models-center"]').click();
  await expect(page.getByTestId('model-center')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('model-center-close').click();

  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
  await page.locator('[data-testid="cmd-result"][data-category="help"]').click();
  await expect(page.getByTestId('help-center')).toBeVisible();
  await page.getByTestId('help-center-close').click();

  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
  await page.locator('[data-testid="cmd-result"][data-category="settings"]').click();
  await expect(page.getByTestId('settings-overlay')).toBeVisible();
});

test('small viewport: first-run onboarding form is usable without horizontal overflow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 640 });

  await page.goto('/');

  const onboarding = page.getByTestId('onboarding');
  await expect(onboarding).toBeVisible({ timeout: 10_000 });
  await expectHorizontallyWithinViewport(page, onboarding);
  await expectPageHasNoHorizontalOverflow(page);
  await expect(page.getByTestId('onb-provider-type')).toBeInViewport();
  await expect(page.getByTestId('onb-api-key')).toBeInViewport();
  await expect(page.getByTestId('onb-submit')).toBeInViewport();
  await expect(page.getByTestId('onb-skip')).toBeInViewport();
});

test('small viewport: session cost drawer fits and closes after real cost exists', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await seedChatModels(1);
  await seedChatCost(`小屏成本抽屉 ${'长模型与特性名称'.repeat(12)}`);

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('cost-today').click();

  const panel = page.getByTestId('session-cost-panel');
  await expect(panel).toBeVisible();
  await expectHorizontallyWithinViewport(page, panel);
  await expectPageHasNoHorizontalOverflow(page);
  await expect(page.getByTestId('session-cost-close')).toBeInViewport();
  await page.getByTestId('session-cost-close').click();
  await expect(panel).toHaveCount(0);
});

test('small viewport: budget confirmation dialog keeps all decision actions reachable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await seedChatModels(2);
  await seedChatCost('预算确认小屏基线');
  await authedFetch(env, '/v1/memories', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      scope: 'global',
      scope_id: null,
      key: 'monthly_budget_usd',
      value: '0.000001',
    }),
  });

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('composer-input').fill('预算已超时继续发送');
  await page.getByTestId('composer-send').click();

  const dialog = page.getByTestId('cost-confirm-dialog');
  const card = dialog.locator('.modal-card');
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await expectHorizontallyWithinViewport(page, card);
  await expectPageHasNoHorizontalOverflow(page);
  await scrollToBottom(card);
  await expect(page.getByTestId('cost-confirm-continue')).toBeInViewport();
  await expect(page.getByTestId('cost-confirm-cheaper')).toBeInViewport();
  await expect(page.getByTestId('cost-confirm-cancel')).toBeInViewport();
});

test('small viewport: model editor long form fits and save/cancel remain reachable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await seedChatModels(1);

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('open-model-center').click();
  await expect(page.getByTestId('model-center')).toBeVisible();
  await page.locator('[data-testid^="model-edit-"]').first().click();

  const editor = page.getByTestId('model-editor');
  await expect(editor).toBeVisible();
  await expectHorizontallyWithinViewport(page, editor);
  await expectPageHasNoHorizontalOverflow(page);
  await editor.locator('.model-editor__body').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(page.getByTestId('model-editor-save')).toBeInViewport();
  await expect(page.getByTestId('model-editor-cancel')).toBeInViewport();
});

test('small viewport: failure decision card wraps actions instead of clipping them', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 640 });
  const { fallbackId } = await seedFailoverChatModels();

  await page.route('**/v1/chat', async (route) => {
    await route.continue({
      headers: {
        ...route.request().headers(),
        'x-test-force-classification': 'rate_limit',
      },
    });
  });

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('composer-input').fill('触发小屏失败兜底卡');
  await page.getByTestId('composer-send').click();

  const card = page.getByTestId('failure-decision-card');
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expectHorizontallyWithinViewport(page, card);
  await expectPageHasNoHorizontalOverflow(page);
  await expect(page.getByTestId('fdc-switch')).toContainText('Visual Fallback');
  await expect(page.getByTestId('fdc-switch')).toBeInViewport();
  await page.getByTestId('fdc-switch').click();
  await expect(page.getByTestId('active-model')).toHaveValue(fallbackId);
});

test('small viewport: sidebar governance actions and tag editor are discoverable without hover', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await seedChatModels(1);
  await seedChatCost(`移动端侧栏治理 ${'很长的会话标题'.repeat(8)}`);
  await seedChatCost('移动端侧栏第二条');

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('conv-item')).toHaveCount(2);
  await expectPageHasNoHorizontalOverflow(page);

  const firstRow = page.getByTestId('conv-item').first();
  const actions = firstRow.locator('.conv-actions');
  await expect(actions).toBeVisible();
  await expect
    .poll(async () => actions.evaluate((el) => getComputedStyle(el).opacity))
    .toBe('1');

  await firstRow.getByTestId('conv-tag-edit').click();
  const tagInput = firstRow.getByTestId('conv-tag-input');
  await expect(tagInput).toBeInViewport();
  await tagInput.fill('重要, 回归, 长标签名称不会撑开侧栏');
  await firstRow.getByTestId('conv-tag-save').click();
  await expect(firstRow.getByTestId('conv-tag-chip')).toHaveCount(3);
  await expectPageHasNoHorizontalOverflow(page);
});

test('small viewport: message actions are visible after a completed response without hover', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await seedChatModels(1);

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('composer-input').fill('小屏消息动作不应该依赖 hover');
  await page.getByTestId('composer-send').click();
  await expect(page.locator('.msg.assistant').last()).toBeVisible({ timeout: 20_000 });

  const actions = page.getByTestId('msg-actions').last();
  await expect(actions).toBeInViewport();
  await expect
    .poll(async () => actions.evaluate((el) => getComputedStyle(el).opacity))
    .toBe('1');
  await expect(actions.getByTestId('msg-copy')).toBeInViewport();
  await expect(actions.getByTestId('msg-regenerate')).toBeInViewport();
  await expectPageHasNoHorizontalOverflow(page);
});

test('desktop journey: long conversation reload lands at latest message with composer usable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 760 });
  await seedChatModels(1);
  const modelsRes = await authedFetch(env, '/v1/models');
  const models = (await modelsRes.json()) as { models: Array<{ id: string }> };
  const modelId = models.models[0]!.id;
  const marker = '长对话滚动恢复第 1 条';

  let conversationId: string | null = null;
  for (let i = 0; i < 12; i++) {
    const chatRes = await authedFetch(env, '/v1/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...(conversationId ? { conversation_id: conversationId } : {}),
        model_id: modelId,
        messages: [
          {
            role: 'user',
            content: `${i === 0 ? marker : `长对话滚动恢复第 ${i + 1} 条`} ${'内容'.repeat(40)}`,
          },
        ],
      }),
    });
    expect(chatRes.ok).toBeTruthy();
    await chatRes.text();
    if (!conversationId) conversationId = await findConversationContaining(marker);
  }
  expect(conversationId).toBeTruthy();

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await page.locator(`[data-testid="conv-item"][data-conv-id="${conversationId}"]`).click();
  await expect(page.getByTestId('messages')).toContainText('长对话滚动恢复第 12 条', {
    timeout: 10_000,
  });

  const metrics = await page.getByTestId('messages').evaluate((el) => ({
    bottomGap: el.scrollHeight - el.scrollTop - el.clientHeight,
  }));
  expect(metrics.bottomGap).toBeLessThanOrEqual(4);
  await expect(page.getByTestId('composer-input')).toBeInViewport();
  await expectPageHasNoHorizontalOverflow(page);
});

test('small viewport: invalid backup import reports a readable error without trapping the modal', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await seedChatModels(1);

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('open-settings').click();

  const modal = page.getByTestId('settings-overlay').locator('.settings-modal');
  await expect(modal).toBeVisible();
  await scrollToBottom(modal);
  await page.getByTestId('settings-import-file').setInputFiles({
    name: 'broken-backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{"not valid"'),
  });

  const msg = page.getByTestId('settings-danger-msg');
  await expect(msg).toContainText('导入失败', { timeout: 10_000 });
  await expect(msg).toBeInViewport();
  await expect(page.getByTestId('settings-close')).toBeInViewport();
  await expectPageHasNoHorizontalOverflow(page);
});
