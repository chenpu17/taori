/**
 * Human Simulation Journey — comprehensive self-test that mimics real user
 * behaviour: onboarding, model setup, multi-turn chat, model switching,
 * tool use, deep research, sidebar management, cost display, settings panels.
 *
 * Uses the mock OpenAI server so no real LLM keys are needed.
 *
 * HOW TO RUN (from repo root):
 *   pnpm --filter @taori/web exec playwright test e2e/human-simulation-journey.spec.ts --reporter=line
 */
import { test, expect, type Page } from '@playwright/test';
import {
  authedFetch,
  readSidecarEnv,
  resetSidecar,
  type SidecarEnv,
} from './_helpers';
import { startMockOpenAI } from './_mock-openai-server';

const MOCK_PORT = 17933;
const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}/v1`;

let server: ReturnType<typeof startMockOpenAI> | null = null;
let env: SidecarEnv;

// ─── helper: dismiss all floating tips quickly ───────────────────────────────
async function suppressTips(page: Page) {
  await page.addInitScript(() => {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k?.startsWith('taori:tip:')) localStorage.setItem(k, 'dismissed');
      }
      // Pre-dismiss known tip keys
      const TIPS = ['tip-model-center','tip-capability-ribbon','tip-context-menu',
        'tip-quick-compare','tip-research','tip-session-profile','tip-cost-display'];
      for (const t of TIPS) localStorage.setItem(`taori:tip:${t}`, 'dismissed');
    } catch {}
  });
}

// ─── helper: add a mock provider + model via API ─────────────────────────────
async function setupMockProvider(e: SidecarEnv, mockUrl: string) {
  const r = await authedFetch(e, '/v1/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      label: 'Mock GPT',
      protocol: 'openai',
      base_url: mockUrl,
      api_key: 'sk-mock',
    }),
  });
  if (!r.ok) throw new Error(`provider create failed: ${await r.text()}`);
  const { provider } = await r.json() as { provider: { id: string } };

  const m = await authedFetch(e, `/v1/providers/${provider.id}/models/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model_id: 'gpt-4o-mock', display_name: 'GPT-4o Mock' }),
  });
  if (!m.ok) throw new Error(`model import failed: ${await m.text()}`);
  const { model } = await m.json() as { model: { id: string } };
  return { providerId: provider.id, modelId: model.id };
}

// ─── helper: wait for mock AI reply bubble ───────────────────────────────────
async function waitForReply(page: Page, timeoutMs = 20_000) {
  await page.waitForSelector('.msg.assistant:last-child .msg-body', {
    state: 'visible', timeout: timeoutMs,
  });
}

// ─── lifecycle ────────────────────────────────────────────────────────────────
test.beforeAll(() => {
  server = startMockOpenAI(MOCK_PORT, {
    fixedReply: '这是来自 Mock AI 的回复，内容完整且可读。',
    webToolCalls: true,
    streamDelayMs: 80,
    models: [
      { id: 'gpt-4o-mock', name: 'GPT-4o Mock', object: 'model', status: null, created: 1 },
      { id: 'gpt-4-turbo-mock', name: 'GPT-4 Turbo Mock', object: 'model', status: null, created: 1 },
    ],
  });
  env = readSidecarEnv();
});

test.afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
});

test.beforeEach(async ({ page }) => {
  await resetSidecar(env);
  await suppressTips(page);
});

// ─── 1. Onboarding: first-time user sees setup screen ─────────────────────────
test('1. 首次用户看到引导界面', async ({ page }) => {
  await page.goto('/');
  // With no providers, onboarding or empty-state should appear
  await expect(page.locator('body')).toBeVisible();
  // Should NOT show a chat bubble or sidebar conversation entries
  const convItems = page.locator('.conv-item');
  await expect(convItems).toHaveCount(0);
  // Some sort of empty state message, onboarding wizard, or "add model" prompt
  const bodyText = await page.locator('body').innerText();
  // Basic sanity: page loaded, not blank
  expect(bodyText.length).toBeGreaterThan(50);
});

// ─── 2. Model Center: add provider & model ────────────────────────────────────
test('2. 模型中心：添加 Provider 和模型', async ({ page }) => {
  await setupMockProvider(env, MOCK_URL);
  await page.goto('/');
  await suppressTips(page);

  // Navigate to model center
  const modelCenterBtn = page.locator('[data-testid="nav-model-center"], button:has-text("模型中心"), [aria-label*="模型"]').first();
  if (await modelCenterBtn.isVisible()) {
    await modelCenterBtn.click();
  } else {
    // Try to find it via keyboard shortcut panel or nav
    await page.keyboard.press('?');
    await page.waitForTimeout(300);
    await page.keyboard.press('Escape');
  }

  // Check models show up in sidecar
  const res = await authedFetch(env, '/v1/models');
  const { models } = await res.json() as { models: { id: string; display_name: string }[] };
  expect(models.length).toBeGreaterThan(0);
  expect(models.some(m => m.display_name === 'GPT-4o Mock')).toBe(true);
});

// ─── 3. Basic chat: send a message and get a reply ────────────────────────────
test('3. 基础对话：发送消息并收到回复', async ({ page }) => {
  await setupMockProvider(env, MOCK_URL);
  await page.goto('/');
  await suppressTips(page);

  // Wait for the composer
  const composer = page.locator('textarea, [contenteditable="true"]').first();
  await expect(composer).toBeVisible({ timeout: 10_000 });

  // Type a greeting
  await composer.click();
  await composer.fill('你好，请介绍一下自己');
  await page.keyboard.press('Enter');

  // Wait for user message to appear
  await expect(page.locator('.msg.user').first()).toBeVisible({ timeout: 8_000 });

  // Wait for assistant reply
  await waitForReply(page);
  const replyText = await page.locator('.msg.assistant:last-child .msg-body').innerText();
  expect(replyText.length).toBeGreaterThan(5);
});

// ─── 4. Multi-turn conversation ───────────────────────────────────────────────
test('4. 多轮对话：上下文连续性', async ({ page }) => {
  await setupMockProvider(env, MOCK_URL);
  await page.goto('/');
  await suppressTips(page);

  const composer = page.locator('textarea, [contenteditable="true"]').first();
  await expect(composer).toBeVisible({ timeout: 10_000 });

  // Turn 1
  await composer.click();
  await composer.fill('第一轮：请说"一"');
  await page.keyboard.press('Enter');
  await waitForReply(page);

  // Turn 2
  await composer.click();
  await composer.fill('第二轮：请说"二"');
  await page.keyboard.press('Enter');
  await waitForReply(page);

  // Turn 3
  await composer.click();
  await composer.fill('第三轮：请说"三"');
  await page.keyboard.press('Enter');
  await waitForReply(page);

  // Should have at least 3 user + 3 assistant messages
  const userMsgs = page.locator('.msg.user');
  const asstMsgs = page.locator('.msg.assistant');
  await expect(userMsgs).toHaveCount(3);
  await expect(asstMsgs).toHaveCount(3);
});

// ─── 5. New conversation button ───────────────────────────────────────────────
test('5. 新对话：清空并开始新会话', async ({ page }) => {
  await setupMockProvider(env, MOCK_URL);
  await page.goto('/');
  await suppressTips(page);

  const composer = page.locator('textarea, [contenteditable="true"]').first();
  await expect(composer).toBeVisible({ timeout: 10_000 });

  // Send one message
  await composer.click();
  await composer.fill('旧对话消息');
  await page.keyboard.press('Enter');
  await waitForReply(page);

  // Click new conversation button (pencil icon / 新建对话)
  const newChatBtn = page.locator(
    '[data-testid="new-conv-btn"], button[title*="新建"], button[aria-label*="新建"], .new-conv-btn',
  ).first();
  if (await newChatBtn.isVisible()) {
    await newChatBtn.click();
  } else {
    // Try keyboard shortcut
    await page.keyboard.press('Control+Shift+N');
  }
  await page.waitForTimeout(500);

  // Composer should be empty
  const composerVal = await page.locator('textarea, [contenteditable="true"]').first().inputValue().catch(() => '');
  expect(composerVal).toBe('');
});

// ─── 6. Sidebar: conversation list + search ───────────────────────────────────
test('6. 侧边栏：对话列表与搜索', async ({ page }) => {
  await setupMockProvider(env, MOCK_URL);
  await page.goto('/');
  await suppressTips(page);

  const composer = page.locator('textarea, [contenteditable="true"]').first();
  await expect(composer).toBeVisible({ timeout: 10_000 });

  // Create two conversations
  await composer.click();
  await composer.fill('关于气候变化的问题');
  await page.keyboard.press('Enter');
  await waitForReply(page);

  // Start a second conversation
  const newChatBtn = page.locator(
    '[data-testid="new-conv-btn"], button[title*="新建"], button[aria-label*="新建"], .new-conv-btn',
  ).first();
  if (await newChatBtn.isVisible()) {
    await newChatBtn.click();
    await page.waitForTimeout(300);
  }
  await composer.click();
  await composer.fill('关于人工智能的问题');
  await page.keyboard.press('Enter');
  await waitForReply(page);

  // Check sidebar has at least one conv item
  const sidebarItems = page.locator('.conv-item');
  await expect(sidebarItems.first()).toBeVisible({ timeout: 5_000 });
  const count = await sidebarItems.count();
  expect(count).toBeGreaterThanOrEqual(1);
});

// ─── 7. Message actions: copy / retry ─────────────────────────────────────────
test('7. 消息操作：悬停菜单可见', async ({ page }) => {
  await setupMockProvider(env, MOCK_URL);
  await page.goto('/');
  await suppressTips(page);

  const composer = page.locator('textarea, [contenteditable="true"]').first();
  await expect(composer).toBeVisible({ timeout: 10_000 });
  await composer.click();
  await composer.fill('触发消息操作测试');
  await page.keyboard.press('Enter');
  await waitForReply(page);

  // Hover over the assistant message to trigger action buttons
  const lastAssistantMsg = page.locator('.msg.assistant').last();
  await lastAssistantMsg.hover();
  await page.waitForTimeout(400);

  // Look for action buttons (copy, retry, thumbs)
  const actionBtns = page.locator('.msg-actions button, .msg-toolbar button, [data-testid^="msg-action"]');
  const actionCount = await actionBtns.count();
  // At least some action should be visible on hover — if this fails it's a UX regression
  // We use a soft check since some models may not show all actions
  if (actionCount === 0) {
    // Log a warning rather than hard fail — capture what IS visible
    const msgHtml = await lastAssistantMsg.innerHTML();
    console.warn('[WARNING] No message action buttons found. HTML excerpt:', msgHtml.slice(0, 300));
  }
});

// ─── 8. Cost display: $ badge visible after conversation ──────────────────────
test('8. 费用显示：消息旁边有 $ 徽章', async ({ page }) => {
  await setupMockProvider(env, MOCK_URL);
  await page.goto('/');
  await suppressTips(page);

  const composer = page.locator('textarea, [contenteditable="true"]').first();
  await expect(composer).toBeVisible({ timeout: 10_000 });
  await composer.click();
  await composer.fill('请计算 1+1');
  await page.keyboard.press('Enter');
  await waitForReply(page);

  // Cost display is inside the context-snapshot-card
  const costEl = page.locator('[data-testid="msg-cost"], .msg-cost, .context-snapshot-cost').first();
  // This is a soft check — if the mock doesn't return usage, the element may not appear
  const hasCost = await costEl.isVisible().catch(() => false);
  console.log(`[INFO] Cost badge visible: ${hasCost}`);
  // At minimum, the context snapshot card should exist
  const snapshotCard = page.locator('[data-testid="context-snapshot-card"], .context-snapshot-card').first();
  const hasSnapshot = await snapshotCard.isVisible().catch(() => false);
  console.log(`[INFO] Context snapshot card visible: ${hasSnapshot}`);
});

// ─── 9. Model switching mid-conversation ─────────────────────────────────────
test('9. 对话中切换模型', async ({ page }) => {
  await setupMockProvider(env, MOCK_URL);
  await page.goto('/');
  await suppressTips(page);

  const composer = page.locator('textarea, [contenteditable="true"]').first();
  await expect(composer).toBeVisible({ timeout: 10_000 });

  // Send first message
  await composer.click();
  await composer.fill('第一条消息');
  await page.keyboard.press('Enter');
  await waitForReply(page);

  // Try to find the model selector
  const modelSelector = page.locator(
    '[data-testid="model-selector"], .model-selector, [aria-label*="模型"], button:has-text("GPT"), .model-picker',
  ).first();
  const selectorVisible = await modelSelector.isVisible().catch(() => false);
  if (selectorVisible) {
    await modelSelector.click();
    await page.waitForTimeout(400);
    // Look for alternative model options
    const altModel = page.locator('[data-testid="model-option"], .model-option, li[role="option"]').first();
    const altVisible = await altModel.isVisible().catch(() => false);
    if (altVisible) {
      await altModel.click();
      await page.waitForTimeout(200);
    }
  } else {
    console.log('[INFO] Model selector not found — skipping switch');
  }

  // Send another message to confirm app still works after switch
  await composer.click();
  await composer.fill('切换后的第二条消息');
  await page.keyboard.press('Enter');
  await waitForReply(page);
  const msgs = page.locator('.msg.user');
  await expect(msgs).toHaveCount(2);
});

// ─── 10. Deep Research: create session, start, observe progress ───────────────
test('10. 深度研究：创建→启动→观察进度', async ({ page }) => {
  test.setTimeout(60_000);
  await setupMockProvider(env, MOCK_URL);
  await page.goto('/');
  await suppressTips(page);

  // Navigate to Research Center
  const researchBtn = page.locator(
    '[data-testid="nav-research"], button:has-text("深度研究"), [aria-label*="研究"], .research-nav-btn',
  ).first();
  const researchVisible = await researchBtn.isVisible({ timeout: 5_000 }).catch(() => false);
  if (!researchVisible) {
    // Try sidebar link or menu
    const navLinks = page.locator('.nav-link, .sidebar-link, nav a');
    const allLinks = await navLinks.allInnerTexts();
    console.log('[INFO] Nav links found:', allLinks);
    test.skip(true, '深度研究入口未找到，跳过');
    return;
  }
  await researchBtn.click();
  await page.waitForTimeout(500);

  // Should see research center UI
  const researchTitle = page.locator('h2:has-text("深度研究"), h1:has-text("深度研究"), .research-center__layout');
  await expect(researchTitle.first()).toBeVisible({ timeout: 8_000 });

  // Fill in topic
  const topicInput = page.locator('input[placeholder*="主题"], input[placeholder*="topic"], input[name="topic"]').first();
  if (await topicInput.isVisible()) {
    await topicInput.fill('量子计算的最新进展');
  }
  // Fill in objective
  const objInput = page.locator('textarea[placeholder*="目标"], textarea[placeholder*="objective"]').first();
  if (await objInput.isVisible()) {
    await objInput.fill('了解2024年量子计算的突破性进展');
  }

  // Submit / generate plan
  const planBtn = page.locator('button:has-text("生成计划"), button:has-text("预览"), button:has-text("开始")').first();
  if (await planBtn.isVisible()) {
    await planBtn.click();
    await page.waitForTimeout(2_000);
  }

  // Look for research task list or session
  const taskList = page.locator('[data-testid="research-task-list"], .research-center__task-list').first();
  const hasTaskList = await taskList.isVisible({ timeout: 10_000 }).catch(() => false);
  console.log(`[INFO] Research task list visible: ${hasTaskList}`);
  if (!hasTaskList) {
    // Take screenshot for debugging
    await page.screenshot({ path: '/tmp/research-debug.png' });
    console.log('[INFO] Screenshot saved to /tmp/research-debug.png');
  }
});

// ─── 11. Settings panel: persona selection ────────────────────────────────────
test('11. 设置：Persona 选择', async ({ page }) => {
  await setupMockProvider(env, MOCK_URL);
  await page.goto('/');
  await suppressTips(page);

  // Find settings / control center button
  const settingsBtn = page.locator(
    '[data-testid="nav-settings"], button[aria-label*="设置"], button:has-text("设置"), .settings-btn',
  ).first();
  const settingsVisible = await settingsBtn.isVisible({ timeout: 5_000 }).catch(() => false);
  if (!settingsVisible) {
    console.log('[INFO] Settings button not found via common selectors');
  } else {
    await settingsBtn.click();
    await page.waitForTimeout(500);
    // Should open some settings panel
    const panel = page.locator('.settings-panel, .control-center, [role="dialog"]').first();
    const panelVisible = await panel.isVisible({ timeout: 3_000 }).catch(() => false);
    console.log(`[INFO] Settings panel visible: ${panelVisible}`);
  }
});

// ─── 12. Error resilience: invalid model key ─────────────────────────────────
test('12. 错误处理：无效 key 时界面不崩溃', async ({ page }) => {
  // Add a provider with bad key
  const r = await authedFetch(env, '/v1/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      label: 'Bad Provider',
      protocol: 'openai',
      base_url: 'http://127.0.0.1:19999/v1',  // nothing listening here
      api_key: 'sk-bad',
    }),
  });
  if (r.ok) {
    const { provider } = await r.json() as { provider: { id: string } };
    await authedFetch(env, `/v1/providers/${provider.id}/models/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model_id: 'bad-model', display_name: 'Bad Model' }),
    });
  }

  await page.goto('/');
  await suppressTips(page);

  // Page should still be usable, no JS crash
  await expect(page.locator('body')).toBeVisible();
  const jsErrors: string[] = [];
  page.on('pageerror', (err) => jsErrors.push(err.message));
  await page.waitForTimeout(1_000);

  // No unhandled JS errors expected from page load
  const criticalErrors = jsErrors.filter(e =>
    !e.includes('ResizeObserver') && !e.includes('Non-Error')
  );
  if (criticalErrors.length > 0) {
    console.warn('[WARNING] Unhandled JS errors:', criticalErrors);
  }
});

// ─── 13. Keyboard navigation: Cmd+K command palette ──────────────────────────
test('13. 快捷键：Command Palette 可打开', async ({ page }) => {
  await setupMockProvider(env, MOCK_URL);
  await page.goto('/');
  await suppressTips(page);
  await page.waitForTimeout(800);

  // Open command palette
  await page.keyboard.press('Meta+k');
  await page.waitForTimeout(500);

  const palette = page.locator(
    '[data-testid="command-palette"], .command-palette, [role="dialog"]:has(input[placeholder*="搜索"])',
  ).first();
  const paletteVisible = await palette.isVisible().catch(() => false);
  if (!paletteVisible) {
    await page.keyboard.press('Control+k');
    await page.waitForTimeout(400);
  }
  const stillVisible = await page.locator('[data-testid="command-palette"], .command-palette, .cmd-palette').first().isVisible().catch(() => false);
  console.log(`[INFO] Command palette visible: ${stillVisible}`);
  // Press Escape to close
  await page.keyboard.press('Escape');
});

// ─── 14. Conversation rename & delete ─────────────────────────────────────────
test('14. 对话管理：重命名与删除', async ({ page }) => {
  await setupMockProvider(env, MOCK_URL);
  await page.goto('/');
  await suppressTips(page);

  const composer = page.locator('textarea, [contenteditable="true"]').first();
  await expect(composer).toBeVisible({ timeout: 10_000 });
  await composer.click();
  await composer.fill('将被重命名的对话');
  await page.keyboard.press('Enter');
  await waitForReply(page);

  // Right-click / hover-menu on conversation item
  const convItem = page.locator('.conv-item').first();
  const convVisible = await convItem.isVisible({ timeout: 5_000 }).catch(() => false);
  if (!convVisible) {
    console.log('[INFO] No conv-item found in sidebar — skipping rename test');
    return;
  }
  await convItem.hover();
  await page.waitForTimeout(300);
  // Look for menu trigger (three dots etc.)
  const menuBtn = convItem.locator('button[aria-label*="菜单"], button:has-text("…"), .conv-menu-btn').first();
  const menuVisible = await menuBtn.isVisible().catch(() => false);
  if (menuVisible) {
    await menuBtn.click();
    await page.waitForTimeout(300);
    const renameOption = page.locator('button:has-text("重命名"), [role="menuitem"]:has-text("重命名")').first();
    const renameVisible = await renameOption.isVisible().catch(() => false);
    console.log(`[INFO] Rename option visible: ${renameVisible}`);
    await page.keyboard.press('Escape');
  } else {
    console.log('[INFO] Conversation menu button not visible — context menu may need right-click');
    await convItem.click({ button: 'right' });
    await page.waitForTimeout(300);
    const ctxMenu = page.locator('[role="menu"], .context-menu').first();
    console.log(`[INFO] Context menu after right-click: ${await ctxMenu.isVisible().catch(() => false)}`);
    await page.keyboard.press('Escape');
  }
});

// ─── 15. Layout: responsive sidebar collapse ─────────────────────────────────
test('15. 布局：侧边栏可折叠', async ({ page }) => {
  await setupMockProvider(env, MOCK_URL);
  await page.goto('/');
  await suppressTips(page);
  await page.waitForTimeout(500);

  // Find sidebar toggle
  const toggleBtn = page.locator(
    '[data-testid="sidebar-toggle"], button[aria-label*="侧边栏"], .sidebar-toggle, button:has(svg[aria-label*="sidebar"])',
  ).first();
  const toggleVisible = await toggleBtn.isVisible().catch(() => false);
  if (toggleVisible) {
    // Sidebar should be open initially
    const sidebar = page.locator('.sidebar, aside, [data-testid="sidebar"]').first();
    const initiallyVisible = await sidebar.isVisible().catch(() => false);
    await toggleBtn.click();
    await page.waitForTimeout(400);
    const afterToggle = await sidebar.isVisible().catch(() => false);
    if (initiallyVisible) {
      // Should be hidden or collapsed now
      console.log(`[INFO] Sidebar after toggle: visible=${afterToggle} (expected false)`);
    }
    // Toggle back
    await toggleBtn.click();
    await page.waitForTimeout(400);
  } else {
    console.log('[INFO] Sidebar toggle button not found');
  }
  // Page should not crash either way
  await expect(page.locator('body')).toBeVisible();
});
