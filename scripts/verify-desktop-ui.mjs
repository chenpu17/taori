#!/usr/bin/env node
/**
 * Desktop UI smoke for the real Tauri WebView.
 *
 * Tauri WebDriver does not support macOS WKWebView, so this script drives the
 * actual desktop window through a debug-only localhost automation channel that
 * calls WebView eval. The channel is opt-in and only available in debug builds.
 * UI-only mode uses the dev_file keystore to avoid macOS Keychain prompts;
 * real chat mode explicitly switches back to Keychain.
 */
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUN_ID = `desktop-ui-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
const ARTIFACT_DIR =
  process.env.TAORI_DESKTOP_UI_OUT ?? path.join('/tmp', `taori-desktop-ui-${RUN_ID}`);
const SIDECAR_PORT = Number(process.env.TAORI_DESKTOP_UI_SIDECAR_PORT ?? 17890);
const VITE_PORT = Number(process.env.TAORI_DESKTOP_UI_VITE_PORT ?? 5173);
const BEARER =
  process.env.TAORI_DESKTOP_UI_BEARER ??
  `taori_desktop_ui_${Date.now()}_${Math.random().toString(36).slice(2)}`;
const SIDECAR_URL = `http://127.0.0.1:${SIDECAR_PORT}`;
const START_TIMEOUT_MS = Number(process.env.TAORI_DESKTOP_UI_START_TIMEOUT_MS ?? 120_000);
const CHAT_TIMEOUT_MS = Number(process.env.TAORI_DESKTOP_UI_CHAT_TIMEOUT_MS ?? 180_000);
const RUN_REAL_CHAT = process.env.TAORI_DESKTOP_UI_REAL_CHAT === '1';

fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
const desktopLogPath = artifactPath('desktop-dev.log');
const desktopLog = fs.createWriteStream(desktopLogPath, { flags: 'a' });

let desktopProc = null;
const state = {
  viteReady: false,
  controlReady: false,
  automationReady: false,
  sidecarReady: false,
  controlConfigured: false,
  rendererHealth: false,
  rendererProviders: false,
  rendererModels: false,
  rendererTools: false,
  controlUrl: null,
  automationUrl: null,
  sidecarUrl: null,
};

function artifactPath(name) {
  return path.join(ARTIFACT_DIR, name);
}

function log(message) {
  process.stdout.write(`${message}\n`);
}

function writeJsonArtifact(name, data) {
  const file = artifactPath(name);
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  return file;
}

function writeTextArtifact(name, data) {
  const file = artifactPath(name);
  fs.writeFileSync(file, data, 'utf8');
  return file;
}

function fail(message, details = {}) {
  const err = new Error(message);
  err.details = details;
  throw err;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function execFileText(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd: ROOT, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function portListeners(port) {
  try {
    const { stdout } = await execFileText('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN']);
    return stdout.trim();
  } catch (e) {
    if (e?.code === 1) return '';
    throw e;
  }
}

async function killPidsListeningOn(port) {
  let stdout = '';
  try {
    ({ stdout } = await execFileText('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']));
  } catch (e) {
    if (e?.code === 1) return;
    throw e;
  }
  const pids = stdout
    .split('\n')
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
  }
  await sleep(1_000);
  for (const pid of pids) {
    try {
      process.kill(pid, 0);
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

async function assertPortFree(port, label) {
  const listeners = await portListeners(port);
  if (listeners) fail(`${label} port ${port} is already in use`, { port, listeners });
}

function handleDesktopOutput(buffer) {
  const text = buffer.toString('utf8');
  desktopLog.write(text);
  process.stdout.write(text);

  if (text.includes(`Local:   http://127.0.0.1:${VITE_PORT}/`)) state.viteReady = true;

  const controlMatch = text.match(/control channel up at (http:\/\/127\.0\.0\.1:\d+)/);
  if (controlMatch) {
    state.controlReady = true;
    state.controlUrl = controlMatch[1];
  }
  const automationMatch = text.match(/automation channel up at (http:\/\/127\.0\.0\.1:\d+)/);
  if (automationMatch) {
    state.automationReady = true;
    state.automationUrl = automationMatch[1];
  }
  const sidecarMatch = text.match(/sidecar ready at (http:\/\/127\.0\.0\.1:\d+)/);
  if (sidecarMatch) {
    state.sidecarReady = true;
    state.sidecarUrl = sidecarMatch[1];
  }

  if (text.includes('control=configured')) state.controlConfigured = true;
  if (text.includes('"url":"/health"')) state.rendererHealth = true;
  if (text.includes('"url":"/v1/providers"')) state.rendererProviders = true;
  if (text.includes('"url":"/v1/models"')) state.rendererModels = true;
  if (text.includes('"url":"/v1/tools"')) state.rendererTools = true;
}

async function runCommandLogged(cmd, args, name, env = {}) {
  log(`运行：${cmd} ${args.join(' ')}`);
  const child = spawn(cmd, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk.toString('utf8');
    process.stdout.write(chunk);
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString('utf8');
    process.stderr.write(chunk);
  });
  const code = await new Promise((resolve) => child.on('exit', resolve));
  writeTextArtifact(`${name}.log`, output);
  if (code !== 0) fail(`${name} failed`, { code, log: artifactPath(`${name}.log`) });
}

async function startDesktopDev() {
  const sidecarEntry = path.join(ROOT, 'apps/sidecar/dist/index.js');
  if (!fs.existsSync(sidecarEntry)) {
    fail('built sidecar entry is missing; run pnpm build:sidecar first', { sidecarEntry });
  }

  desktopProc = spawn('pnpm', ['dev:desktop'], {
    cwd: ROOT,
    env: {
      ...process.env,
      SIDECAR_BEARER: BEARER,
      TAORI_DEV_SIDECAR_CMD: `node ${sidecarEntry}`,
      TAORI_DESKTOP_DEV_KEYSTORE: RUN_REAL_CHAT ? 'keychain' : 'dev_file',
      TAORI_DESKTOP_AUTOMATION: '1',
      TAORI_DESKTOP_AUTOMATION_BEARER: BEARER,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  desktopProc.stdout.on('data', handleDesktopOutput);
  desktopProc.stderr.on('data', handleDesktopOutput);
  desktopProc.on('exit', (code, signal) => {
    desktopLog.write(`\n[desktop-process-exit] code=${code} signal=${signal}\n`);
  });

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (
      state.viteReady &&
      state.controlReady &&
      state.automationReady &&
      state.sidecarReady &&
      state.controlConfigured &&
      state.rendererHealth
    ) {
      writeJsonArtifact('startup-state.json', state);
      return;
    }
    if (desktopProc.exitCode !== null) {
      fail('desktop dev process exited before startup checks completed', {
        exitCode: desktopProc.exitCode,
        state,
      });
    }
    await sleep(250);
  }
  fail('timed out waiting for desktop UI startup checks', { state });
}

async function authedFetch(route, init = {}, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${SIDECAR_URL}${route}`, {
      ...init,
      signal: controller.signal,
      headers: {
        ...(init.headers ?? {}),
        Authorization: `Bearer ${BEARER}`,
      },
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function jsonFetch(route, init = {}, timeoutMs = 30_000) {
  const res = await authedFetch(route, init, timeoutMs);
  let body = null;
  try {
    body = await res.json();
  } catch {
    // Preserve null body for the status error below.
  }
  if (!res.ok) fail(`sidecar ${route} failed with ${res.status}`, { route, status: res.status, body });
  return body;
}

async function automationEval(script, timeoutMs = 30_000) {
  if (!state.automationUrl) fail('automation channel URL is not available', { state });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs + 2_000);
  try {
    const res = await fetch(`${state.automationUrl}/v1/eval`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${BEARER}`,
      },
      body: JSON.stringify({ script, timeout_ms: timeoutMs }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      fail(`automation eval failed with ${res.status}`, { status: res.status, body, script: script.slice(0, 800) });
    }
    return body?.value;
  } finally {
    clearTimeout(timeout);
  }
}

function uiHelpers(script) {
  return `
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const q = (testId, root = document) => root.querySelector(\`[data-testid="\${testId}"]\`);
const qa = (testId, root = document) => Array.from(root.querySelectorAll(\`[data-testid="\${testId}"]\`));
const visible = (el) => {
  if (!el) return false;
  const s = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
};
const waitFor = async (fn, label, timeout = 30000) => {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = fn();
      if (value) return value;
      last = value;
    } catch (e) {
      last = e && e.message ? e.message : String(e);
    }
    await sleep(120);
  }
  throw new Error(\`Timed out waiting for \${label}: \${last ?? 'not ready'}\`);
};
const clickTestId = async (testId, timeout = 30000) => {
  const el = await waitFor(() => {
    const item = q(testId);
    return visible(item) && !item.disabled ? item : null;
  }, testId, timeout);
  el.scrollIntoView({ block: 'center', inline: 'center' });
  el.click();
  await sleep(80);
  return true;
};
${script}`;
}

async function ui(script, timeoutMs = 30_000) {
  return automationEval(uiHelpers(script), timeoutMs);
}

async function verifyHealthAndModels() {
  const [providers, models] = await Promise.all([
    jsonFetch('/v1/providers'),
    jsonFetch('/v1/models'),
  ]);
  writeJsonArtifact('providers.json', providers);
  writeJsonArtifact('models.json', models);
  return {
    providers: providers.providers ?? [],
    keyStatus: [],
    models: models.models ?? [],
  };
}

function isRunnableModel(model, keyByProvider) {
  if (!model.enabled) return false;
  if (model.disabled_until && model.disabled_until > Date.now()) return false;
  if (!model.provider_id) return false;
  return keyByProvider.size === 0 || keyByProvider.get(model.provider_id) !== false;
}

function pickRealChatModel(models, keyStatus) {
  const explicitId = process.env.TAORI_DESKTOP_UI_MODEL_ID;
  const keyByProvider = new Map(keyStatus.map((s) => [s.provider_id, s.key_available]));
  const runnable = models.filter(
    (m) =>
      isRunnableModel(m, keyByProvider) &&
      (m.capability === 'chat' || m.capability === 'multimodal'),
  );
  if (explicitId) {
    const explicit = runnable.find((m) => m.id === explicitId);
    if (!explicit) {
      fail('TAORI_DESKTOP_UI_MODEL_ID is not an enabled real chat model with a Keychain key', {
        explicitId,
        runnable: runnable.map((m) => ({ id: m.id, display_name: m.display_name })),
      });
    }
    return explicit;
  }
  return (
    runnable.find((m) => m.is_default_for === 'chat') ??
    runnable.find((m) => /deepseek|doubao|gpt|qwen|claude/i.test(`${m.display_name} ${m.model_name}`)) ??
    runnable[0] ??
    null
  );
}

function backupPackageForUiImport() {
  const now = Date.now();
  const conversationId = `conv_desktop_ui_import_${now}`;
  const title = `${RUN_ID} Imported Conversation`;
  return {
    conversationId,
    title,
    backup: {
      format_version: 'taori-backup-v1',
      exported_at: now,
      app_version: '0.0.0-desktop-ui-smoke',
      counts: {
        providers: 0,
        models: 0,
        conversations: 1,
        messages: 1,
        files: 0,
        memories: 0,
        prompt_templates: 0,
        personas: 0,
        cost_records: 0,
        roundtables: 0,
        roundtable_messages: 0,
      },
      warnings: [],
      data: {
        providers: [],
        models: [],
        conversations: [
          {
            id: conversationId,
            type: 'chat',
            title,
            created_at: now,
            updated_at: now,
            archived: false,
            pinned: false,
            tags: null,
          },
        ],
        messages: [
          {
            id: `msg_desktop_ui_import_${now}`,
            conversation_id: conversationId,
            role: 'assistant',
            content: `${RUN_ID} Imported content`,
            model_id: null,
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

async function runUiJourney(model = null) {
  const { backup, conversationId: requestedConversationId, title } = backupPackageForUiImport();
  const backupJson = JSON.stringify(backup).replace(/</g, '\\u003c');
  const prompt = `${RUN_ID} 请基于刚导入的 Imported content 用一句中文回复：桌面 UI 自动化通过。不要调用工具。`;

  await ui(`return {
    title: document.title,
    hasTauri: Boolean(window.__TAURI_INTERNALS__),
    healthText: q('open-settings') ? 'ready' : document.body.innerText.slice(0, 500),
  };`);

  await ui(`await clickTestId('open-settings', 120000);`, 125_000);
  await ui(`await waitFor(() => visible(q('control-center')), 'control center', 10000);`);
  await ui(`await clickTestId('settings-tab-general');`, 15_000).catch(() => null);
  await ui(`
    const select = await waitFor(() => q('settings-import-strategy'), 'import strategy', 10000);
    select.value = 'rename';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    const input = await waitFor(() => q('settings-import-file'), 'import file input', 10000);
    const file = new File([${JSON.stringify(backupJson)}], 'desktop-ui-import.json', { type: 'application/json' });
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => (q('settings-danger-msg')?.textContent || '').includes('导入完成'), 'import completion', 30000);
    return { message: q('settings-danger-msg')?.textContent || null };
  `, 35_000);
  await ui(`await clickTestId('settings-close');`);

  const importVisible = await ui(`
    const item = await waitFor(() => qa('conv-item').find((el) => (el.textContent || '').includes(${JSON.stringify(title)})), 'imported conversation in sidebar', 30000);
    item.click();
    await waitFor(() => visible(q('chat-panel')), 'chat panel', 10000);
    await waitFor(() => Array.from(document.querySelectorAll('.msg.assistant')).some((el) => (el.textContent || '').includes(${JSON.stringify(`${RUN_ID} Imported content`)})), 'imported assistant message', 20000);
    return { sidebarText: item.textContent };
  `, 35_000);

  const conversations = await jsonFetch('/v1/conversations');
  const imported = (conversations.conversations ?? []).find((item) => item.title === title);
  if (!imported) fail('UI-imported conversation is not visible through sidecar list', { title, importVisible });
  const importedMessages = await jsonFetch(`/v1/conversations/${encodeURIComponent(imported.id)}/messages`);

  if (!RUN_REAL_CHAT) {
    const result = {
      mode: 'ui_only',
      requested_conversation_id: requestedConversationId,
      imported_conversation: imported,
      message_count: importedMessages.messages?.length ?? 0,
    };
    writeJsonArtifact('ui-journey.json', result);
    writeJsonArtifact('ui-journey-messages.json', importedMessages);
    return result;
  }

  if (!model) {
    fail('real chat mode requires an enabled chat model', { title });
  }

  await ui(`
    if (!window.__TAORI_AUTOMATION__?.setActiveModel) throw new Error('automation model setter missing');
    window.__TAORI_AUTOMATION__.setActiveModel(${JSON.stringify(model.id)});
    await waitFor(() => q('active-model')?.value === ${JSON.stringify(model.id)}, 'active model selection', 10000);
    const input = await waitFor(() => q('composer-input'), 'composer input', 10000);
    input.value = ${JSON.stringify(prompt)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => !q('composer-send')?.disabled, 'composer send enabled', 10000);
    q('composer-send').click();
    await waitFor(() => q('composer-stop'), 'stream started', 20000);
    await waitFor(() => !q('composer-stop'), 'stream finished', ${CHAT_TIMEOUT_MS});
    await waitFor(() => Array.from(document.querySelectorAll('.msg.assistant')).some((el) => (el.textContent || '').includes('桌面 UI 自动化通过')), 'assistant reply visible', 20000);
    return { assistantCount: document.querySelectorAll('.msg.assistant').length };
  `, CHAT_TIMEOUT_MS + 30_000);

  const [messages, runsBody, eventsBody] = await Promise.all([
    jsonFetch(`/v1/conversations/${encodeURIComponent(imported.id)}/messages`),
    jsonFetch(`/v1/conversations/${encodeURIComponent(imported.id)}/runs?limit=10`),
    jsonFetch(`/v1/conversations/${encodeURIComponent(imported.id)}/run-events?limit=120`),
  ]);
  const runs = runsBody.data?.runs ?? [];
  const events = eventsBody.data?.events ?? [];
  const eventKinds = new Set(events.map((event) => event.kind));
  const expectedKinds = ['context.snapshot', 'model.completed', 'cost.recorded', 'turn.completed'];
  const missingKinds = expectedKinds.filter((kind) => !eventKinds.has(kind));
  if (missingKinds.length > 0) {
    fail('UI real chat run events are incomplete', { imported, missingKinds, eventKinds: [...eventKinds] });
  }

  await ui(`
    await clickTestId('open-run-timeline');
    const panel = await waitFor(() => q('run-timeline-panel'), 'run timeline panel', 15000);
    await waitFor(() => qa('run-event', panel).some((el) => (el.textContent || '').includes('模型调用完成')), 'timeline model completed', 15000);
    await waitFor(() => qa('run-event', panel).some((el) => (el.textContent || '').includes('成本记录')), 'timeline cost recorded', 15000);
    const timelineText = panel.innerText;
    q('run-timeline-close')?.click();
    await waitFor(() => !visible(q('run-timeline-panel')), 'timeline closed', 10000);
    return { timelineText };
  `, 35_000);

  await ui(`
    await clickTestId('open-cost-dashboard');
    const panel = await waitFor(() => q('cost-dashboard-panel'), 'cost dashboard', 20000);
    await waitFor(() => q('cost-call-log-row', panel), 'cost call log row', 20000);
    const text = panel.innerText;
    q('settings-close')?.click();
    await waitFor(() => !visible(q('control-center')), 'control center closed', 10000);
    return { costText: text.slice(0, 2000) };
  `, 45_000);

  const [realtime, breakdown] = await Promise.all([
    jsonFetch(`/v1/costs/realtime?conversation_id=${encodeURIComponent(imported.id)}`),
    jsonFetch(`/v1/costs/breakdown?scope=session&conversation_id=${encodeURIComponent(imported.id)}`),
  ]);
  const result = {
    requested_conversation_id: requestedConversationId,
    imported_conversation: imported,
    model: { id: model.id, display_name: model.display_name, provider_id: model.provider_id },
    message_count: messages.messages?.length ?? 0,
    latest_run: runs[0] ?? null,
    event_kinds: [...eventKinds],
    realtime: realtime.data,
    breakdown: breakdown.data,
  };
  writeJsonArtifact('ui-journey.json', result);
  writeJsonArtifact('ui-journey-messages.json', messages);
  writeJsonArtifact('ui-journey-runs.json', runsBody);
  writeJsonArtifact('ui-journey-events.json', eventsBody);
  writeJsonArtifact('ui-journey-costs.json', { realtime, breakdown });
  if ((realtime.data?.current_conversation_calls ?? 0) < 1) {
    fail('UI real chat did not increment conversation cost calls', result);
  }
  return result;
}

async function stopDesktopDev() {
  if (!desktopProc || desktopProc.exitCode !== null) return;
  try {
    process.kill(-desktopProc.pid, 'SIGINT');
  } catch {
    desktopProc.kill('SIGINT');
  }
  let deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const [sidecar, vite] = await Promise.all([portListeners(SIDECAR_PORT), portListeners(VITE_PORT)]);
    if (!sidecar && !vite) return;
    await sleep(200);
  }
  try {
    process.kill(-desktopProc.pid, 'SIGTERM');
  } catch {
    desktopProc.kill('SIGTERM');
  }
  deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [sidecar, vite] = await Promise.all([portListeners(SIDECAR_PORT), portListeners(VITE_PORT)]);
    if (!sidecar && !vite) return;
    await sleep(250);
  }
  try {
    process.kill(-desktopProc.pid, 'SIGKILL');
  } catch {
    desktopProc.kill('SIGKILL');
  }
  await Promise.all([killPidsListeningOn(SIDECAR_PORT), killPidsListeningOn(VITE_PORT)]);
}

async function verifyNoListeners() {
  const [sidecar, vite] = await Promise.all([portListeners(SIDECAR_PORT), portListeners(VITE_PORT)]);
  const result = {
    sidecar_port: SIDECAR_PORT,
    sidecar_listeners: sidecar,
    vite_port: VITE_PORT,
    vite_listeners: vite,
  };
  writeJsonArtifact('port-cleanup.json', result);
  if (sidecar || vite) fail('desktop UI smoke left dev ports listening', result);
}

async function main() {
  const startedAt = Date.now();
  log(`桌面 UI smoke artifact: ${ARTIFACT_DIR}`);
  await assertPortFree(SIDECAR_PORT, 'sidecar');
  await assertPortFree(VITE_PORT, 'vite');
  await runCommandLogged('pnpm', ['build:sidecar'], 'build-sidecar');
  await startDesktopDev();
  let model = null;
  if (RUN_REAL_CHAT) {
    const capabilities = await verifyHealthAndModels();
    model = pickRealChatModel(capabilities.models, capabilities.keyStatus);
    if (!model) {
      fail('no enabled real chat model with an available Keychain key', {
        model_count: capabilities.models.length,
        key_status: capabilities.keyStatus,
      });
    }
  }
  const journey = await runUiJourney(model);
  const summary = {
    ok: true,
    artifact_dir: ARTIFACT_DIR,
    duration_ms: Date.now() - startedAt,
    startup: state,
    mode: RUN_REAL_CHAT ? 'real_chat' : 'ui_only',
    keychain_mode: RUN_REAL_CHAT ? 'keychain' : 'dev_file',
    journey: RUN_REAL_CHAT ? {
      conversation_id: journey.imported_conversation.id,
      model: journey.model,
      latest_run: journey.latest_run
        ? {
            id: journey.latest_run.id,
            kind: journey.latest_run.kind,
            status: journey.latest_run.status,
            event_count: journey.latest_run.event_count,
          }
        : null,
      event_kinds: journey.event_kinds,
      current_conversation_calls: journey.realtime?.current_conversation_calls,
    } : {
      conversation_id: journey.imported_conversation.id,
      imported_message_count: journey.message_count,
    },
  };
  writeJsonArtifact('summary.json', summary);
  log(`桌面 UI smoke 验证通过：${ARTIFACT_DIR}`);
}

main()
  .catch((e) => {
    const failure = {
      ok: false,
      message: e instanceof Error ? e.message : String(e),
      details: e?.details ?? null,
      startup: state,
      artifact_dir: ARTIFACT_DIR,
    };
    writeJsonArtifact('failure.json', failure);
    console.error(`桌面 UI smoke 验证失败：${failure.message}`);
    console.error(`artifacts: ${ARTIFACT_DIR}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await stopDesktopDev().catch((e) => {
      console.error(`停止桌面 dev 失败：${e instanceof Error ? e.message : String(e)}`);
    });
    await verifyNoListeners().catch((e) => {
      console.error(`端口清理检查失败：${e instanceof Error ? e.message : String(e)}`);
      if (process.exitCode == null) process.exitCode = 1;
    });
    desktopLog.end();
  });
