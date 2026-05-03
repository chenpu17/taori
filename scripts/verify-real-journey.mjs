#!/usr/bin/env node
/**
 * Real-provider user journey smoke.
 *
 * This is intentionally not a Playwright spec:
 * - it talks to the developer's running web + sidecar from apps/web/.env.local;
 * - it never clears or reseeds the local database;
 * - it drives the renderer UI and uses sidecar APIs only for capability checks
 *   and persistence verification.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const requireFromWeb = createRequire(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../apps/web/package.json'),
);
const { chromium } = requireFromWeb('@playwright/test');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB_ENV = path.join(ROOT, 'apps/web/.env.local');
const WEB_URL = process.env.TAORI_WEB_URL ?? 'http://127.0.0.1:5173/';
const RUN_ID = `real-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
const ARTIFACT_DIR =
  process.env.TAORI_REAL_JOURNEY_OUT ??
  path.join('/tmp', `taori-real-journey-${RUN_ID}`);

const EXPECTED_TOOLS = [
  'builtin.image_generate',
  'builtin.web_fetch',
  'builtin.web_search',
];

const POLICY_TOOLS = [
  'builtin.web_search',
  'builtin.web_fetch',
  'builtin.image_generate',
];

function log(message) {
  process.stdout.write(`${message}\n`);
}

function fail(message, details = {}) {
  const err = new Error(message);
  err.details = details;
  throw err;
}

function readEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    fail(`missing ${filePath}; run \`pnpm dev\` first so dev-browser writes the sidecar endpoint`);
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  const map = {};
  for (const line of raw.split('\n')) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) map[match[1]] = match[2].trim();
  }
  if (!map.VITE_SIDECAR_URL || !map.VITE_SIDECAR_BEARER) {
    fail(`missing VITE_SIDECAR_URL or VITE_SIDECAR_BEARER in ${filePath}`);
  }
  return {
    url: map.VITE_SIDECAR_URL.replace(/\/$/, ''),
    bearer: map.VITE_SIDECAR_BEARER,
  };
}

async function authedFetch(env, route, init = {}) {
  const res = await fetch(`${env.url}${route}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      authorization: `Bearer ${env.bearer}`,
    },
  });
  return res;
}

async function jsonFetch(env, route, init = {}) {
  const res = await authedFetch(env, route, init);
  let body = null;
  try {
    body = await res.json();
  } catch {
    // Leave body null; the status error below will carry enough context.
  }
  if (!res.ok) {
    fail(`sidecar ${route} failed with ${res.status}`, { route, status: res.status, body });
  }
  return body;
}

async function postJson(env, route, body) {
  return jsonFetch(env, route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function providerLabel(provider) {
  return provider?.name || provider?.type || '未知供应商';
}

function modelLabel(model, providerById) {
  return `${model.alias ?? model.display_name ?? model.model_name} · ${providerLabel(providerById.get(model.provider_id))}`;
}

function isEnabled(model) {
  return model.enabled && !(model.disabled_until && model.disabled_until > Date.now());
}

async function loadCapabilities(env) {
  const [{ providers }, { statuses }, { models }, toolsRes] = await Promise.all([
    jsonFetch(env, '/v1/providers'),
    jsonFetch(env, '/v1/providers/key-status').catch(() => ({ statuses: [] })),
    jsonFetch(env, '/v1/models'),
    jsonFetch(env, '/v1/tools'),
  ]);
  const providerById = new Map(providers.map((p) => [p.id, p]));
  const keyByProvider = new Map(statuses.map((s) => [s.provider_id, s.key_available]));
  const tools = toolsRes.data ?? [];
  const enabledTools = new Set(tools.filter((t) => t.enabled).map((t) => t.name));

  const runnableModels = models.filter(
    (m) => isEnabled(m) && keyByProvider.get(m.provider_id) !== false,
  );
  const chatTools = runnableModels.filter(
    (m) =>
      (m.capability === 'chat' || m.capability === 'multimodal') &&
      m.supports_tools,
  );
  const imageModels = runnableModels
    .filter((m) => m.capability === 'image')
    .sort(
      (a, b) =>
        (a.price_per_call ?? a.price_per_image ?? 0) -
          (b.price_per_call ?? b.price_per_image ?? 0) ||
        a.fallback_order - b.fallback_order,
    );
  const visionModels = runnableModels.filter(
    (m) =>
      (m.capability === 'chat' || m.capability === 'multimodal') &&
      m.supports_vision,
  );
  const synthesisChatModels = runnableModels.filter(
    (m) => m.capability === 'chat' || m.capability === 'multimodal',
  );

  const huaweiToolChat = chatTools.find((m) => providerById.get(m.provider_id)?.type === 'huawei_maas');
  const preferredToolChat =
    huaweiToolChat ??
    chatTools.find((m) => imageModels[0] && m.provider_id !== imageModels[0].provider_id) ??
    chatTools[0] ??
    null;

  const missing = [];
  if (providers.length === 0) missing.push('no providers configured');
  for (const tool of EXPECTED_TOOLS) {
    if (!enabledTools.has(tool)) missing.push(`${tool} is missing or disabled`);
  }
  if (!preferredToolChat) missing.push('no enabled key-backed chat/multimodal model with supports_tools=true');
  if (!imageModels[0]) missing.push('no enabled key-backed image model');
  if (!visionModels[0]) missing.push('no enabled key-backed vision-capable chat/multimodal model');

  if (missing.length > 0) {
    fail('real journey prerequisites are not satisfied', {
      missing,
      providers: providers.map((p) => ({
        id: p.id,
        name: p.name,
        type: p.type,
        key_available: keyByProvider.get(p.id) ?? false,
      })),
      models: models.map((m) => ({
        id: m.id,
        model_name: m.model_name,
        provider: providerLabel(providerById.get(m.provider_id)),
        capability: m.capability,
        enabled: m.enabled,
        supports_tools: m.supports_tools,
        supports_vision: m.supports_vision,
      })),
      tools,
    });
  }

  return {
    providers,
    providerById,
    models,
    tools,
    toolChat: preferredToolChat,
    imageModel: imageModels[0],
    visionModel: visionModels[0],
    synthesisChat:
      synthesisChatModels.find((m) => m.id !== preferredToolChat?.id && !m.supports_tools) ??
      synthesisChatModels.find((m) => m.id !== preferredToolChat?.id) ??
      preferredToolChat,
  };
}

async function screenshot(page, name) {
  const file = path.join(ARTIFACT_DIR, `${name}.png`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

async function dismissTips(page) {
  for (let i = 0; i < 5; i++) {
    const button = page.getByRole('button', { name: '知道了' }).first();
    if (!(await button.isVisible({ timeout: 500 }).catch(() => false))) return;
    const clicked = await button.click({ timeout: 1000 }).then(() => true).catch(() => false);
    if (!clicked) return;
    await page.waitForTimeout(100);
  }
}

async function expectVisible(locator, label, timeout = 30_000) {
  await locator.waitFor({ state: 'visible', timeout }).catch((e) => {
    fail(`UI element not visible: ${label}`, { label, error: e.message });
  });
}

async function expectHidden(locator, label, timeout = 10_000) {
  await locator.waitFor({ state: 'hidden', timeout }).catch((e) => {
    fail(`UI element not hidden: ${label}`, { label, error: e.message });
  });
}

async function expectTextContains(locator, label, expected, timeout = 10_000) {
  await expectVisible(locator, label, timeout);
  const deadline = Date.now() + timeout;
  let lastText = '';
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      let text = await locator.textContent({ timeout: 1000 });
      if (!text) text = await locator.inputValue({ timeout: 1000 }).catch(() => text);
      lastText = text ?? '';
      if (lastText.includes(expected)) return;
    } catch (e) {
      lastError = e;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (lastError) {
    fail(`UI text not readable: ${label}`, { label, error: lastError.message });
  }
  fail(`UI text mismatch: ${label}`, { expected, actual: lastText });
}

async function expectNoLayoutOverflow(page, label) {
  const problems = await page.evaluate(() => {
    const selectors = [
      '[data-testid="chat-panel"]',
      '[data-testid="session-profile-strip"]',
      '[data-testid="session-tool-policy"]',
      '[data-testid="messages"]',
      '[data-testid="composer-form"]',
      '[data-testid="context-snapshot-card"]',
      '[data-testid="tool-trace-timeline"]',
      '[data-testid="control-center"]',
      '[data-testid="run-timeline-panel"]',
    ];
    const viewportWidth = document.documentElement.clientWidth;
    const result = [];
    const bodyOverflow = document.documentElement.scrollWidth - viewportWidth;
    if (bodyOverflow > 3) {
      result.push({
        selector: 'document',
        issue: 'horizontal_overflow',
        overflow: bodyOverflow,
      });
    }
    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) {
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        const style = window.getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none') continue;
        if (rect.left < -3 || rect.right > viewportWidth + 3) {
          result.push({
            selector,
            issue: 'outside_viewport',
            left: rect.left,
            right: rect.right,
            viewportWidth,
          });
        }
        if (el.scrollWidth - el.clientWidth > 3 && style.overflowX === 'visible') {
          result.push({
            selector,
            issue: 'element_horizontal_overflow',
            overflow: el.scrollWidth - el.clientWidth,
          });
        }
      }
    }
    return result;
  });
  if (problems.length > 0) {
    fail(`layout overflow detected: ${label}`, { label, problems });
  }
}

async function selectModel(page, model) {
  const select = page.getByTestId('active-model');
  await select.selectOption(model.id);
  await page.waitForFunction(
    (id) => document.querySelector('[data-testid="active-model"]')?.value === id,
    model.id,
    { timeout: 5000 },
  );
}

async function sendMessage(page, text) {
  await page.getByTestId('composer-input').fill(text);
  await page.getByTestId('composer-send').click();
}

async function appendAndSendMessage(page, text) {
  const input = page.getByTestId('composer-input');
  const current = await input.inputValue();
  await input.fill(current.trim() ? `${current}\n\n${text}` : text);
  await page.getByTestId('composer-send').click();
}

async function currentConversationId(page) {
  const id = await page.getByTestId('chat-panel').getAttribute('data-active-conv');
  return id && id.trim() ? id : null;
}

async function waitForAssistantTurn(page, timeout = 60_000) {
  await page.locator('.msg.assistant').last().waitFor({ state: 'visible', timeout });
  await page.getByTestId('composer-stop').waitFor({ state: 'hidden', timeout }).catch(() => {
    // Some providers finish before the stop button ever renders; that is fine.
  });
  await page.getByTestId('composer-send').waitFor({ state: 'visible', timeout: 5000 });
}

async function findConversationContaining(env, text) {
  const { conversations } = await jsonFetch(env, '/v1/conversations');
  for (const conversation of conversations) {
    const { messages } = await jsonFetch(env, `/v1/conversations/${conversation.id}/messages`);
    if (messages.some((m) => (m.content ?? '').includes(text))) {
      return conversation.id;
    }
  }
  fail(`conversation containing "${text}" was not found`);
}

async function getConversationMessages(env, conversationId) {
  const body = await jsonFetch(env, `/v1/conversations/${conversationId}/messages`);
  return body.messages;
}

async function featureCounts(env, conversationId) {
  const body = await jsonFetch(
    env,
    `/v1/costs/breakdown?scope=session&conversation_id=${encodeURIComponent(conversationId)}&group_by=feature`,
  );
  const rows = body.data?.rows ?? [];
  return Object.fromEntries(rows.map((r) => [r.key ?? r.feature ?? r.label, r.count]));
}

async function createPromptAssetsFromUi(page, env) {
  const templateName = `${RUN_ID} 竞品调研模板`;
  const personaName = `${RUN_ID} 产品评审 Persona`;
  log('通过前端设置创建 Persona 与 Prompt 模板');
  await page.getByTestId('open-settings').click();
  await dismissTips(page);
  await expectVisible(page.getByTestId('control-center'), 'control center for prompt assets', 10_000);
  await page.getByTestId('settings-tab-prompts').click();
  await expectVisible(page.getByTestId('settings-prompt-templates'), 'prompt templates settings', 20_000);

  await page.getByTestId('template-name-input').fill(templateName);
  await page.getByTestId('template-description-input').fill('真实旅程验证用，可删除');
  await page.getByTestId('template-content-input').fill(
    [
      '请围绕 {{industry}} 场景评估 {{topic}}。',
      '必须先列出你需要确认的信息，再给出下一步行动建议。',
      '回答用中文，保持产品评审口吻。',
    ].join('\n'),
  );
  await page.getByTestId('template-save').click();
  await expectVisible(page.getByTestId('template-card').filter({ hasText: templateName }), `template card ${templateName}`, 15_000);

  await page.getByTestId('persona-name-input').fill(personaName);
  await page.getByTestId('persona-description-input').fill('真实旅程验证用，可删除');
  await page.getByTestId('persona-prompt-input').fill(
    '你是一位务实的 AI 产品负责人。你会优先关注用户旅程、显示正确性、风险、验证路径和可落地的下一步。',
  );
  await page.getByTestId('persona-save').click();
  await expectVisible(page.getByTestId('persona-card').filter({ hasText: personaName }), `persona card ${personaName}`, 15_000);
  await screenshot(page, '02-created-prompt-assets');
  await expectNoLayoutOverflow(page, 'prompt assets settings');

  const [{ prompt_templates: templates }, { personas }] = await Promise.all([
    jsonFetch(env, '/v1/prompt-templates'),
    jsonFetch(env, '/v1/personas'),
  ]);
  const template = templates.find((item) => item.name === templateName);
  const persona = personas.find((item) => item.name === personaName);
  if (!template || !persona) {
    fail('prompt assets created in UI but not readable from sidecar', {
      templateName,
      personaName,
      templateFound: Boolean(template),
      personaFound: Boolean(persona),
    });
  }

  await page.getByTestId('settings-close').click();
  await expectHidden(page.getByTestId('control-center'), 'control center after prompt assets close', 10_000);
  return { template, persona };
}

async function cleanupPromptAssets(env, assets) {
  for (const asset of [assets?.template, assets?.persona]) {
    if (!asset?.id) continue;
    const route = asset.prompt !== undefined
      ? `/v1/personas/${asset.id}`
      : `/v1/prompt-templates/${asset.id}`;
    await authedFetch(env, route, { method: 'DELETE' }).catch(() => null);
  }
}

async function cleanupTempModel(env, model) {
  if (!model?.id) return;
  await authedFetch(env, `/v1/models/${model.id}`, { method: 'DELETE' }).catch(() => null);
}

async function createTempManagedModel(env, caps) {
  const providerId = caps.toolChat.provider_id;
  if (!providerId) return null;
  return postJson(env, '/v1/models', {
    provider_id: providerId,
    model_name: `${RUN_ID}-managed-toggle-probe`,
    display_name: `${RUN_ID} 管理验证模型`,
    capability: 'chat',
    enabled: false,
    price_input_per_1m: 0,
    price_output_per_1m: 0,
    supports_tools: false,
    supports_vision: false,
  }).catch(() => null);
}

async function applyTemplateFromUi(page, assets) {
  await page.getByTestId('open-template-picker').click();
  await expectVisible(page.getByTestId('template-picker-overlay'), 'template picker', 10_000);
  await page.getByTestId('template-picker-item').filter({ hasText: assets.template.name }).click();
  await expectVisible(page.getByTestId('template-vars-overlay'), 'template variables dialog', 10_000);
  await page.getByTestId('template-var-input-industry').fill('多模型桌面助手');
  await page.getByTestId('template-var-input-topic').fill('连续研究、网页抓取、图像生成与结论沉淀');
  await expectVisible(page.getByTestId('template-var-preview'), 'template variable preview', 10_000);
  await page.getByTestId('template-vars-apply').click();
  await expectHidden(page.getByTestId('template-vars-overlay'), 'template variables dialog after apply', 10_000);
  await expectTextContains(page.getByTestId('composer-input'), 'composer after template', '多模型桌面助手', 10_000);
}

async function assertSessionProfile(page, expected) {
  await expectVisible(page.getByTestId('session-profile-strip'), 'session profile strip', 10_000);
  if (expected.modelText) {
    await expectTextContains(page.getByTestId('session-profile-model'), 'session profile model', expected.modelText);
  }
  if (expected.personaText) {
    await expectTextContains(page.getByTestId('session-profile-persona'), 'session profile persona', expected.personaText);
  }
  await expectVisible(page.getByTestId('session-profile-tools'), 'session profile tools', 10_000);
  await expectVisible(page.getByTestId('session-profile-cost'), 'session profile cost', 10_000);
  for (const tool of POLICY_TOOLS) {
    await expectVisible(page.getByTestId(`session-tool-policy-${tool}`), `session tool chip ${tool}`, 10_000);
  }
}

async function assertContextSnapshot(page, expectedText = null) {
  const card = page.getByTestId('context-snapshot-card').last();
  await expectVisible(card, 'context snapshot card', 30_000);
  await expectVisible(card.getByTestId('context-source-chip').first(), 'context source chip', 10_000);
  if (expectedText) {
    await expectTextContains(card, 'context snapshot expected source', expectedText, 10_000);
  }
}

async function assertRunTimeline(page, expectedTexts, screenshotName) {
  await page.getByTestId('open-run-timeline').click();
  const panel = page.getByTestId('run-timeline-panel');
  await expectVisible(panel, 'run timeline panel', 15_000);
  await expectVisible(panel.getByTestId('run-event').first(), 'first run timeline event', 15_000);
  for (const text of expectedTexts) {
    await expectVisible(panel.getByTestId('run-event').filter({ hasText: text }).first(), `run event ${text}`, 15_000);
  }
  await screenshot(page, screenshotName);
  await expectNoLayoutOverflow(page, screenshotName);
  await page.getByTestId('run-timeline-close').click();
  await expectHidden(panel, 'run timeline panel after close', 10_000);
}

async function assertCostDashboardTab(page, testId, label) {
  const tab = page.getByTestId(testId);
  await tab.click();
  await page.waitForFunction(
    (id) => document.querySelector(`[data-testid="${id}"]`)?.getAttribute('data-active') === '1',
    testId,
    { timeout: 10_000 },
  ).catch((e) => {
    fail(`cost dashboard tab did not become active: ${label}`, { label, testId, error: e.message });
  });
  await expectVisible(page.getByTestId('cost-dashboard-total'), `cost dashboard total after ${label}`, 10_000);
  await expectVisible(page.getByTestId('cost-call-log-row').first(), `cost call log after ${label}`, 20_000);
}

async function runJourney({ env, caps }) {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  let promptAssets = null;
  let tempManagedModel = null;
  const browser = await chromium.launch({ headless: process.env.HEADED !== '1' });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: 'zh-CN',
  });
  await context.addInitScript(() => {
    localStorage.setItem('tip_image_first_seen', 'true');
    localStorage.setItem('tip_fallback_first_seen', 'true');
    localStorage.setItem('tip_cost_first_seen', 'true');
    localStorage.setItem('tip_roundtable_first_seen', 'true');
  });
  const page = await context.newPage();
  const events = {
    run_id: RUN_ID,
    web_url: WEB_URL,
    artifact_dir: ARTIFACT_DIR,
    page_errors: [],
    console_errors: [],
    requests_failed: [],
    expected_aborts: [],
    steps: [],
  };

  page.on('pageerror', (err) => {
    events.page_errors.push(err.message);
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') events.console_errors.push(msg.text());
  });
  page.on('requestfailed', (req) => {
    const url = req.url();
    if (!url.includes('/v1/chat') && !url.includes('/v1/tools')) return;
    const failure = req.failure()?.errorText ?? 'unknown';
    if (failure === 'net::ERR_ABORTED') {
      events.expected_aborts.push({ url, failure });
      return;
    }
    events.requests_failed.push({ url, failure });
  });

  try {
    log(`打开前端：${WEB_URL}`);
    await page.goto(WEB_URL, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await expectVisible(page.getByTestId('chat-panel'), 'chat panel', 20_000);
    await dismissTips(page);
    events.steps.push({ name: 'open_app', ok: true });
    await screenshot(page, '01-open');

    const optionTexts = await page.getByTestId('active-model').locator('option').allTextContents();
    if (!optionTexts.some((t) => t.includes(' · '))) {
      fail('active model selector does not show provider labels', { optionTexts });
    }
    events.steps.push({ name: 'provider_labels_in_active_selector', ok: true, option_count: optionTexts.length });

    promptAssets = await createPromptAssetsFromUi(page, env);
    tempManagedModel = await createTempManagedModel(env, caps);
    events.steps.push({
      name: 'create_prompt_assets_from_ui',
      ok: true,
      template_id: promptAssets.template.id,
      persona_id: promptAssets.persona.id,
    });

    log(`选择工具聊天模型：${modelLabel(caps.toolChat, caps.providerById)}`);
    await selectModel(page, caps.toolChat);
    await page.waitForFunction(
      (id) => Array.from(document.querySelectorAll('[data-testid="persona-select"] option')).some((option) => option.value === id),
      promptAssets.persona.id,
      { timeout: 10_000 },
    );
    await page.getByTestId('persona-select').selectOption(promptAssets.persona.id);
    await assertSessionProfile(page, {
      modelText: caps.toolChat.alias ?? caps.toolChat.display_name ?? caps.toolChat.model_name,
      personaText: promptAssets.persona.name,
    });
    await applyTemplateFromUi(page, promptAssets);
    await expectVisible(page.getByTestId('preflight-image'), 'image preflight');
    const imageState = await page.getByTestId('preflight-image').getAttribute('data-state');
    if (imageState !== 'ready') {
      fail('image preflight is not ready for the selected tool-capable chat model', { imageState });
    }
    await screenshot(page, '03-persona-template-ready');
    await expectNoLayoutOverflow(page, 'persona template ready');

    log('发送 Persona + 模板生成的真实首轮调研消息');
    await appendAndSendMessage(page, `${RUN_ID}\n请先完成上面模板里的评估，回答末尾加一行“下一步验证”。`);
    await waitForAssistantTurn(page, 150_000);
    let conversationId = await currentConversationId(page);
    if (!conversationId) {
      conversationId = await findConversationContaining(env, RUN_ID);
    }
    await assertSessionProfile(page, {
      modelText: caps.toolChat.alias ?? caps.toolChat.display_name ?? caps.toolChat.model_name,
      personaText: promptAssets.persona.name,
    });
    await assertContextSnapshot(page, promptAssets.persona.name);
    await screenshot(page, '04-persona-template-answer');
    await expectNoLayoutOverflow(page, 'persona template answer');
    events.steps.push({
      name: 'persona_template_multiturn_start',
      ok: true,
      conversation_id: conversationId,
    });

    const imagePrompt = `${RUN_ID} 继续这个产品调研。请现在直接调用 image_generate 工具，不要追问补充信息。图片提示词：A light-background product roadmap poster for a multi-model desktop AI workspace assistant, cartoon but still product-workbench style, timeline lanes, model cards, web search, image generation, vision review, cost monitoring, clean Chinese SaaS interface mood.`;
    log(`触发真实图像工具链：chat=${modelLabel(caps.toolChat, caps.providerById)} image=${modelLabel(caps.imageModel, caps.providerById)}`);
    await sendMessage(page, imagePrompt);
    await page.waitForTimeout(800);
    if (await page.getByTestId('image-picker-dialog').isVisible().catch(() => false)) {
      fail('natural-language image request opened the manual image picker; expected LLM tool call path');
    }
    await expectVisible(page.getByTestId('msg-tool-images'), 'generated image', 180_000);
    await expectVisible(page.locator('[data-testid="tool-trace-step"][data-tool="builtin.image_generate"]').last(), 'image tool trace', 20_000);
    await assertContextSnapshot(page, promptAssets.persona.name);
    await assertRunTimeline(page, ['上下文快照', '模型调用完成', '生成图片', '成本记录'], '05b-run-timeline-image');
    await screenshot(page, '05-image-generated');
    await expectNoLayoutOverflow(page, 'image generated');
    const afterImageMessages = await getConversationMessages(env, conversationId);
    const assistantWithImage = afterImageMessages.find(
      (m) => m.role === 'assistant' && (m.image_attachments?.length ?? 0) > 0,
    );
    if (!assistantWithImage) {
      fail('generated image is visible but was not persisted as assistant image_attachments', { conversationId });
    }
    events.steps.push({
      name: 'image_generate_tool_from_chat',
      ok: true,
      conversation_id: conversationId,
      chat_model: modelLabel(caps.toolChat, caps.providerById),
      image_model: modelLabel(caps.imageModel, caps.providerById),
      cross_provider: caps.toolChat.provider_id !== caps.imageModel.provider_id,
    });

    log(`验证生成图回流到视觉理解：vision=${modelLabel(caps.visionModel, caps.providerById)}`);
    await page.getByTestId('tool-image-understand').first().click();
    await expectVisible(page.getByTestId('attachment-thumb'), 'vision attachment', 10_000);
    const activeAfterUnderstand = await page.getByTestId('active-model').inputValue();
    const expectedVisionModelId = caps.toolChat.supports_vision
      ? caps.toolChat.id
      : caps.visionModel.id;
    if (activeAfterUnderstand !== expectedVisionModelId) {
      fail('understand-image action did not switch to the expected vision-capable model', {
        expected: expectedVisionModelId,
        actual: activeAfterUnderstand,
      });
    }
    await sendMessage(page, `${RUN_ID} 请理解这张图，并说明主体是什么`);
    await waitForAssistantTurn(page, 120_000);
    await expectHidden(page.getByTestId('attachments-bar'), 'attachments bar', 15_000);
    await expectHidden(page.getByTestId('drop-error'), 'stale vision auto-switch notice after image turn', 10_000);
    await assertContextSnapshot(page, promptAssets.persona.name);
    await screenshot(page, '06-vision-understanding');
    await expectNoLayoutOverflow(page, 'vision understanding');
    events.steps.push({ name: 'generated_image_to_vision_understanding', ok: true });

    log('验证会话级工具策略：关闭 web_fetch 只影响当前会话且前端状态同步');
    await selectModel(page, caps.toolChat);
    await expectHidden(page.getByTestId('drop-error'), 'stale vision auto-switch notice after returning to tool chat model', 10_000);
    const webFetchChip = page.getByTestId('session-tool-policy-builtin.web_fetch');
    await expectTextContains(webFetchChip, 'web_fetch chip before disable', '抓网页 开', 10_000);
    await webFetchChip.click();
    await expectTextContains(webFetchChip, 'web_fetch chip disabled', '抓网页 关', 10_000);
    const effectiveAfterDisable = await jsonFetch(
      env,
      `/v1/tools/effective?conversation_id=${encodeURIComponent(conversationId)}`,
    );
    const webFetchEffective = effectiveAfterDisable.data?.find((t) => t.name === 'builtin.web_fetch');
    if (webFetchEffective?.effective_enabled !== false) {
      fail('web_fetch chip shows disabled but effective policy is not disabled', {
        webFetchEffective,
      });
    }
    const beforeDisabledFetch = await featureCounts(env, conversationId);
    await sendMessage(
      page,
      `${RUN_ID} 当前先不要切换设置。请尝试读取 https://example.com/，如果没有可用抓网页工具，请直接说明当前无法读取网页，不要编造页面内容。`,
    );
    await waitForAssistantTurn(page, 150_000);
    await assertContextSnapshot(page, promptAssets.persona.name);
    const afterDisabledFetch = await featureCounts(env, conversationId);
    if ((afterDisabledFetch.tool_call ?? 0) > (beforeDisabledFetch.tool_call ?? 0)) {
      fail('web_fetch disabled in session but a tool_call cost record was added', {
        before: beforeDisabledFetch,
        after: afterDisabledFetch,
      });
    }
    await screenshot(page, '07-web-fetch-disabled');
    await expectNoLayoutOverflow(page, 'web fetch disabled');
    await assertRunTimeline(page, ['上下文快照', '2 个工具可见'], '07b-run-timeline-web-fetch-disabled');
    events.steps.push({ name: 'session_tool_policy_disables_web_fetch', ok: true });

    const beforeWebFetch = await featureCounts(env, conversationId);
    log('恢复 web_fetch 后验证聊天模型真实调用抓网页工具');
    await webFetchChip.click();
    await expectTextContains(webFetchChip, 'web_fetch chip enabled', '抓网页 开', 10_000);
    await selectModel(page, caps.toolChat);
    await sendMessage(
      page,
      `${RUN_ID} 请务必使用 web_fetch 工具读取 https://example.com ，然后用中文总结页面标题和用途，并在回答中包含这个 URL。`,
    );
    await waitForAssistantTurn(page, 150_000);
    await expectVisible(page.locator('[data-testid="tool-trace-step"][data-tool="builtin.web_fetch"]').last(), 'web_fetch tool trace', 20_000);
    await assertContextSnapshot(page, promptAssets.persona.name);
    await screenshot(page, '08-web-fetch');
    await expectNoLayoutOverflow(page, 'web fetch enabled');
    await assertRunTimeline(page, ['上下文快照', '3 个工具可见', '抓取网页'], '08b-run-timeline-web-fetch-enabled');
    const afterWebFetch = await featureCounts(env, conversationId);
    if ((afterWebFetch.tool_call ?? 0) <= (beforeWebFetch.tool_call ?? 0)) {
      fail('web_fetch prompt completed but no tool_call cost record was added', {
        before: beforeWebFetch,
        after: afterWebFetch,
      });
    }
    events.steps.push({ name: 'web_fetch_tool_from_chat', ok: true });

    const beforeWebSearch = await featureCounts(env, conversationId);
    log('验证 web_search 工具由聊天模型触发');
    await sendMessage(
      page,
      `${RUN_ID} 请务必使用 web_search 工具搜索“Taori multi model desktop assistant”，给出 2 个结果标题和 URL。`,
    );
    await waitForAssistantTurn(page, 150_000);
    await expectVisible(page.locator('[data-testid="tool-trace-step"][data-tool="builtin.web_search"]').last(), 'web_search tool trace', 20_000);
    await assertContextSnapshot(page, promptAssets.persona.name);
    await screenshot(page, '09-web-search');
    await expectNoLayoutOverflow(page, 'web search');
    const afterWebSearch = await featureCounts(env, conversationId);
    if ((afterWebSearch.tool_call ?? 0) <= (beforeWebSearch.tool_call ?? 0)) {
      fail('web_search prompt completed but no additional tool_call cost record was added', {
        before: beforeWebSearch,
        after: afterWebSearch,
      });
    }
    events.steps.push({ name: 'web_search_tool_from_chat', ok: true });

    if (caps.synthesisChat?.id && caps.synthesisChat.id !== caps.toolChat.id) {
      log(`切换到第二个聊天模型做综合归纳：${modelLabel(caps.synthesisChat, caps.providerById)}`);
      await selectModel(page, caps.synthesisChat);
      await sendMessage(
        page,
        `${RUN_ID} 现在基于前面的搜索、抓网页和图片结果，压缩成 5 条面向产品团队的验证结论。不要再调用工具。`,
      );
      await waitForAssistantTurn(page, 120_000);
      await assertSessionProfile(page, {
        modelText: caps.synthesisChat.alias ?? caps.synthesisChat.display_name ?? caps.synthesisChat.model_name,
        personaText: promptAssets.persona.name,
      });
      await assertContextSnapshot(page, promptAssets.persona.name);
      await screenshot(page, '10-second-chat-model-synthesis');
      await expectNoLayoutOverflow(page, 'second chat model synthesis');
      events.steps.push({
        name: 'second_chat_model_synthesis',
        ok: true,
        model: modelLabel(caps.synthesisChat, caps.providerById),
      });
    }

    log('验证连续对话中的停止按钮与不崩溃行为');
    await selectModel(page, caps.toolChat);
    await sendMessage(
      page,
      `${RUN_ID} 请写一篇较长的多模型协作产品评估，分 10 点展开，每点不少于 80 字。`,
    );
    const stop = page.getByTestId('composer-stop');
    if (await stop.isVisible({ timeout: 10_000 }).catch(() => false)) {
      await stop.click();
      await expectHidden(stop, 'composer stop after click', 20_000);
      events.steps.push({ name: 'stop_streaming', ok: true, mode: 'clicked' });
    } else {
      events.steps.push({ name: 'stop_streaming', ok: true, mode: 'stream_too_fast_to_stop' });
    }
    await screenshot(page, '11-stop-or-complete');
    await expectNoLayoutOverflow(page, 'stop or complete');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expectVisible(page.getByTestId('chat-panel'), 'chat panel after reload', 20_000);
    await dismissTips(page);
    await page.locator(`[data-testid="conv-item"][data-conv-id="${conversationId}"]`).click();
    const persistedImage = page.getByTestId('msg-tool-images').first();
    await expectVisible(persistedImage, 'generated image after reload', 30_000);
    await persistedImage.scrollIntoViewIfNeeded();
    await assertSessionProfile(page, { personaText: promptAssets.persona.name });
    await assertRunTimeline(page, ['上下文快照', '成本记录'], '12b-run-timeline-after-reload');
    await screenshot(page, '12-reload-persistence');
    await expectNoLayoutOverflow(page, 'reload persistence');
    events.steps.push({ name: 'reload_persistence', ok: true });

    log('验证控制中心、设置、模型中心与调用监控页面显示');
    await page.getByTestId('open-model-center').click();
    await dismissTips(page);
    await expectVisible(page.getByTestId('control-center'), 'control center for models', 10_000);
    await expectVisible(page.getByTestId('model-center'), 'model center', 20_000);
    await expectVisible(page.getByTestId('model-center-providers'), 'model center providers', 20_000);
    if (tempManagedModel) {
      await page.getByTestId('model-center-tab-chat').click();
      await page.getByTestId('model-center-search').fill(RUN_ID);
      await page.getByTestId('model-center-status-filter').selectOption('disabled');
      await expectVisible(page.getByTestId(`model-row-${tempManagedModel.id}`), 'temporary disabled model row', 20_000);
      await page.getByTestId(`model-row-select-${tempManagedModel.id}`).check();
      await page.getByTestId('model-center-bulk-enable').click();
      await page.getByTestId('model-center-status-filter').selectOption('enabled');
      await expectVisible(page.getByTestId(`model-row-${tempManagedModel.id}`), 'temporary enabled model row', 20_000);
      await page.getByTestId(`provider-chip-library-${caps.toolChat.provider_id}`).click();
      await expectVisible(page.getByTestId('import-drawer'), 'provider model library drawer', 20_000);
      await page.getByTestId('import-drawer-refresh').click();
      await expectHidden(page.getByTestId('import-drawer-err'), 'provider library refresh error', 20_000);
      await expectVisible(page.getByTestId('import-drawer-list'), 'provider library model list', 30_000);
      await screenshot(page, '13b-model-library-refresh');
      await expectNoLayoutOverflow(page, 'model library refresh');
      await page.locator('[data-testid="import-drawer"] button[aria-label="关闭"]').click();
      await expectHidden(page.getByTestId('import-drawer'), 'provider model library drawer after close', 10_000);
      events.steps.push({
        name: 'model_management_library_refresh_and_bulk_toggle',
        ok: true,
        provider_id: caps.toolChat.provider_id,
      });
    }
    await screenshot(page, '13-model-center');
    await expectNoLayoutOverflow(page, 'model center');
    await page.getByTestId('settings-close').click();
    await expectHidden(page.getByTestId('control-center'), 'control center after model close', 10_000);

    await page.getByTestId('open-settings').click();
    await dismissTips(page);
    await expectVisible(page.getByTestId('control-center'), 'control center for settings', 10_000);
    await page.getByTestId('settings-tab-tools').click();
    await expectVisible(page.getByTestId('settings-tools'), 'tools settings', 20_000);
    for (const tool of EXPECTED_TOOLS) {
      await expectVisible(page.getByTestId(`tool-toggle-${tool}`), `tool toggle ${tool}`, 10_000);
    }
    await screenshot(page, '14-tools-settings');
    await expectNoLayoutOverflow(page, 'tools settings');

    await page.getByTestId('settings-tab-prompts').click();
    await expectVisible(page.getByTestId('settings-prompt-templates'), 'prompt templates settings', 20_000);
    await expectVisible(page.getByTestId('settings-personas'), 'personas settings', 20_000);
    await screenshot(page, '15-prompts-personas-settings');
    await expectNoLayoutOverflow(page, 'prompts personas settings');
    await page.getByTestId('settings-close').click();
    await expectHidden(page.getByTestId('control-center'), 'control center after settings close', 10_000);

    await page.getByTestId('open-cost-dashboard').click();
    await dismissTips(page);
    await expectVisible(page.getByTestId('control-center'), 'control center for costs', 10_000);
    await expectVisible(page.getByTestId('cost-dashboard-panel'), 'cost dashboard', 20_000);
    await expectVisible(page.getByTestId('cost-call-log-row').first(), 'cost call log row', 20_000);
    await assertCostDashboardTab(page, 'cost-dashboard-scope-week', 'week scope');
    await assertCostDashboardTab(page, 'cost-dashboard-scope-month', 'month scope');
    await assertCostDashboardTab(page, 'cost-dashboard-group-conversation', 'conversation group');
    await assertCostDashboardTab(page, 'cost-dashboard-group-feature', 'feature group');
    await screenshot(page, '16-cost-monitoring');
    await expectNoLayoutOverflow(page, 'cost monitoring');
    await page.getByTestId('settings-close').click();
    await expectHidden(page.getByTestId('control-center'), 'control center after costs close', 10_000);

    await page.keyboard.press('Control+K');
    await expectVisible(page.getByTestId('cmd-palette-input'), 'command palette input', 10_000);
    await page.getByTestId('cmd-palette-input').fill('成本');
    await page.getByTestId('cmd-result').filter({ hasText: '打开成本看板' }).first().click();
    await expectVisible(page.getByTestId('control-center'), 'control center via command palette', 10_000);
    await expectVisible(page.getByTestId('cost-dashboard-panel'), 'cost dashboard via command palette', 20_000);
    await screenshot(page, '17-command-palette-costs');
    await expectNoLayoutOverflow(page, 'command palette costs');
    await page.getByTestId('settings-close').click();
    await expectHidden(page.getByTestId('control-center'), 'control center after command palette costs close', 10_000);
    events.steps.push({ name: 'control_settings_monitoring_surfaces', ok: true });

    if (events.page_errors.length > 0 || events.console_errors.length > 0) {
      fail('browser reported page or console errors during the real journey', {
        page_errors: events.page_errors,
        console_errors: events.console_errors,
      });
    }

    return events;
  } finally {
    await cleanupPromptAssets(env, promptAssets);
    await cleanupTempModel(env, tempManagedModel);
    fs.writeFileSync(
      path.join(ARTIFACT_DIR, 'events.json'),
      JSON.stringify(events, null, 2),
      'utf8',
    );
    await browser.close();
  }
}

async function main() {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const env = readEnvFile(WEB_ENV);
  log(`检查 Sidecar：${env.url}`);
  await jsonFetch(env, '/health');
  log('读取真实 Provider / Model / Tool 配置');
  const caps = await loadCapabilities(env);
  log(`真实配置：chat=${modelLabel(caps.toolChat, caps.providerById)}`);
  log(`真实配置：image=${modelLabel(caps.imageModel, caps.providerById)}`);
  log(`真实配置：vision=${modelLabel(caps.visionModel, caps.providerById)}`);
  const events = await runJourney({ env, caps });
  log(`真实用户旅程验证通过：${events.artifact_dir}`);
}

main().catch((err) => {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const report = {
    run_id: RUN_ID,
    ok: false,
    message: err instanceof Error ? err.message : String(err),
    details: err?.details ?? null,
    artifact_dir: ARTIFACT_DIR,
  };
  fs.writeFileSync(
    path.join(ARTIFACT_DIR, 'failure.json'),
    JSON.stringify(report, null, 2),
    'utf8',
  );
  console.error(report.message);
  if (report.details) console.error(JSON.stringify(report.details, null, 2));
  console.error(`artifacts: ${ARTIFACT_DIR}`);
  process.exit(1);
});
