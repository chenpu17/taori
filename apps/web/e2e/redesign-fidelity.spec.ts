import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { authedFetch, readSidecarEnv, resetSidecar, seedDefaultModel, type SidecarEnv } from './_helpers';

test.beforeEach(async () => {
  const env = readSidecarEnv();
  await resetSidecar(env);
  await seedDefaultModel(env);
});

async function seedConversation(env: SidecarEnv, text: string): Promise<string> {
  const modelsRes = await authedFetch(env, '/v1/models');
  if (!modelsRes.ok) throw new Error(`models seed lookup failed: ${modelsRes.status}`);
  const { models } = (await modelsRes.json()) as { models: Array<{ id: string }> };
  const modelId = models[0]?.id;
  if (!modelId) throw new Error('no seeded chat model');

  const chatRes = await authedFetch(env, '/v1/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model_id: modelId,
      messages: [{ role: 'user', content: text }],
    }),
  });
  if (!chatRes.ok) throw new Error(`conversation seed failed: ${chatRes.status}`);
  await chatRes.text();

  const listRes = await authedFetch(env, '/v1/conversations');
  if (!listRes.ok) throw new Error(`conversation list failed: ${listRes.status}`);
  const { conversations } = (await listRes.json()) as {
    conversations: Array<{ id: string; title: string | null }>;
  };
  const found = conversations.find((conversation) => conversation.title?.startsWith(text.slice(0, 18)));
  if (!found) throw new Error(`seeded conversation not found: ${text}`);
  return found.id;
}

test('redesigned empty chat shell matches Taori design structure', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 840 });
  await page.addInitScript(() => {
    for (const key of [
      'tip_image_first_seen',
      'tip_fallback_first_seen',
      'tip_cost_first_seen',
      'tip_roundtable_first_seen',
      'tip_quickcompare_first_seen',
      'tip_research_first_seen',
    ]) {
      window.localStorage.setItem(key, 'true');
    }
  });
  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('starter')).toBeVisible();

  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(244, 239, 228)');
  await expect(page.locator('.sidebar')).toHaveCSS('width', '260px');
  await expect(page.locator('.chat-header')).toHaveCSS('height', '61px');
  await expect(page.locator('.app > header')).toHaveCSS('position', 'absolute');
  await expect(page.locator('.app > header .brand')).toBeHidden();

  await expect(page.locator('.sidebar-footer')).toBeVisible();
  await expect(page.locator('.sidebar-footer').getByTestId('theme-toggle')).toBeVisible();

  await expect(page.getByTestId('starter')).toContainText('让我们把今天的问题');
  await expect(page.locator('.starter-chip__label')).toHaveText([
    'WEAVE',
    'WRITE',
    'CODE',
    'COMPARE',
  ]);

  await expect(page.getByTestId('composer-form')).toHaveCSS('width', '760px');
  await expect(page.getByTestId('composer-form')).toHaveCSS('border-radius', '12px');
  await expect(page.locator('.composer__bar')).toBeVisible();
  await expect(page.locator('.composer__hint')).toContainText('本地优先');
  await expect(page.getByTestId('active-model')).toBeVisible();
  await expect(page.getByTestId('composer-send')).toBeVisible();

  const composerBox = await page.getByTestId('composer-form').boundingBox();
  const starterBox = await page.getByTestId('starter').boundingBox();
  const composerBarBox = await page.locator('.composer__bar').boundingBox();
  expect(composerBox).not.toBeNull();
  expect(starterBox).not.toBeNull();
  expect(composerBarBox).not.toBeNull();
  expect(composerBox!.height).toBeLessThanOrEqual(126);
  expect(composerBarBox!.height).toBeLessThanOrEqual(44);
  expect(starterBox!.width).toBeGreaterThanOrEqual(610);
  expect(starterBox!.y).toBeGreaterThan(150);
  expect(starterBox!.y).toBeLessThan(250);

  await expect(page.locator('.composer-tool-btn').first()).toHaveCSS('border-color', 'rgba(0, 0, 0, 0)');
  await expect(page.getByTestId('composer-tools-toggle')).toHaveCSS('border-color', 'rgba(0, 0, 0, 0)');
  await expect(page.getByTestId('persona-select').locator('..')).toHaveCSS('border-color', 'rgba(26, 22, 18, 0.08)');
  await expect(page.getByTestId('composer-send')).toHaveCSS('background-color', 'rgb(235, 228, 212)');
  await expect(page.getByTestId('composer-send')).toHaveCSS('opacity', '1');

  const topButton = page.getByTestId('open-cost-dashboard');
  await expect(topButton).toHaveCSS('width', '32px');
  await expect(topButton).toHaveCSS('border-color', 'rgba(0, 0, 0, 0)');

  await expect(page.locator('.starter-chip').first()).toHaveCSS('border-radius', '10px');
  await expect(page.locator('.starter-chip').first()).toHaveCSS('border-color', 'rgba(0, 0, 0, 0)');

  const topbarActions = [
    page.getByTestId('ribbon-toggle'),
    page.getByTestId('open-cost-dashboard'),
    page.getByTestId('open-model-center'),
    page.getByTestId('open-help'),
    page.getByTestId('open-settings'),
  ];
  const boxes = await Promise.all(topbarActions.map((locator) => locator.boundingBox()));
  for (let i = 0; i < boxes.length - 1; i += 1) {
    expect(boxes[i]).not.toBeNull();
    expect(boxes[i + 1]).not.toBeNull();
    expect((boxes[i]!.x + boxes[i]!.width) < boxes[i + 1]!.x).toBeTruthy();
  }

  await page.screenshot({ path: testInfo.outputPath('redesign-empty.png'), fullPage: true });
  if (process.env.TAORI_VISUAL_OUT_DIR) {
    fs.mkdirSync(process.env.TAORI_VISUAL_OUT_DIR, { recursive: true });
    await page.screenshot({
      path: path.join(process.env.TAORI_VISUAL_OUT_DIR, 'live-current.png'),
      fullPage: true,
    });
  }
});

test('redesigned active chat, control center, and mobile shell stay coherent', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 840 });
  await page.addInitScript(() => {
    window.localStorage.setItem('taori.chat.ribbon.collapsed', 'true');
    for (const key of [
      'tip_image_first_seen',
      'tip_fallback_first_seen',
      'tip_cost_first_seen',
      'tip_roundtable_first_seen',
      'tip_quickcompare_first_seen',
      'tip_research_first_seen',
    ]) {
      window.localStorage.setItem(key, 'true');
    }
  });
  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 15_000 });

  await page.getByTestId('composer-input').fill('把这段 SQL 重构成窗口函数，并解释索引影响');
  await page.getByTestId('composer-send').click();
  await expect(page.locator('.msg.user')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.msg.assistant').filter({ hasText: 'M0 mock' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('composer-stop')).toBeHidden({ timeout: 15_000 });
  await expect(page.getByTestId('composer-send')).toBeVisible();
  await expect(page.locator('.conv-item.active')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.msg.user')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(page.locator('.msg.assistant').first()).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');

  const messageBoxes = await Promise.all([
    page.locator('.msg.user').first().boundingBox(),
    page.locator('.msg.assistant').first().boundingBox(),
    page.getByTestId('composer-form').boundingBox(),
  ]);
  for (const box of messageBoxes) {
    expect(box).not.toBeNull();
    expect(box!.width).toBeLessThanOrEqual(780);
    expect(box!.x).toBeGreaterThan(260);
  }

  await page.screenshot({ path: testInfo.outputPath('redesign-active-chat.png'), fullPage: true });

  await page.getByTestId('open-model-center').click();
  await expect(page.getByTestId('control-center')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('model-center')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('control-center')).toHaveCSS('background-color', 'rgb(244, 239, 228)');
  await expect(page.getByTestId('model-center-sync')).toHaveCSS('background-image', 'none');
  await expect(page.getByTestId('model-center-sync')).toHaveCSS('background-color', 'rgb(26, 22, 18)');
  await expect(page.getByTestId('model-center-add-provider')).toHaveCSS('background-image', 'none');
  await expect(page.getByTestId('model-center-add-provider')).toHaveCSS('background-color', 'rgb(26, 22, 18)');
  await page.screenshot({ path: testInfo.outputPath('redesign-control-center.png'), fullPage: true });
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('control-center')).toBeHidden();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId('chat-panel')).toBeVisible();
  await expect(page.getByTestId('composer-form')).toBeVisible();
  await expect(page.getByTestId('composer-form')).toHaveCSS('width', '366px');
  await expect(page.locator('.sidebar')).toHaveCSS('width', '390px');
  await expect(page.locator('.msg.assistant .msg-md')).toBeInViewport();
  await expect(page.locator('.msg.assistant .msg-md')).toContainText('M0 mock');
  await expect(page.locator('.messages .context-snapshot-card')).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('redesign-mobile.png'), fullPage: true });
});

test('redesigned populated sidebar keeps Taori list density and quiet controls', async ({ page }, testInfo) => {
  const env = readSidecarEnv();
  const pinnedId = await seedConversation(env, 'OpenClaw 行动派助手：系统提示词与执行边界');
  await authedFetch(env, `/v1/conversations/${pinnedId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pinned: true, tags: ['系统'] }),
  });
  await seedConversation(env, '把这段 SQL 重构成窗口函数并说明索引影响');
  await seedConversation(env, 'Taori 新版定价说明文案');
  await seedConversation(env, '三模型评估这个 ER 图');

  await page.setViewportSize({ width: 1280, height: 840 });
  await page.addInitScript(() => {
    for (const key of [
      'tip_image_first_seen',
      'tip_fallback_first_seen',
      'tip_cost_first_seen',
      'tip_roundtable_first_seen',
      'tip_quickcompare_first_seen',
      'tip_research_first_seen',
    ]) {
      window.localStorage.setItem(key, 'true');
    }
  });
  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 15_000 });

  const items = page.locator('[data-testid="conv-item"]');
  await expect(items).toHaveCount(4, { timeout: 10_000 });
  await expect(page.locator('.conv-group-head').first()).toContainText('置顶');
  await expect(items.first()).toHaveAttribute('data-conv-pinned', 'true');
  await expect(items.first().locator('.conv-title-text')).toContainText('OpenClaw');
  await expect(items.nth(1).locator('.conv-title-text')).toContainText('三模型评估');

  await expect(items.first().locator('.conv-meta-type')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(items.first().locator('.conv-meta-type')).toHaveCSS('border-top-width', '0px');
  await expect(items.first().locator('.conv-actions')).toHaveCSS('visibility', 'hidden');
  await expect(items.first()).toHaveCSS('border-radius', '6px');

  const firstTitleBox = await items.first().locator('.conv-title-text').boundingBox();
  const firstActionsBox = await items.first().locator('.conv-actions').boundingBox();
  expect(firstTitleBox).not.toBeNull();
  expect(firstActionsBox).not.toBeNull();
  expect(firstTitleBox!.width).toBeGreaterThan(170);

  await items.first().hover();
  await expect(items.first().locator('.conv-actions')).toHaveCSS('visibility', 'visible');
  const hoverActionsBox = await items.first().locator('.conv-actions').boundingBox();
  expect(hoverActionsBox).not.toBeNull();
  expect(hoverActionsBox!.x).toBeGreaterThan(firstTitleBox!.x + 150);

  await page.mouse.move(640, 620);
  await expect(items.first().locator('.conv-actions')).toHaveCSS('visibility', 'hidden');
  await page.screenshot({ path: testInfo.outputPath('redesign-sidebar-populated.png'), fullPage: true });
});
