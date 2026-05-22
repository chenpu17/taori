/**
 * Standalone visual journey test — runs against mock mode (no sidecar).
 * Usage: npx playwright test e2e/journey-visual.spec.ts
 * Requires: PLAYWRIGHT_BASE_URL=http://localhost:3456 (or standalone Vite)
 *           Run WITHOUT global-setup sidecar.
 */
import { test, expect } from '@playwright/test';

const DIR = '/tmp/taori-journey';
const snap = (page: any, name: string) =>
  page.screenshot({ path: `${DIR}/${name}.png`, fullPage: false });

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

// Go to mock app (no sidecar = mock scenarios)
async function goto(page: any) {
  await page.goto('/');
  await page.waitForSelector('.app', { timeout: 15000 });
  await wait(2000);
}

// Click sidebar item containing text
async function pickScenario(page: any, text: string) {
  const items = page.locator('.side-item');
  const n = await items.count();
  for (let i = 0; i < n; i++) {
    const t = await items.nth(i).textContent();
    if (t?.includes(text)) {
      await items.nth(i).click();
      await wait(1500);
      return true;
    }
  }
  return false;
}

test.describe('User Journey — Visual Verification (Mock Mode)', () => {

  // ── J1: 默认场景 — 欢迎 + 定价对话 ──
  test('J1: default welcome + pricing', async ({ page }) => {
    await goto(page);
    await snap(page, 'v01-welcome-pricing');
  });

  // ── J2: 滚动查看完整对话 ──
  test('J2: scroll through conversation', async ({ page }) => {
    await goto(page);
    await page.locator('.side-item').nth(2).click(); // third scenario
    await wait(1000);
    await snap(page, 'v02-scenario-loaded');

    const main = page.locator('.main');
    await main.evaluate(el => el.scrollTop = el.scrollHeight);
    await wait(500);
    await snap(page, 'v03-scrolled-bottom');
  });

  // ── J3: 无 Key 场景 ──
  test('J3: no-key scenario', async ({ page }) => {
    await goto(page);
    const found = await pickScenario(page, 'No Key');
    expect(found).toBeTruthy();
    await snap(page, 'v04-nokey');

    // Click a provider
    const prov = page.locator('.nokey-provider').first();
    if (await prov.isVisible()) {
      await prov.click();
      await wait(200);
      await snap(page, 'v05-nokey-provider-selected');
    }
  });

  // ── J4: 研究场景 ──
  test('J4: research scenario', async ({ page }) => {
    await goto(page);
    const found = await pickScenario(page, '研究');
    if (found) {
      await snap(page, 'v06-research');
    } else {
      // click all items until we find research card
      const items = page.locator('.side-item');
      const n = await items.count();
      for (let i = 0; i < n; i++) {
        await items.nth(i).click();
        await wait(800);
        const rp = await page.locator('.research-progress, .modecard').count();
        if (rp > 0) { await snap(page, 'v06-research'); return; }
      }
      await snap(page, 'v06-research-notfound');
    }
  });

  // ── J5: 圆桌场景 ──
  test('J5: roundtable scenario', async ({ page }) => {
    await goto(page);
    const found = await pickScenario(page, '圆桌');
    if (found) {
      await snap(page, 'v07-roundtable');
    } else {
      const items = page.locator('.side-item');
      const n = await items.count();
      for (let i = 0; i < n; i++) {
        await items.nth(i).click();
        await wait(800);
        const rt = await page.locator('.rt-row, .modecard').count();
        if (rt > 0) { await snap(page, 'v07-roundtable'); return; }
      }
      await snap(page, 'v07-roundtable-notfound');
    }
  });

  // ── J6: 侧边栏搜索 ──
  test('J6: sidebar search filter', async ({ page }) => {
    await goto(page);
    await snap(page, 'v08-sidebar-full');

    const input = page.locator('.side-search input');
    await input.fill('研究');
    await wait(500);
    await snap(page, 'v09-sidebar-search');
  });

  // ── J7: 模型选择器 ──
  test('J7: model picker', async ({ page }) => {
    await goto(page);
    await page.locator('.composer-model').click();
    await wait(500);
    await snap(page, 'v10-model-picker');
  });

  // ── J8: + 模式菜单 ──
  test('J8: mode menu', async ({ page }) => {
    await goto(page);
    await page.locator('.composer-plus').click();
    await wait(500);
    await snap(page, 'v11-mode-menu');
  });

  // ── J9: 斜杠命令 ──
  test('J9: slash commands', async ({ page }) => {
    await goto(page);
    await page.locator('.composer-input').click();
    await page.locator('.composer-input').fill('/');
    await wait(400);
    await snap(page, 'v12-slash-commands');
  });

  // ── J10: 溢出菜单 + 浅色主题 ──
  test('J10: overflow menu + light theme', async ({ page }) => {
    await goto(page);
    await page.locator('.hdr-icon').click();
    await wait(400);
    await snap(page, 'v13-overflow-menu');

    // Toggle to light theme
    const btns = page.locator('.over-menu-theme-seg button');
    if (await btns.count() >= 2) {
      await btns.nth(1).click(); // light
      await wait(500);
      // close menu
      await page.locator('.main').click({ position: { x: 100, y: 100 } });
      await wait(300);
      await snap(page, 'v14-light-theme');
    }
  });

  // ── J11: 命令面板 ──
  test('J11: command palette ⌘K', async ({ page }) => {
    await goto(page);
    await page.keyboard.press('Meta+k');
    await wait(500);
    await snap(page, 'v15-cmd-palette');
  });

  // ── J12: Footer 弹窗 ──
  test('J12: footer popups', async ({ page }) => {
    await goto(page);
    await page.locator('.foot-item').first().click();
    await wait(500);
    await snap(page, 'v16-footer-health');
  });

  // ── J13: 设置抽屉 ──
  test('J13: settings drawer', async ({ page }) => {
    await goto(page);
    await page.locator('.hdr-icon').click();
    await wait(300);
    const settingsBtn = page.locator('.over-menu-item').filter({ hasText: '设置' });
    if (await settingsBtn.count() > 0) {
      await settingsBtn.click();
      await wait(600);
      await snap(page, 'v17-settings-drawer');
    }
  });

  // ── J14: 文件附件 ──
  test('J14: file attachments', async ({ page }) => {
    await goto(page);
    // Use Playwright's file chooser to upload via the hidden input
    const fileInput = page.locator('.composer-shell input[type="file"]');
    await fileInput.setInputFiles([
      { name: 'test.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') },
      { name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('world') },
    ]);
    await wait(400);
    await snap(page, 'v18-file-attachments');
  });

  // ── J15: 移动端 ──
  test('J15: mobile responsive', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await goto(page);
    await snap(page, 'v19-mobile');

    await page.locator('.hdr-hamburger').click();
    await wait(600);
    await snap(page, 'v20-mobile-sidebar');
  });
});
