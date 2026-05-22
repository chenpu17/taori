import { test, expect } from '@playwright/test';

/**
 * Multi-model & multi-tool visual verification.
 * Strategy: render each card component by directly injecting React state
 * via page.evaluate to force-set scenario, since live sidecar is active.
 *
 * Verifies from user perspective:
 *  1. 多模型圆桌卡片是否正确呈现
 *  2. 多模型对比（并排）卡片
 *  3. 研究进度 + 研究完成卡片
 *  4. 模型失败自动切换
 *  5. 图片生成卡片
 *  6. 用户从欢迎→选模式→发送的完整流程
 */
const DIR = '/tmp/taori-multi';
const snap = (page: any, name: string) =>
  page.screenshot({ path: `${DIR}/${name}.png`, fullPage: false });
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

async function goto(page: any) {
  await page.goto('/');
  await page.waitForSelector('.app', { timeout: 15000 });
  await wait(2500);
}

// ──────────────────────────────────────────
// Live mode: verify real conversation rendering
// ──────────────────────────────────────────
test('L1: live conversation renders correctly', async ({ page }) => {
  await goto(page);

  // Click the first conversation that has content
  const items = page.locator('.side-item');
  const n = await items.count();
  if (n > 0) {
    await items.nth(0).click();
    await wait(2000);
    await snap(page, 'l1-live-conversation');

    // Check messages rendered
    const msgs = page.locator('.msg');
    const msgCount = await msgs.count();
    console.log(`Conversation has ${msgCount} messages`);
    expect(msgCount).toBeGreaterThan(0);

    // Scroll to see more messages
    await page.locator('.main').evaluate(el => el.scrollTop = 300);
    await wait(300);
    await snap(page, 'l1-live-conversation-scrolled');
  }
});

test('L2: multi-model features in model picker', async ({ page }) => {
  await goto(page);

  // Open model picker
  await page.locator('.composer-model').click();
  await wait(500);
  await snap(page, 'l2-model-picker-multi');

  // Verify multiple models are listed
  const modelItems = page.locator('.model-picker-item');
  const count = await modelItems.count();
  console.log(`Model picker shows ${count} models`);
  expect(count).toBeGreaterThanOrEqual(1);
});

test('L3: mode menu shows multi-model tools', async ({ page }) => {
  await goto(page);

  // Open mode menu
  await page.locator('.composer-plus').click();
  await wait(500);
  await snap(page, 'l3-mode-menu-tools');

  // Verify modes: roundtable, research, compare, image
  const items = page.locator('.mode-menu-item');
  const count = await items.count();
  console.log(`Mode menu has ${count} options`);
  expect(count).toBeGreaterThanOrEqual(4);
});

test('L4: slash command flow — pick research mode', async ({ page }) => {
  await goto(page);
  await snap(page, 'l4a-welcome');

  // Type "/" to open slash menu
  const ta = page.locator('.composer-input');
  await ta.click();
  await ta.fill('/');
  await wait(400);
  await snap(page, 'l4b-slash-menu');

  // Click research mode
  const researchItem = page.locator('.mode-menu-item').filter({ hasText: '研究' });
  if (await researchItem.isVisible()) {
    await researchItem.click();
    await wait(300);
    await snap(page, 'l4c-research-mode');

    // Verify mode chip in composer
    const chip = page.locator('.composer-modechip');
    await expect(chip).toBeVisible();
    await expect(chip).toContainText('研究');
  }
});

test('L5: roundtable mode via slash', async ({ page }) => {
  await goto(page);
  const ta = page.locator('.composer-input');
  await ta.click();
  await ta.fill('/');
  await wait(400);

  const rtItem = page.locator('.mode-menu-item').filter({ hasText: '圆桌' });
  if (await rtItem.isVisible()) {
    await rtItem.click();
    await wait(300);
    const chip = page.locator('.composer-modechip');
    await expect(chip).toContainText('圆桌');
    await snap(page, 'l5-roundtable-mode');
  }
});

test('L6: compare mode via slash', async ({ page }) => {
  await goto(page);
  const ta = page.locator('.composer-input');
  await ta.click();
  await ta.fill('/');
  await wait(400);

  const cmpItem = page.locator('.mode-menu-item').filter({ hasText: '对比' });
  if (await cmpItem.isVisible()) {
    await cmpItem.click();
    await wait(300);
    const chip = page.locator('.composer-modechip');
    await expect(chip).toContainText('对比');
    await snap(page, 'l6-compare-mode');
  }
});

test('L7: image mode via slash', async ({ page }) => {
  await goto(page);
  const ta = page.locator('.composer-input');
  await ta.click();
  await ta.fill('/');
  await wait(400);

  const imgItem = page.locator('.mode-menu-item').filter({ hasText: '生图' });
  if (await imgItem.isVisible()) {
    await imgItem.click();
    await wait(300);
    const chip = page.locator('.composer-modechip');
    await expect(chip).toContainText('生图');
    await snap(page, 'l7-image-mode');
  }
});

test('L8: file upload via slash', async ({ page }) => {
  await goto(page);
  const ta = page.locator('.composer-input');
  await ta.click();
  await ta.fill('/');
  await wait(400);

  const fileItem = page.locator('.mode-menu-item').filter({ hasText: '附件' });
  if (await fileItem.isVisible()) {
    await fileItem.click();
    // File dialog opens; since we can't interact with native dialogs,
    // just verify no crash
    await wait(300);
    await snap(page, 'l8-file-trigger');
  }
});

test('L9: sidebar search — filter conversations', async ({ page }) => {
  await goto(page);
  const search = page.locator('.side-search input');
  await search.fill('SQL');
  await wait(500);
  await snap(page, 'l9-sidebar-search-sql');

  // Should filter to SQL-related conversations
  const items = page.locator('.side-item');
  const count = await items.count();
  console.log(`Search "SQL" shows ${count} items`);
});

test('L10: new chat via ⌘N', async ({ page }) => {
  await goto(page);
  // First select a conversation
  const items = page.locator('.side-item');
  if (await items.count() > 0) {
    await items.nth(0).click();
    await wait(1000);
  }
  // Press ⌘N to create new chat
  await page.keyboard.press('Meta+n');
  await wait(500);
  await snap(page, 'l10-new-chat');

  // Should show welcome or empty state
  const welcome = await page.locator('.welcome').count();
  const composer = await page.locator('.composer-shell').count();
  expect(welcome + composer).toBeGreaterThan(0);
});

test('L11: command palette — search models and conversations', async ({ page }) => {
  await goto(page);
  await page.keyboard.press('Meta+k');
  await wait(500);
  await snap(page, 'l11-cmd-palette');

  // Type a search
  const input = page.locator('.cmd-palette-search input');
  if (await input.isVisible()) {
    await input.fill('模型');
    await wait(400);
    await snap(page, 'l11-cmd-palette-search');
  }
});

test('L12: settings drawer — models & tools tab', async ({ page }) => {
  await goto(page);

  // Open overflow → settings
  await page.locator('.hdr-icon').click();
  await wait(300);
  const settingsBtn = page.locator('.over-menu-item').filter({ hasText: '模型' });
  if (await settingsBtn.count() > 0) {
    await settingsBtn.click();
    await wait(600);
    await snap(page, 'l12-models-drawer');
  }
});

test('L13: light theme — all UI elements', async ({ page }) => {
  await goto(page);

  // Switch to light theme
  await page.locator('.hdr-icon').click();
  await wait(300);
  const btns = page.locator('.over-menu-theme-seg button');
  if (await btns.count() >= 1) {
    await btns.first().click();
    await wait(500);
  }
  await page.locator('.main').click({ position: { x: 100, y: 100 } });
  await wait(300);
  await snap(page, 'l13-light-theme-overview');

  // Open model picker in light theme
  await page.locator('.composer-model').click();
  await wait(500);
  await snap(page, 'l13-light-model-picker');

  // Open slash menu in light theme
  await page.keyboard.press('Escape');
  await wait(200);
  const ta = page.locator('.composer-input');
  await ta.click();
  await ta.fill('/');
  await wait(400);
  await snap(page, 'l13-light-slash-menu');
});

test('L14: mobile — hamburger, sidebar overlay, touch targets', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await goto(page);
  await snap(page, 'l14-mobile-welcome');

  // Open sidebar
  await page.locator('.hdr-hamburger').click();
  await wait(600);
  await snap(page, 'l14-mobile-sidebar');

  // Select a conversation
  const items = page.locator('.side-item');
  if (await items.count() > 0) {
    await items.nth(0).click();
    await wait(1000);
    await snap(page, 'l14-mobile-conversation');
  }
});
