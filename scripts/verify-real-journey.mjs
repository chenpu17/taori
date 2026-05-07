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
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const requireFromWeb = createRequire(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../apps/web/package.json'),
);
const { chromium } = requireFromWeb('@playwright/test');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB_ENV = path.join(ROOT, 'apps/web/.env.local');
const WEB_URL = process.env.TAORI_WEB_URL ?? 'http://127.0.0.1:5173/';
const REPORT_ONLY = process.argv.includes('--report');
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

function artifactPath(name) {
  return path.join(ARTIFACT_DIR, name);
}

function writeJsonArtifact(name, data) {
  const file = artifactPath(name);
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  return file;
}

function readJsonArtifactFromDir(dir, name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
  } catch {
    return null;
  }
}

function findLatestArtifactDir() {
  const roots = Array.from(new Set(['/tmp', os.tmpdir()]));
  return roots
    .flatMap((root) => {
      let entries = [];
      try {
        entries = fs.readdirSync(root, { withFileTypes: true });
      } catch {
        return [];
      }
      return entries
        .filter((entry) => entry.isDirectory() && entry.name.startsWith('taori-real-journey-'))
        .map((entry) => {
          const dir = path.join(root, entry.name);
          try {
            return { dir, mtimeMs: fs.statSync(dir).mtimeMs };
          } catch {
            return null;
          }
        });
    })
    .filter((entry) => entry && fs.existsSync(path.join(entry.dir, 'events.json')))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.dir ?? null;
}

function summarizeArtifact(dir) {
  const events = readJsonArtifactFromDir(dir, 'events.json') ?? {};
  const capability = readJsonArtifactFromDir(dir, 'capability-summary.json') ?? {};
  const runs = readJsonArtifactFromDir(dir, 'runs.json');
  const runEvents = readJsonArtifactFromDir(dir, 'run-events.json');
  const costCalls = readJsonArtifactFromDir(dir, 'cost-calls.json');
  const steps = Array.isArray(events.steps) ? events.steps : [];
  const risks = Array.isArray(events.structured_risks) ? events.structured_risks : [];
  const required = [
    'image_generate_tool_from_chat',
    'generated_image_to_vision_understanding',
    'web_fetch_tool_from_chat',
    'web_search_tool_from_chat',
    'mcp_tool_from_ordinary_chat',
    'real_context_window_and_compact_context_recover',
    'real_skip_tool_recovery',
    'real_roundtable_timeline',
    'backup_import_then_real_chat',
    'cost_dashboard_source_backlink_visible',
  ];
  const stepMap = new Map(steps.map((step) => [step.name, step]));
  const runRows = Array.isArray(runs?.data?.runs) ? runs.data.runs : Array.isArray(runs) ? runs : [];
  const eventRows = Array.isArray(runEvents?.data?.events)
    ? runEvents.data.events
    : Array.isArray(runEvents)
      ? runEvents
      : [];
  const costRows = Array.isArray(costCalls?.data?.rows)
    ? costCalls.data.rows
    : Array.isArray(costCalls)
      ? costCalls
      : [];
  const report = {
    ok: risks.length === 0 && required.every((name) => stepMap.get(name)?.ok === true),
    artifact_dir: dir,
    run_id: events.run_id ?? path.basename(dir).replace(/^taori-real-journey-/, ''),
    collected_at: capability.collected_at ?? null,
    summary: {
      passed_steps: steps.filter((step) => step.ok === true).length,
      failed_steps: steps.filter((step) => step.ok === false).length,
      risk_count: risks.length,
      run_count: events.agent_runtime?.run_count ?? runRows.length,
      run_event_count: events.agent_runtime?.run_event_count ?? eventRows.length,
      cost_call_count: events.agent_runtime?.cost_call_count ?? costRows.length,
      latest_run_status: events.agent_runtime?.latest_run_status ?? runRows[0]?.status ?? null,
    },
    selected: capability.selected ?? {},
    required_steps: required.map((name) => ({
      name,
      ok: stepMap.get(name)?.ok === true,
    })),
    risks: risks.map((risk) => ({
      code: typeof risk.code === 'string' ? risk.code : 'unknown',
      message: typeof risk.message === 'string' ? risk.message : JSON.stringify(risk),
    })),
    final_screenshot: events.final_screenshot ?? null,
  };
  report.output_file = path.join(dir, 'real-provider-report.json');
  return report;
}

function writeArtifactReport() {
  const dir = process.env.TAORI_REAL_JOURNEY_REPORT_DIR ?? findLatestArtifactDir();
  if (!dir) {
    fail('no verify:real artifact found; run pnpm verify:real or set TAORI_REAL_JOURNEY_REPORT_DIR');
  }
  const report = summarizeArtifact(dir);
  fs.writeFileSync(report.output_file, JSON.stringify(report, null, 2), 'utf8');
  log(JSON.stringify(report, null, 2));
  if (!report.ok) {
    fail('real provider artifact contains risks or missing required steps', {
      artifact_dir: dir,
      output_file: report.output_file,
      risks: report.risks,
      required_steps: report.required_steps,
    });
  }
}

function safeIdPart(value) {
  return String(value).replace(/[^A-Za-z0-9_]/g, '_');
}

function isExpectedConsoleError(text) {
  return (
    text.includes('[useChat] onError:')
    && text.includes('provider_error/rate_limit: forced rate_limit')
  ) || text.includes('Failed to load resource: the server responded with a status of 409 (Conflict)');
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

async function putMemoryValue(env, scope, key, value, scopeId = null) {
  return jsonFetch(env, '/v1/memories', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      scope,
      scope_id: scopeId,
      key,
      value,
    }),
  });
}

async function getMemoryValue(env, scope, key, scopeId = null) {
  const qs = new URLSearchParams({ scope, key });
  if (scopeId) qs.set('scope_id', scopeId);
  const body = await jsonFetch(env, `/v1/memories?${qs.toString()}`);
  return body.data?.value ?? null;
}

async function snapshotMemory(env, scope, key, scopeId = null) {
  return {
    scope,
    scopeId,
    key,
    value: await getMemoryValue(env, scope, key, scopeId).catch(() => null),
  };
}

async function restoreMemory(env, snapshot) {
  if (!snapshot) return;
  if (snapshot.value == null) {
    const qs = new URLSearchParams({ scope: snapshot.scope, key: snapshot.key });
    if (snapshot.scopeId) qs.set('scope_id', snapshot.scopeId);
    await authedFetch(env, `/v1/memories?${qs.toString()}`, { method: 'DELETE' }).catch(() => null);
    return;
  }
  await putMemoryValue(env, snapshot.scope, snapshot.key, snapshot.value, snapshot.scopeId).catch(() => null);
}

async function patchModel(env, modelId, patch) {
  return jsonFetch(env, `/v1/models/${encodeURIComponent(modelId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
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
    jsonFetch(env, '/v1/providers/key-status?confirm_keychain=1').catch(() => ({ statuses: [] })),
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
        imageSortPrice(a) - imageSortPrice(b) ||
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

  const preferredToolChat =
    chatTools
      .toSorted(
        (a, b) =>
          (a.failure_count_24h ?? 0) - (b.failure_count_24h ?? 0) ||
          providerToolChatPriority(providerById.get(a.provider_id)?.type) -
            providerToolChatPriority(providerById.get(b.provider_id)?.type) ||
          modelToolChatPriority(a) - modelToolChatPriority(b) ||
          a.fallback_order - b.fallback_order,
      )[0] ??
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

function imageSortPrice(model) {
  return model.price_per_call ?? model.price_per_image ?? Number.POSITIVE_INFINITY;
}

function providerToolChatPriority(type) {
  if (type === 'huawei_maas') return 0;
  if (type === 'volcengine_ark') return 1;
  if (type === 'openai' || type === 'packyapi') return 2;
  if (type === 'siliconflow') return 3;
  if (type === 'openrouter') return 4;
  return 10;
}

function modelToolChatPriority(model) {
  const name = `${model.model_name ?? ''} ${model.display_name ?? ''}`.toLowerCase();
  if (name.includes('deepseek-v3')) return 0;
  if (name.includes('pro')) return 1;
  if (name.includes('lite')) return 2;
  if (name.includes('character')) return 9;
  return 5;
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
      '[data-testid="settings-mcp"]',
      '[data-testid="model-center"]',
      '[data-testid="model-editor"]',
      '[data-testid="roundtable-panel"]',
      '[data-testid^="roundtable-tool-traces-"]',
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

async function collectAgentRuntimeArtifacts(env, conversationId, events) {
  const [runsBody, runEventsBody, costCallsBody] = await Promise.all([
    jsonFetch(env, `/v1/conversations/${conversationId}/runs?limit=50`),
    jsonFetch(env, `/v1/conversations/${conversationId}/run-events?limit=300`),
    jsonFetch(env, '/v1/costs/calls?limit=200'),
  ]);
  const runs = runsBody.data?.runs ?? [];
  const runEvents = runEventsBody.data?.events ?? [];
  const costCalls = costCallsBody.data?.rows ?? [];
  fs.writeFileSync(
    path.join(ARTIFACT_DIR, 'runs.json'),
    JSON.stringify(runsBody, null, 2),
    'utf8',
  );
  fs.writeFileSync(
    path.join(ARTIFACT_DIR, 'run-events.json'),
    JSON.stringify(runEventsBody, null, 2),
    'utf8',
  );
  fs.writeFileSync(
    path.join(ARTIFACT_DIR, 'cost-calls.json'),
    JSON.stringify(costCallsBody, null, 2),
    'utf8',
  );
  if (runs.length === 0) {
    fail('agent runtime runs were not persisted for the real journey conversation', {
      conversation_id: conversationId,
    });
  }
  if (!runEvents.some((event) => event.kind === 'context.snapshot')) {
    fail('run events did not include a context snapshot', { conversation_id: conversationId });
  }
  if (!runEvents.some((event) => event.kind === 'cost.recorded')) {
    fail('run events did not include cost recording', { conversation_id: conversationId });
  }
  events.agent_runtime = {
    conversation_id: conversationId,
    run_count: runs.length,
    latest_run_status: runs[0]?.status ?? null,
    run_event_count: runEvents.length,
    cost_call_count: costCalls.length,
    artifacts: {
      runs: path.join(ARTIFACT_DIR, 'runs.json'),
      run_events: path.join(ARTIFACT_DIR, 'run-events.json'),
      cost_calls: path.join(ARTIFACT_DIR, 'cost-calls.json'),
    },
  };
}

async function collectConversationDiagnostics(env, conversationId, name, extra = {}) {
  const safeName = safeIdPart(name);
  const [conversationBody, messagesBody, runsBody, runEventsBody, costCallsBody, effectiveToolsBody] =
    await Promise.all([
      jsonFetch(env, '/v1/conversations').catch((e) => ({ error: e.message })),
      jsonFetch(env, `/v1/conversations/${encodeURIComponent(conversationId)}/messages`).catch((e) => ({ error: e.message })),
      jsonFetch(env, `/v1/conversations/${encodeURIComponent(conversationId)}/runs?limit=50`).catch((e) => ({ error: e.message })),
      jsonFetch(env, `/v1/conversations/${encodeURIComponent(conversationId)}/run-events?limit=500`).catch((e) => ({ error: e.message })),
      jsonFetch(env, '/v1/costs/calls?limit=200').catch((e) => ({ error: e.message })),
      jsonFetch(env, `/v1/tools/effective?conversation_id=${encodeURIComponent(conversationId)}`).catch((e) => ({ error: e.message })),
    ]);
  return writeJsonArtifact(`${safeName}-diagnostics.json`, {
    name,
    conversation_id: conversationId,
    collected_at: new Date().toISOString(),
    ...extra,
    conversations: conversationBody,
    messages: messagesBody,
    runs: runsBody,
    run_events: runEventsBody,
    cost_calls: costCallsBody,
    effective_tools: effectiveToolsBody,
  });
}

async function collectCapabilitySummary(env, caps) {
  const [providersBody, modelsBody, toolsBody, toolHealthBody, modelHealthBody, mcpBody] =
    await Promise.all([
      jsonFetch(env, '/v1/providers').catch((e) => ({ error: e.message })),
      jsonFetch(env, '/v1/models').catch((e) => ({ error: e.message })),
      jsonFetch(env, '/v1/tools').catch((e) => ({ error: e.message })),
      jsonFetch(env, '/v1/tools/health').catch((e) => ({ error: e.message })),
      jsonFetch(env, '/v1/models/health').catch((e) => ({ error: e.message })),
      jsonFetch(env, '/v1/mcp/servers').catch((e) => ({ error: e.message })),
    ]);
  return writeJsonArtifact('capability-summary.json', {
    collected_at: new Date().toISOString(),
    selected: {
      tool_chat: caps.toolChat
        ? {
            id: caps.toolChat.id,
            label: modelLabel(caps.toolChat, caps.providerById),
            supports_tools: caps.toolChat.supports_tools,
            supports_vision: caps.toolChat.supports_vision,
            capability: caps.toolChat.capability,
          }
        : null,
      image: caps.imageModel
        ? {
            id: caps.imageModel.id,
            label: modelLabel(caps.imageModel, caps.providerById),
            capability: caps.imageModel.capability,
          }
        : null,
      vision: caps.visionModel
        ? {
            id: caps.visionModel.id,
            label: modelLabel(caps.visionModel, caps.providerById),
            supports_vision: caps.visionModel.supports_vision,
          }
        : null,
    },
    providers: providersBody,
    models: modelsBody,
    tools: toolsBody,
    tool_health: toolHealthBody,
    model_health: modelHealthBody,
    mcp_servers: mcpBody,
  });
}

async function featureCounts(env, conversationId) {
  const body = await jsonFetch(
    env,
    `/v1/costs/breakdown?scope=session&conversation_id=${encodeURIComponent(conversationId)}&group_by=feature`,
  );
  const rows = body.data?.rows ?? [];
  return Object.fromEntries(rows.map((r) => [r.key ?? r.feature ?? r.label, r.count]));
}

async function toolRunEventCount(env, conversationId, toolName) {
  const body = await jsonFetch(
    env,
    `/v1/conversations/${encodeURIComponent(conversationId)}/run-events?limit=500`,
  );
  const events = body.data?.events ?? [];
  return events.filter((event) => {
    if (event.kind !== 'tool.started' && event.kind !== 'tool.completed' && event.kind !== 'tool.failed') {
      return false;
    }
    return event.payload?.tool === toolName;
  }).length;
}

async function latestContextVisibleToolLabel(env, conversationId) {
  const body = await jsonFetch(
    env,
    `/v1/conversations/${encodeURIComponent(conversationId)}/run-events?limit=500`,
  );
  const events = body.data?.events ?? [];
  const snapshots = events.filter((event) => event.kind === 'context.snapshot');
  const latest = snapshots[snapshots.length - 1]?.payload;
  const activeTools = Array.isArray(latest?.active_tool_names) ? latest.active_tool_names : [];
  return `${activeTools.length} 个工具可见`;
}

async function latestRunEvents(env, conversationId) {
  const body = await jsonFetch(
    env,
    `/v1/conversations/${encodeURIComponent(conversationId)}/run-events?limit=500`,
  );
  return body.data?.events ?? [];
}

async function summarizeToolAttempt(page, env, conversationId, toolName) {
  const [events, runs, effectiveToolsBody] = await Promise.all([
    latestRunEvents(env, conversationId).catch(() => []),
    latestRuns(env, conversationId, 10).catch(() => []),
    jsonFetch(
      env,
      `/v1/tools/effective?conversation_id=${encodeURIComponent(conversationId)}`,
    ).catch((e) => ({ error: e.message })),
  ]);
  const toolEvents = events.filter((event) =>
    (event.kind === 'tool.started' || event.kind === 'tool.completed' || event.kind === 'tool.failed') &&
    event.payload?.tool === toolName,
  );
  const contextSnapshots = events.filter((event) => event.kind === 'context.snapshot');
  const latestToolSnapshot = [...contextSnapshots]
    .reverse()
    .find((event) => Array.isArray(event.payload?.active_tool_names));
  const effectiveTools =
    effectiveToolsBody.data?.tools ??
    effectiveToolsBody.tools ??
    effectiveToolsBody.data ??
    [];
  const latestAssistantText = await page.locator('.msg.assistant')
    .last()
    .innerText({ timeout: 5000 })
    .then((text) => text.trim().slice(0, 2000))
    .catch(() => null);
  return {
    expected_tool: toolName,
    tool_was_visible_in_latest_context: Array.isArray(latestToolSnapshot?.payload?.active_tool_names)
      ? latestToolSnapshot.payload.active_tool_names.includes(toolName)
      : null,
    latest_active_tool_names: Array.isArray(latestToolSnapshot?.payload?.active_tool_names)
      ? latestToolSnapshot.payload.active_tool_names
      : null,
    effective_tool: Array.isArray(effectiveTools)
      ? effectiveTools.find((tool) => tool?.name === toolName) ?? null
      : null,
    expected_tool_event_count: toolEvents.length,
    expected_tool_events: toolEvents.map((event) => ({
      run_id: event.run_id,
      kind: event.kind,
      status: event.status,
      label: event.label,
      summary: event.summary,
      payload: event.payload,
    })),
    latest_runs: runs.slice(0, 3).map((run) => ({
      id: run.id,
      kind: run.kind,
      status: run.status,
      recovery_policy: run.recovery_policy,
      model_id: run.model_id,
      event_count: run.event_count,
    })),
    latest_assistant_text: latestAssistantText,
  };
}

async function latestContextWindow(env, conversationId) {
  const events = await latestRunEvents(env, conversationId);
  const snapshots = events.filter((event) => event.kind === 'context.snapshot');
  return snapshots[snapshots.length - 1]?.payload?.context_window ?? null;
}

async function latestRuns(env, conversationId, limit = 10) {
  const body = await jsonFetch(
    env,
    `/v1/conversations/${encodeURIComponent(conversationId)}/runs?limit=${encodeURIComponent(String(limit))}`,
  );
  return body.data?.runs ?? [];
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

async function cleanupTempMcpServer(env, server) {
  if (server?.id) {
    await authedFetch(env, `/v1/mcp/servers/${server.id}`, { method: 'DELETE' }).catch(() => null);
  }
  if (server?.tmpDir) {
    fs.rmSync(server.tmpDir, { recursive: true, force: true });
  }
}

function mockMcpServerSource() {
  return `
let buffer = Buffer.alloc(0);
function send(id, result) {
  const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result }), 'utf8');
  process.stdout.write('Content-Length: ' + payload.byteLength + '\\r\\n\\r\\n');
  process.stdout.write(payload);
}
function handle(message) {
  if (!message.id) return;
  if (message.method === 'initialize') {
    send(message.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'real-journey-local', version: '1' } });
  } else if (message.method === 'tools/list') {
    send(message.id, { tools: [{ name: 'evidence', description: 'Real Journey Local Evidence', inputSchema: { type: 'object' } }] });
  } else if (message.method === 'tools/call') {
    send(message.id, { content: [{ type: 'text', text: 'local evidence:' + (message.params?.arguments?.text ?? '${RUN_ID}') }] });
  }
}
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const sep = buffer.indexOf('\\r\\n\\r\\n');
    if (sep < 0) return;
    const header = buffer.slice(0, sep).toString('utf8');
    const match = /content-length:\\s*(\\d+)/i.exec(header);
    if (!match) return;
    const len = Number(match[1]);
    const start = sep + 4;
    const end = start + len;
    if (buffer.byteLength < end) return;
    const payload = buffer.slice(start, end).toString('utf8');
    buffer = buffer.slice(end);
    handle(JSON.parse(payload));
  }
});
`;
}

function failingMcpServerSource() {
  return `
let buffer = Buffer.alloc(0);
function send(id, result) {
  const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result }), 'utf8');
  process.stdout.write('Content-Length: ' + payload.byteLength + '\\r\\n\\r\\n');
  process.stdout.write(payload);
}
function sendError(id, message) {
  const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message } }), 'utf8');
  process.stdout.write('Content-Length: ' + payload.byteLength + '\\r\\n\\r\\n');
  process.stdout.write(payload);
}
function handle(message) {
  if (!message.id) return;
  if (message.method === 'initialize') {
    send(message.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'real-journey-failing', version: '1' } });
  } else if (message.method === 'tools/list') {
    send(message.id, { tools: [{ name: 'evidence', description: 'Failing Real Journey Evidence MCP', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] });
  } else if (message.method === 'tools/call') {
    sendError(message.id, 'planned real journey MCP tool failure');
  }
}
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const sep = buffer.indexOf('\\r\\n\\r\\n');
    if (sep < 0) return;
    const header = buffer.slice(0, sep).toString('utf8');
    const match = /content-length:\\s*(\\d+)/i.exec(header);
    if (!match) return;
    const len = Number(match[1]);
    const start = sep + 4;
    const end = start + len;
    if (buffer.byteLength < end) return;
    const payload = buffer.slice(start, end).toString('utf8');
    buffer = buffer.slice(end);
    handle(JSON.parse(payload));
  }
});
`;
}

async function createTempMcpServer(env) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taori-real-mcp-'));
  const scriptPath = path.join(tmpDir, 'real-journey-mcp-server.mjs');
  fs.writeFileSync(scriptPath, mockMcpServerSource(), 'utf8');
  const created = await postJson(env, '/v1/mcp/servers', {
    name: `${RUN_ID} Local Evidence MCP`,
    command: process.execPath,
    args: [scriptPath],
    enabled: true,
  });
  const refreshed = await jsonFetch(env, `/v1/mcp/servers/${created.server.id}/refresh`, {
    method: 'POST',
  });
  if (!refreshed.ok || refreshed.server?.health_status !== 'ok' || refreshed.server?.tools_count < 1) {
    fail('temporary MCP server did not refresh successfully', { refreshed });
  }
  return { ...refreshed.server, tmpDir };
}

async function createTempFailingMcpServer(env) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taori-real-failing-mcp-'));
  const scriptPath = path.join(tmpDir, 'real-journey-failing-mcp-server.mjs');
  fs.writeFileSync(scriptPath, failingMcpServerSource(), 'utf8');
  const created = await postJson(env, '/v1/mcp/servers', {
    name: `${RUN_ID} Failing Evidence MCP`,
    command: process.execPath,
    args: [scriptPath],
    enabled: true,
  });
  const refreshed = await jsonFetch(env, `/v1/mcp/servers/${created.server.id}/refresh`, {
    method: 'POST',
  });
  if (!refreshed.ok || refreshed.server?.health_status !== 'ok' || refreshed.server?.tools_count < 1) {
    fail('temporary failing MCP server did not refresh successfully', { refreshed });
  }
  return { ...refreshed.server, tmpDir };
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
    supports_tools: true,
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

async function assertLatestRunTimeline(page, expectedTexts, screenshotName) {
  await page.getByTestId('open-run-timeline').click();
  const panel = page.getByTestId('run-timeline-panel');
  await expectVisible(panel, 'run timeline panel', 15_000);
  const topRun = panel.getByTestId('run-group').first();
  await expectVisible(topRun, 'latest run timeline group', 15_000);
  for (const text of expectedTexts) {
    await expectVisible(topRun.getByTestId('run-event').filter({ hasText: text }).first(), `latest run event ${text}`, 20_000);
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

async function runRoundtableTimelineJourney(page, env, caps, originalConversationId, events) {
  log('验证真实圆桌运行写入 Run Timeline');
  await page.getByTestId('composer-roundtable').click();
  const dialog = page.getByTestId('roundtable-launch-dialog');
  await expectVisible(dialog, 'roundtable launch dialog', 10_000);
  await dialog.getByTestId('roundtable-mode-select').selectOption('fast');
  await dialog.getByTestId('roundtable-topic-input').fill(
    `${RUN_ID}：Taori 是否应该把 Agent Runtime 的恢复动作、工具调用和成本记录统一展示给用户？请给出产品/工程取舍。`,
  );
  await dialog.getByTestId('roundtable-analyzer-model-select').selectOption(caps.toolChat.id);
  await dialog.getByTestId('roundtable-summarizer-model-select').selectOption(caps.toolChat.id);
  await dialog.getByTestId('roundtable-launch-start').click();
  await expectVisible(dialog.getByTestId('roundtable-preview'), 'roundtable preview', 180_000);
  const participantSelects = await dialog.locator('[data-testid^="roundtable-participant-model-"]').all();
  for (const select of participantSelects) {
    await select.selectOption(caps.toolChat.id).catch(() => null);
  }
  await screenshot(page, '09f-roundtable-preview');
  await expectNoLayoutOverflow(page, 'roundtable preview');
  await dialog.getByTestId('roundtable-launch-continue').click();

  const panel = page.getByTestId('roundtable-panel');
  await expectVisible(panel, 'roundtable panel', 20_000);
  const roundtableConversationId = await currentConversationId(page);
  await panel.getByTestId('roundtable-action-start-round').click();
  await expectVisible(panel.getByTestId('roundtable-cell-0-1'), 'roundtable first participant cell', 10_000);
  await page.waitForFunction(
    () => document.querySelector('[data-testid="roundtable-cell-0-1"]')?.className.includes('roundtable-cell-complete'),
    undefined,
    { timeout: 180_000 },
  ).catch((e) => {
    fail('real roundtable first participant did not complete', { error: e.message });
  });
  await screenshot(page, '09g-roundtable-round');
  await expectNoLayoutOverflow(page, 'roundtable round');

  await assertRunTimeline(
    page,
    ['圆桌分析', '圆桌分析完成', '圆桌第 1 轮', '参与者成本'],
    '09h-run-timeline-roundtable',
  );
  if (!roundtableConversationId) {
    fail('roundtable conversation id was not visible after launch');
  }
  const roundtableEvents = await latestRunEvents(env, roundtableConversationId);
  const roundtableRuns = await latestRuns(env, roundtableConversationId, 10);
  if (!roundtableRuns.some((run) => run.kind === 'roundtable')) {
    fail('roundtable run events were not readable from sidecar', {
      conversation_id: roundtableConversationId,
      runs: roundtableRuns,
      event_count: roundtableEvents.length,
    });
  }
  events.steps.push({
    name: 'real_roundtable_timeline',
    ok: true,
    conversation_id: roundtableConversationId,
    run_count: roundtableRuns.length,
    event_count: roundtableEvents.length,
  });

  if (originalConversationId) {
    await page.locator(`[data-testid="conv-item"][data-conv-id="${originalConversationId}"]`).click();
    await expectVisible(page.getByTestId('chat-panel'), 'original chat after roundtable', 20_000);
  }
}

async function runHighCostRecoveryConfirmationJourney(page, env, caps, conversationId, events) {
  log('验证真实恢复动作的高成本确认闭环');
  const marker = `${RUN_ID} FORCE_HIGH_COST_RECOVERY_CONFIRMATION`;
  const thresholdSnapshot = await snapshotMemory(
    env,
    'session',
    'cost_confirm_threshold_usd',
    conversationId,
  );
  let forcedFailure = false;
  const originalPricing = {
    price_input_per_1m: caps.toolChat.price_input_per_1m ?? null,
    price_output_per_1m: caps.toolChat.price_output_per_1m ?? null,
    price_per_call: caps.toolChat.price_per_call ?? null,
  };
  await page.route('**/v1/chat', async (route) => {
    const req = route.request();
    let shouldForce = false;
    try {
      shouldForce = req.postData()?.includes(marker) === true;
    } catch {
      shouldForce = false;
    }
    if (shouldForce && !forcedFailure) {
      forcedFailure = true;
      await route.continue({
        headers: {
          ...req.headers(),
          'x-test-force-classification': 'rate_limit',
        },
      });
      return;
    }
    await route.continue();
  });
  try {
    await selectModel(page, caps.toolChat);
    await sendMessage(
      page,
      `${marker}\n请用真实模型继续分析 Agent Runtime 恢复策略。这一轮会先产生一次可恢复失败。`,
    );
    await expectVisible(page.getByTestId('failure-decision-card'), 'high-cost recovery failure card', 30_000);
    await putMemoryValue(
      env,
      'session',
      'cost_confirm_threshold_usd',
      '0.0000000001',
      conversationId,
    );
    await patchModel(env, caps.toolChat.id, {
      price_input_per_1m: originalPricing.price_input_per_1m ?? 1,
      price_output_per_1m: originalPricing.price_output_per_1m ?? 1,
      price_per_call: 0.01,
    });
    caps.toolChat.price_per_call = 0.01;
    await page.getByTestId('fdc-retry').click();
    await expectVisible(page.getByTestId('cost-confirm-dialog'), 'high-cost recovery confirm dialog', 10_000);
    await expectVisible(page.getByTestId('cost-confirm-rationale'), 'high-cost recovery rationale', 5_000);
    await screenshot(page, '09f-high-cost-recovery-confirm');
    await page.getByTestId('cost-confirm-continue').click();
    await expectHidden(page.getByTestId('cost-confirm-dialog'), 'high-cost recovery confirm dialog after continue', 20_000);
    await expectHidden(page.getByTestId('failure-decision-card'), 'high-cost recovery failure card after recover', 150_000);
    await waitForAssistantTurn(page, 150_000);
    const runs = await latestRuns(env, conversationId, 8);
    if (runs[0]?.recovery_policy !== 'retry_same_model' || runs[0]?.status !== 'completed') {
      fail('high-cost recovery confirmation did not complete a retry_same_model recovery run', {
        latest_run: runs[0] ?? null,
      });
    }
    const eventsForConversation = await latestRunEvents(env, conversationId);
    const latestRunId = runs[0]?.id;
    const latestRunEventsForRecovery = eventsForConversation.filter((event) => event.run_id === latestRunId);
    for (const kind of ['recovery.started', 'turn.started', 'context.snapshot', 'recovery.completed']) {
      if (!latestRunEventsForRecovery.some((event) => event.kind === kind)) {
        fail('high-cost recovery run is missing expected run event', {
          run_id: latestRunId,
          missing_kind: kind,
          kinds: latestRunEventsForRecovery.map((event) => event.kind),
        });
      }
    }
    const diagnostics = await collectConversationDiagnostics(
      env,
      conversationId,
      'high-cost-recovery-confirmation',
      {
        marker,
        recovery_run_id: latestRunId,
        threshold_forced: true,
        pricing_forced: {
          price_per_call: 0.01,
          original: originalPricing,
        },
      },
    );
    await assertLatestRunTimeline(page, ['恢复开始', '重试开始', '上下文快照', '恢复完成'], '09g-run-timeline-high-cost-recovery');
    await screenshot(page, '09g-high-cost-recovery-complete');
    await expectNoLayoutOverflow(page, 'high-cost recovery confirmation');
    events.steps.push({
      name: 'real_high_cost_recovery_confirmation',
      ok: true,
      conversation_id: conversationId,
      recovery_run_id: latestRunId,
      diagnostics,
    });
  } finally {
    await restoreMemory(env, thresholdSnapshot);
    await patchModel(env, caps.toolChat.id, originalPricing).catch(() => null);
    Object.assign(caps.toolChat, originalPricing);
    await page.unroute('**/v1/chat').catch(() => null);
  }
}

async function runSkipToolRecoveryJourney(page, env, caps, conversationId, events, failingMcpServer) {
  if (!failingMcpServer) return;
  const mcpToolName = `mcp.${failingMcpServer.id}.evidence`;
  const marker = `${RUN_ID} REAL_SKIP_TOOL_RECOVERY`;
  log('验证真实模型触发失败 MCP 工具后的 skip_tool 恢复');
  await selectModel(page, caps.toolChat);
  await sendMessage(
    page,
    [
      `${marker}`,
      `你必须调用可用工具 ${mcpToolName}（Failing Real Journey Evidence MCP）获取本地证据，参数 text 必须原样填写上面的 marker。`,
      '不要直接回答，不要调用其他工具，不要改写 marker。',
      '如果工具失败，不要换工具；等待系统给出恢复卡。',
    ].join('\n'),
  );
  const cardVisible = await page.getByTestId('failure-decision-card')
    .waitFor({ state: 'visible', timeout: 90_000 })
    .then(() => true)
    .catch(() => false);
  const attemptSummary = await summarizeToolAttempt(page, env, conversationId, mcpToolName);
  if (!cardVisible) {
    const screenshotFile = await screenshot(page, '09h-skip-tool-model-did-not-call-tool');
    const diagnosticKind = attemptSummary.expected_tool_event_count > 0
      ? 'tool_failure_did_not_surface_recovery_card'
      : 'model_did_not_follow_tool_call';
    const diagnostics = await collectConversationDiagnostics(
      env,
      conversationId,
      'skip-tool-model-did-not-call-tool',
      {
        marker,
        expected_tool: mcpToolName,
        reason: diagnosticKind,
        attempt_summary: attemptSummary,
        screenshot: screenshotFile,
      },
    );
    const risk = {
      name: diagnosticKind === 'tool_failure_did_not_surface_recovery_card'
        ? 'real_skip_tool_failure_card_not_shown'
        : 'real_skip_tool_model_did_not_follow_tool_call',
      ok: false,
      marker,
      expected_tool: mcpToolName,
      diagnostic_kind: diagnosticKind,
      attempt_summary: attemptSummary,
      diagnostics,
      screenshot: screenshotFile,
    };
    events.structured_risks.push(risk);
    events.steps.push({
      name: 'real_skip_tool_recovery',
      ok: false,
      risk: diagnosticKind,
      expected_tool: mcpToolName,
      attempt_summary: attemptSummary,
      diagnostics,
      screenshot: screenshotFile,
    });
    return;
  }
  await expectVisible(page.getByTestId('fdc-skip-tool'), 'skip_tool recovery button', 10_000);
  if (!attemptSummary.expected_tool_events.some((event) => event.kind === 'tool.failed')) {
    fail('skip_tool failure card appeared without the expected failing MCP tool event', {
      marker,
      expected_tool: mcpToolName,
      attempt_summary: attemptSummary,
    });
  }
  const beforeUserCount = await page.locator('.msg.user').count();
  await page.getByTestId('fdc-skip-tool').click();
  await expectHidden(page.getByTestId('failure-decision-card'), 'skip_tool failure card after recover', 150_000);
  await waitForAssistantTurn(page, 150_000);
  const afterUserCount = await page.locator('.msg.user').count();
  if (afterUserCount !== beforeUserCount) {
    fail('skip_tool recovery added a synthetic user message', {
      before_user_count: beforeUserCount,
      after_user_count: afterUserCount,
    });
  }
  const runs = await latestRuns(env, conversationId, 10);
  if (runs[0]?.recovery_policy !== 'skip_tool' || runs[0]?.status !== 'completed') {
    fail('skip_tool recovery did not persist the expected latest run header', {
      latest_run: runs[0] ?? null,
    });
  }
  const runEvents = await latestRunEvents(env, conversationId);
  const latestRunEventsForSkip = runEvents.filter((event) => event.run_id === runs[0]?.id);
  if (latestRunEventsForSkip.some((event) => event.payload?.tool === mcpToolName)) {
    fail('skip_tool recovery exposed the skipped MCP tool again in the recovery run', {
      run_id: runs[0]?.id,
      tool: mcpToolName,
    });
  }
  const diagnostics = await collectConversationDiagnostics(
    env,
    conversationId,
    'skip-tool-recovery',
    {
      marker,
      skipped_tool: mcpToolName,
      recovery_run_id: runs[0]?.id,
      attempt_summary: attemptSummary,
    },
  );
  await assertLatestRunTimeline(page, ['恢复开始', '跳过工具重试开始', '上下文快照', '恢复完成'], '09i-run-timeline-skip-tool');
  await screenshot(page, '09i-skip-tool-recovery-complete');
  await expectNoLayoutOverflow(page, 'skip tool recovery');
  events.steps.push({
    name: 'real_skip_tool_recovery',
    ok: true,
    conversation_id: conversationId,
    skipped_tool: mcpToolName,
    recovery_run_id: runs[0]?.id,
    diagnostics,
  });
}

function emptyBackupCounts() {
  return {
    providers: 0,
    models: 0,
    conversations: 0,
    messages: 0,
    files: 0,
    memories: 0,
    prompt_templates: 0,
    personas: 0,
    cost_records: 0,
    roundtables: 0,
    roundtable_messages: 0,
  };
}

function backupPackageForImportedConversation(caps) {
  const now = Date.now();
  const conversationId = `conv_${RUN_ID}_imported`;
  const messageId = `msg_${RUN_ID}_imported`;
  const counts = emptyBackupCounts();
  counts.conversations = 1;
  counts.messages = 1;
  return {
    conversationId,
    backup: {
      format_version: 'taori-backup-v1',
      exported_at: now,
      app_version: 'real-journey',
      counts,
      warnings: [],
      data: {
        providers: [],
        models: [],
        conversations: [
          {
            id: conversationId,
            type: 'chat',
            title: `${RUN_ID} Imported Conversation`,
            created_at: now,
            updated_at: now,
            archived: false,
            pinned: false,
            tags: JSON.stringify(['real-verify']),
          },
        ],
        messages: [
          {
            id: messageId,
            conversation_id: conversationId,
            role: 'assistant',
            content: `${RUN_ID} Imported content. 这条消息来自真实验证备份导入场景。`,
            model_id: caps.toolChat?.id ?? null,
            parent_message_id: null,
            attachments: null,
            status: 'complete',
            error: null,
            created_at: now,
          },
        ],
        files: [],
        memories: [],
        prompt_templates: [],
        personas: [],
        cost_records: [],
        roundtables: [],
        roundtable_messages: [],
      },
    },
  };
}

async function runBackupImportRealChatJourney(page, env, caps, events) {
  log('验证备份导入后侧边栏刷新，并在导入会话中继续真实聊天');
  const { backup, conversationId } = backupPackageForImportedConversation(caps);
  const backupPath = path.join(os.tmpdir(), `taori-real-import-${RUN_ID}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2), 'utf8');
  try {
    await page.getByTestId('open-settings').click();
    await dismissTips(page);
    await expectVisible(page.getByTestId('control-center'), 'control center for backup import', 10_000);
    await page.getByTestId('settings-tab-general').click();
    await expectVisible(page.getByTestId('settings-danger-zone'), 'settings danger zone for import', 10_000);
    await page.getByTestId('settings-import-strategy').selectOption('rename');
    await page.getByTestId('settings-import-file').setInputFiles(backupPath);
    await expectTextContains(page.getByTestId('settings-danger-msg'), 'backup import completion message', '导入完成', 30_000);
    await page.getByTestId('settings-close').click();
    await expectHidden(page.getByTestId('control-center'), 'control center after backup import', 10_000);
    const importedItem = page.getByTestId('conv-item').filter({ hasText: `${RUN_ID} Imported Conversation` });
    await expectVisible(importedItem, 'imported conversation in sidebar', 20_000);
    await importedItem.click();
    await expectVisible(page.getByTestId('chat-panel'), 'chat panel for imported conversation', 10_000);
    await expectVisible(page.locator('.msg.assistant').filter({ hasText: `${RUN_ID} Imported content` }).first(), 'imported assistant message', 20_000);
    const activeImportedConversationId = await currentConversationId(page);
    if (!activeImportedConversationId) {
      fail('imported conversation became visible but active conversation id is missing');
    }
    await selectModel(page, caps.toolChat);
    await sendMessage(
      page,
      `${RUN_ID} 请基于刚导入的 Imported content 用一句中文回复：导入后的真实聊天可继续。不要调用工具。`,
    );
    await waitForAssistantTurn(page, 150_000);
    const messages = await getConversationMessages(env, activeImportedConversationId);
    if (!messages.some((message) => message.role === 'user' && (message.content ?? '').includes('导入后的真实聊天可继续'))) {
      fail('real chat after backup import was not persisted as a user message', {
        conversation_id: activeImportedConversationId,
      });
    }
    if (!messages.some((message) => message.role === 'assistant' && message.id !== 'msg_' + RUN_ID + '_imported')) {
      fail('real chat after backup import did not persist a new assistant message', {
        conversation_id: activeImportedConversationId,
        message_count: messages.length,
      });
    }
    const diagnostics = await collectConversationDiagnostics(
      env,
      activeImportedConversationId,
      'backup-import-real-chat',
      {
        requested_conversation_id: conversationId,
      },
    );
    await assertRunTimeline(page, ['上下文快照', '模型调用完成', '成本记录'], '12c-run-timeline-backup-import-chat');
    await screenshot(page, '12c-backup-import-real-chat');
    await expectNoLayoutOverflow(page, 'backup import real chat');
    events.steps.push({
      name: 'backup_import_then_real_chat',
      ok: true,
      imported_conversation_id: activeImportedConversationId,
      requested_conversation_id: conversationId,
      diagnostics,
    });
    return activeImportedConversationId;
  } finally {
    fs.rmSync(backupPath, { force: true });
  }
}

async function runJourney({ env, caps }) {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  let promptAssets = null;
  let tempManagedModel = null;
  let tempMcpServer = null;
  let tempFailingMcpServer = null;
  let restoreToolChatContextLength = false;
  let diagnosticConversationId = null;
  const imageDefaultSnapshot = await snapshotMemory(env, 'global', 'image_model_default');
  const originalToolChatContextLength = caps.toolChat.context_length ?? null;
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
    structured_risks: [],
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
    tempMcpServer = await createTempMcpServer(env);
    await putMemoryValue(env, 'global', 'image_model_default', caps.imageModel.id);
    await collectCapabilitySummary(env, caps);
    events.steps.push({
      name: 'create_prompt_assets_from_ui',
      ok: true,
      template_id: promptAssets.template.id,
      persona_id: promptAssets.persona.id,
    });
    events.steps.push({
      name: 'create_local_mcp_server',
      ok: true,
      server_id: tempMcpServer.id,
      tools_count: tempMcpServer.tools_count,
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
    diagnosticConversationId = conversationId;
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
    const effectiveAfterDisableTools = effectiveAfterDisable.data ?? [];
    const webFetchEffective = effectiveAfterDisableTools.find((t) => t.name === 'builtin.web_fetch');
    if (webFetchEffective?.effective_enabled !== false) {
      fail('web_fetch chip shows disabled but effective policy is not disabled', {
        webFetchEffective,
      });
    }
    const beforeDisabledWebFetchEvents = await toolRunEventCount(env, conversationId, 'builtin.web_fetch');
    await sendMessage(
      page,
      `${RUN_ID} 当前先不要切换设置。请尝试读取 https://example.com/，如果没有可用抓网页工具，请直接说明当前无法读取网页，不要编造页面内容。`,
    );
    await waitForAssistantTurn(page, 150_000);
    await assertContextSnapshot(page, promptAssets.persona.name);
    const afterDisabledWebFetchEvents = await toolRunEventCount(env, conversationId, 'builtin.web_fetch');
    if (afterDisabledWebFetchEvents > beforeDisabledWebFetchEvents) {
      fail('web_fetch disabled in session but a web_fetch run event was added', {
        before: beforeDisabledWebFetchEvents,
        after: afterDisabledWebFetchEvents,
      });
    }
    await screenshot(page, '07-web-fetch-disabled');
    await expectNoLayoutOverflow(page, 'web fetch disabled');
    await assertRunTimeline(
      page,
      ['上下文快照', await latestContextVisibleToolLabel(env, conversationId)],
      '07b-run-timeline-web-fetch-disabled',
    );
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
    await assertRunTimeline(
      page,
      ['上下文快照', await latestContextVisibleToolLabel(env, conversationId), '抓取网页'],
      '08b-run-timeline-web-fetch-enabled',
    );
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

    if (tempMcpServer) {
      const mcpToolName = `mcp.${tempMcpServer.id}.evidence`;
      const beforeMcp = await featureCounts(env, conversationId);
      log('验证普通聊天模型真实调用临时 MCP 工具');
      await sendMessage(
        page,
        `${RUN_ID} 请务必使用 MCP 工具 Real Journey Local Evidence 获取本地证据，参数 text 填 "${RUN_ID}"，然后用中文复述工具返回内容。`,
      );
      await waitForAssistantTurn(page, 150_000);
      await expectVisible(
        page.locator(`[data-testid="tool-trace-step"][data-tool="${mcpToolName}"]`).last(),
        'MCP tool trace in ordinary chat',
        20_000,
      );
      await assertContextSnapshot(page, promptAssets.persona.name);
      await screenshot(page, '09b-mcp-chat-tool');
      await expectNoLayoutOverflow(page, 'mcp chat tool');
      await assertRunTimeline(page, ['上下文快照', 'MCP · Real Journey Local Evidence'], '09c-run-timeline-mcp-chat');
      const afterMcp = await featureCounts(env, conversationId);
      if ((afterMcp.tool_call ?? 0) <= (beforeMcp.tool_call ?? 0)) {
        fail('MCP prompt completed but no additional tool_call cost record was added', {
          before: beforeMcp,
          after: afterMcp,
          tool: mcpToolName,
        });
      }
      events.steps.push({
        name: 'mcp_tool_from_ordinary_chat',
        ok: true,
        tool: mcpToolName,
      });
    }

    log('验证真实模型长上下文裁剪与 compact_context 恢复闭环');
    await selectModel(page, caps.toolChat);
    const patchedContextLength = Math.max(768, Math.min(1200, originalToolChatContextLength ?? 1200));
    await patchModel(env, caps.toolChat.id, { context_length: patchedContextLength });
    caps.toolChat.context_length = patchedContextLength;
    restoreToolChatContextLength = true;
    const longContextMarker = `${RUN_ID} LONG_CONTEXT_WINDOW_PROBE`;
    const longContextText = Array.from({ length: 70 }, (_, i) =>
      `${longContextMarker} 条目 ${String(i + 1).padStart(2, '0')}：Taori 应该保留最近事实、裁剪较早历史，并在上下文快照中记录 omitted_message_count。`,
    ).join('\n');
    await sendMessage(
      page,
      `${longContextText}\n\n请用一句中文确认你收到了长上下文探针，不要调用工具。`,
    );
    await waitForAssistantTurn(page, 150_000);
    await assertContextSnapshot(page, promptAssets.persona.name);
    const windowAfterLongContext = await latestContextWindow(env, conversationId);
    if (
      windowAfterLongContext?.strategy !== 'sliding_window' ||
      !(windowAfterLongContext.omitted_message_count > 0)
    ) {
      fail('real long context turn did not trigger sliding window truncation', {
        context_window: windowAfterLongContext,
        patched_context_length: patchedContextLength,
      });
    }
    await assertRunTimeline(page, ['上下文快照'], '09d-run-timeline-context-window');
    await screenshot(page, '09d-long-context-window');
    await expectNoLayoutOverflow(page, 'long context window');

    const compactFailureMarker = `${RUN_ID} FORCE_COMPACT_CONTEXT_FAILURE`;
    let forcedCompactFailure = false;
    await page.route('**/v1/chat', async (route) => {
      const req = route.request();
      let shouldForce = false;
      try {
        const raw = req.postData();
        shouldForce = raw ? raw.includes(compactFailureMarker) : false;
      } catch {
        shouldForce = false;
      }
      if (shouldForce && !forcedCompactFailure) {
        forcedCompactFailure = true;
        await route.continue({
          headers: {
            ...req.headers(),
            'x-test-force-classification': 'rate_limit',
          },
        });
        return;
      }
      await route.continue();
    });
    await sendMessage(
      page,
      `${compactFailureMarker}\n请基于刚才长上下文继续分析，但这一轮会触发一次可恢复失败。`,
    );
    await expectVisible(page.getByTestId('failure-decision-card'), 'compact_context failure decision card', 30_000);
    await expectVisible(page.getByTestId('fdc-compact'), 'compact context recovery button', 10_000);
    await page.getByTestId('fdc-compact').click();
    await expectHidden(page.getByTestId('failure-decision-card'), 'compact_context failure card after recover', 150_000);
    await waitForAssistantTurn(page, 150_000);
    const compactRuns = await latestRuns(env, conversationId, 8);
    if (compactRuns[0]?.recovery_policy !== 'compact_context' || compactRuns[0]?.status !== 'completed') {
      fail('compact_context recover did not persist the expected latest run header', {
        latest_run: compactRuns[0] ?? null,
      });
    }
    const compactEvents = await latestRunEvents(env, conversationId);
    const latestRunId = compactRuns[0]?.id;
    const latestRunEventsForCompact = compactEvents.filter((event) => event.run_id === latestRunId);
    for (const kind of ['recovery.started', 'turn.started', 'context.snapshot', 'recovery.completed']) {
      if (!latestRunEventsForCompact.some((event) => event.kind === kind)) {
        fail('compact_context recover run is missing expected run event', {
          run_id: latestRunId,
          missing_kind: kind,
          kinds: latestRunEventsForCompact.map((event) => event.kind),
        });
      }
    }
    const compactStarted = latestRunEventsForCompact.find((event) => event.kind === 'recovery.started');
    if (!(compactStarted?.payload?.compacted_message_count > 0)) {
      fail('compact_context recover event did not record compacted history metadata', {
        payload: compactStarted?.payload ?? null,
      });
    }
    await assertLatestRunTimeline(page, ['恢复开始', '压缩上下文重试开始', '上下文快照', '恢复完成'], '09e-run-timeline-compact-recover');
    await screenshot(page, '09e-compact-context-recover');
    await expectNoLayoutOverflow(page, 'compact context recover');
    events.steps.push({
      name: 'real_context_window_and_compact_context_recover',
      ok: true,
      model_id: caps.toolChat.id,
      patched_context_length: patchedContextLength,
      omitted_message_count: windowAfterLongContext.omitted_message_count,
      recovery_run_id: latestRunId,
    });

    await runHighCostRecoveryConfirmationJourney(page, env, caps, conversationId, events);

    tempFailingMcpServer = await createTempFailingMcpServer(env);
    events.steps.push({
      name: 'create_failing_mcp_server',
      ok: true,
      server_id: tempFailingMcpServer.id,
      tools_count: tempFailingMcpServer.tools_count,
    });
    await runSkipToolRecoveryJourney(page, env, caps, conversationId, events, tempFailingMcpServer);
    await cleanupTempMcpServer(env, tempFailingMcpServer);
    tempFailingMcpServer = null;

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

    await selectModel(page, caps.toolChat);
    await runRoundtableTimelineJourney(page, env, caps, conversationId, events);

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

    const importedConversationId = await runBackupImportRealChatJourney(page, env, caps, events);
    diagnosticConversationId = importedConversationId ?? diagnosticConversationId;
    await page.locator(`[data-testid="conv-item"][data-conv-id="${conversationId}"]`).click();
    await expectVisible(page.getByTestId('chat-panel'), 'original chat after backup import journey', 20_000);
    diagnosticConversationId = conversationId;

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
      await page.getByTestId(`model-select-${tempManagedModel.id}`).check();
      await page.getByTestId('model-center-bulk-enable').click();
      await page.getByTestId('model-center-status-filter').selectOption('enabled');
      await expectVisible(page.getByTestId(`model-row-${tempManagedModel.id}`), 'temporary enabled model row', 20_000);
      await page.getByTestId('model-center-feature-filter').selectOption('tools');
      await expectVisible(page.getByTestId(`model-row-${tempManagedModel.id}`), 'temporary tools-capable model row', 20_000);
      await page.getByTestId('model-center-sort').selectOption('context_desc');
      await screenshot(page, '13d-model-filter-sort');
      await expectNoLayoutOverflow(page, 'model center filter and sort');
      await page.getByTestId(`model-edit-${tempManagedModel.id}`).click();
      await expectVisible(page.getByTestId('model-editor'), 'temporary model editor', 10_000);
      await page.getByTestId('model-editor-pricing-meta').fill(
        JSON.stringify(
          {
            version: 1,
            unit: 'call',
            tiers: [{ label: RUN_ID, match: { journey: 'real' }, price_usd: 0.001 }],
            notes: `${RUN_ID} real journey pricing_meta`,
          },
          null,
          2,
        ),
      );
      await screenshot(page, '13e-pricing-meta-editor');
      await expectNoLayoutOverflow(page, 'pricing meta editor');
      await page.getByTestId('model-editor-save').click();
      await expectHidden(page.getByTestId('model-editor'), 'temporary model editor after save', 10_000);
      await expectVisible(
        page.locator(`[data-testid="model-row-${tempManagedModel.id}"] .badge--price_changed`).first(),
        'pricing meta badge on temporary model row',
        10_000,
      );
      await screenshot(page, '13f-pricing-meta-badge');
      await expectNoLayoutOverflow(page, 'pricing meta badge in model matrix');
      events.steps.push({ name: 'pricing_meta_edit_from_model_center', ok: true, model_id: tempManagedModel.id });
      await page.getByTestId('model-center-feature-filter').selectOption('all');
      await page.getByTestId(`provider-chip-more-${caps.toolChat.provider_id}`).click();
      await expectVisible(page.getByTestId(`provider-chip-menu-${caps.toolChat.provider_id}`), 'provider more menu', 10_000);
      await page.getByTestId(`provider-menu-edit-${caps.toolChat.provider_id}`).click();
      await expectVisible(page.getByTestId('provider-editor'), 'provider editor', 10_000);
      await screenshot(page, '13a-provider-editor');
      await expectNoLayoutOverflow(page, 'provider editor');
      await page.getByTestId('provider-editor-cancel').click();
      await expectHidden(page.getByTestId('provider-editor'), 'provider editor after cancel', 10_000);
      await page.getByTestId(`provider-chip-more-${caps.toolChat.provider_id}`).click();
      await expectVisible(page.getByTestId(`provider-chip-menu-${caps.toolChat.provider_id}`), 'provider more menu for sync', 10_000);
      await page.getByTestId(`provider-menu-sync-${caps.toolChat.provider_id}`).click();
      await expectVisible(page.getByTestId('model-center-sync-summary'), 'single provider sync summary', 45_000);
      await screenshot(page, '13c-provider-scoped-sync');
      await expectNoLayoutOverflow(page, 'provider scoped sync');
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
        name: 'model_management_provider_edit_sync_library_refresh_and_bulk_toggle',
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
      await expectTextContains(page.getByTestId(`settings-tool-${tool}`), `tool health ${tool}`, '24h 调用', 10_000);
      await expectTextContains(page.getByTestId(`settings-tool-${tool}`), `tool health last failure ${tool}`, '最近失败', 10_000);
    }
    if (tempMcpServer) {
      await page.locator('.control-center__content').evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      await expectVisible(page.getByTestId(`mcp-server-${tempMcpServer.id}`), 'temporary MCP server row', 10_000);
      await expectTextContains(page.getByTestId(`mcp-server-${tempMcpServer.id}`), 'temporary MCP server health', '健康：ok', 10_000);
      await expectVisible(
        page.getByTestId(`tool-toggle-mcp.${tempMcpServer.id}.evidence`),
        'temporary MCP tool toggle',
        10_000,
      );
      events.steps.push({ name: 'mcp_server_visible_in_tools_settings', ok: true, server_id: tempMcpServer.id });
    }
    await screenshot(page, '14-tools-settings');
    await expectNoLayoutOverflow(page, 'tools settings');
    events.steps.push({ name: 'tool_health_visible_in_control_center', ok: true });

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
    const firstCostSourceId = await page.getByTestId('cost-call-log-row').first().getAttribute('data-source-id');
    if (!firstCostSourceId) {
      fail('cost dashboard call log row did not expose a source backlink id', {
        row_text: await page.getByTestId('cost-call-log-row').first().textContent().catch(() => null),
      });
    }
    await expectTextContains(page.getByTestId('cost-call-log-row').first(), 'cost source label', '来源', 10_000);
    await assertCostDashboardTab(page, 'cost-dashboard-scope-week', 'week scope');
    await assertCostDashboardTab(page, 'cost-dashboard-scope-month', 'month scope');
    await assertCostDashboardTab(page, 'cost-dashboard-group-conversation', 'conversation group');
    await assertCostDashboardTab(page, 'cost-dashboard-group-feature', 'feature group');
    await screenshot(page, '16-cost-monitoring');
    await expectNoLayoutOverflow(page, 'cost monitoring');
    events.steps.push({ name: 'cost_dashboard_source_backlink_visible', ok: true, source_id: firstCostSourceId });
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

    await collectAgentRuntimeArtifacts(env, conversationId, events);
    if (importedConversationId) {
      await collectConversationDiagnostics(env, importedConversationId, 'final-imported-conversation');
    }
    events.steps.push({ name: 'agent_runtime_artifacts_collected', ok: true });

    const unexpectedConsoleErrors = events.console_errors.filter((text) => !isExpectedConsoleError(text));
    if (events.page_errors.length > 0 || unexpectedConsoleErrors.length > 0) {
      fail('browser reported page or console errors during the real journey', {
        page_errors: events.page_errors,
        console_errors: unexpectedConsoleErrors,
        expected_console_errors: events.console_errors.filter(isExpectedConsoleError),
      });
    }
    if (events.structured_risks.length > 0) {
      fail('real journey completed with structured provider/model risks', {
        risks: events.structured_risks,
        artifact_dir: ARTIFACT_DIR,
      });
    }

    return events;
  } finally {
    const finalScreenshot = await screenshot(page, '99-final-state').catch((e) => {
      events.final_screenshot_error = e instanceof Error ? e.message : String(e);
      return null;
    });
    if (finalScreenshot) events.final_screenshot = finalScreenshot;
    const finalConversationId = await currentConversationId(page).catch(() => null);
    const conversationForDiagnostics = finalConversationId ?? diagnosticConversationId;
    if (conversationForDiagnostics) {
      await collectConversationDiagnostics(
        env,
        conversationForDiagnostics,
        '99-final-state',
        { final_screenshot: finalScreenshot },
      ).then((file) => {
        events.final_diagnostics = file;
      }).catch((e) => {
        events.final_diagnostics_error = e instanceof Error ? e.message : String(e);
      });
    }
    if (restoreToolChatContextLength) {
      await patchModel(env, caps.toolChat.id, {
        context_length: originalToolChatContextLength,
      }).catch((e) => {
        events.cleanup_error = `failed to restore tool chat context_length: ${e.message}`;
      });
      caps.toolChat.context_length = originalToolChatContextLength;
    }
    await restoreMemory(env, imageDefaultSnapshot);
    await cleanupPromptAssets(env, promptAssets);
    await cleanupTempModel(env, tempManagedModel);
    await cleanupTempMcpServer(env, tempMcpServer);
    await cleanupTempMcpServer(env, tempFailingMcpServer);
    fs.writeFileSync(
      path.join(ARTIFACT_DIR, 'events.json'),
      JSON.stringify(events, null, 2),
      'utf8',
    );
    await browser.close();
  }
}

async function main() {
  if (REPORT_ONLY) {
    writeArtifactReport();
    return;
  }

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
  if (REPORT_ONLY) {
    console.error(err instanceof Error ? err.message : String(err));
    if (err?.details) console.error(JSON.stringify(err.details, null, 2));
    process.exit(1);
  }
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
