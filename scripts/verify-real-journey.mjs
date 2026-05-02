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
  };
}

async function screenshot(page, name) {
  const file = path.join(ARTIFACT_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
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

async function runJourney({ env, caps }) {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: process.env.HEADED !== '1' });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: 'zh-CN',
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
    events.steps.push({ name: 'open_app', ok: true });
    await screenshot(page, '01-open');

    const optionTexts = await page.getByTestId('active-model').locator('option').allTextContents();
    if (!optionTexts.some((t) => t.includes(' · '))) {
      fail('active model selector does not show provider labels', { optionTexts });
    }
    events.steps.push({ name: 'provider_labels_in_active_selector', ok: true, option_count: optionTexts.length });

    const imagePrompt = `${RUN_ID} 帮我生成一张可爱鸭鸭的图片，卡通风格，浅色背景`;
    log(`选择工具聊天模型：${modelLabel(caps.toolChat, caps.providerById)}`);
    await selectModel(page, caps.toolChat);
    await expectVisible(page.getByTestId('preflight-image'), 'image preflight');
    const imageState = await page.getByTestId('preflight-image').getAttribute('data-state');
    if (imageState !== 'ready') {
      fail('image preflight is not ready for the selected tool-capable chat model', { imageState });
    }

    log(`触发真实图像工具链：chat=${modelLabel(caps.toolChat, caps.providerById)} image=${modelLabel(caps.imageModel, caps.providerById)}`);
    await sendMessage(page, imagePrompt);
    await page.waitForTimeout(800);
    if (await page.getByTestId('image-picker-dialog').isVisible().catch(() => false)) {
      fail('natural-language image request opened the manual image picker; expected LLM tool call path');
    }
    await expectVisible(page.getByTestId('msg-tool-images'), 'generated image', 180_000);
    await screenshot(page, '02-image-generated');
    const conversationId = await findConversationContaining(env, imagePrompt);
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
    await screenshot(page, '03-vision-understanding');
    events.steps.push({ name: 'generated_image_to_vision_understanding', ok: true });

    const beforeWebFetch = await featureCounts(env, conversationId);
    log('验证 web_fetch 工具由聊天模型触发');
    await selectModel(page, caps.toolChat);
    await sendMessage(
      page,
      `${RUN_ID} 请使用 web_fetch 工具读取 https://example.com ，然后用中文总结页面标题和用途，并在回答中包含这个 URL。`,
    );
    await waitForAssistantTurn(page, 150_000);
    await screenshot(page, '04-web-fetch');
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
      `${RUN_ID} 请使用 web_search 工具搜索“Taori multi model desktop assistant”，给出 2 个结果标题和 URL。`,
    );
    await waitForAssistantTurn(page, 150_000);
    await screenshot(page, '05-web-search');
    const afterWebSearch = await featureCounts(env, conversationId);
    if ((afterWebSearch.tool_call ?? 0) <= (beforeWebSearch.tool_call ?? 0)) {
      fail('web_search prompt completed but no additional tool_call cost record was added', {
        before: beforeWebSearch,
        after: afterWebSearch,
      });
    }
    events.steps.push({ name: 'web_search_tool_from_chat', ok: true });

    log('验证连续对话中的停止按钮与不崩溃行为');
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
    await screenshot(page, '06-stop-or-complete');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expectVisible(page.getByTestId('chat-panel'), 'chat panel after reload', 20_000);
    await page.locator(`[data-testid="conv-item"][data-conv-id="${conversationId}"]`).click();
    const persistedImage = page.getByTestId('msg-tool-images').first();
    await expectVisible(persistedImage, 'generated image after reload', 30_000);
    await persistedImage.scrollIntoViewIfNeeded();
    await screenshot(page, '07-reload-persistence');
    events.steps.push({ name: 'reload_persistence', ok: true });

    if (events.page_errors.length > 0 || events.console_errors.length > 0) {
      fail('browser reported page or console errors during the real journey', {
        page_errors: events.page_errors,
        console_errors: events.console_errors,
      });
    }

    return events;
  } finally {
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
