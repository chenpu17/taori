#!/usr/bin/env node
/**
 * Desktop smoke for the Tauri shell.
 *
 * This script intentionally starts the real desktop dev stack instead of using
 * Playwright's isolated web e2e sidecar:
 *   - Tauri Rust process owns the control channel.
 *   - Rust launches the built Node sidecar through TAORI_DEV_SIDECAR_CMD.
 *   - The renderer obtains its endpoint through the Tauri invoke path.
 *
 * It verifies the desktop-only plumbing through logs plus sidecar APIs, then
 * shuts everything down and writes diagnostics under /tmp. By default it uses
 * the dev_file keystore to avoid macOS Keychain prompts; Keychain and real chat
 * paths are explicit opt-in.
 */
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUN_ID = `desktop-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
const ARTIFACT_DIR =
  process.env.TAORI_DESKTOP_SMOKE_OUT ??
  path.join('/tmp', `taori-desktop-smoke-${RUN_ID}`);
const SIDECAR_PORT = Number(process.env.TAORI_DESKTOP_SMOKE_SIDECAR_PORT ?? 17890);
const VITE_PORT = Number(process.env.TAORI_DESKTOP_SMOKE_VITE_PORT ?? 5173);
const BEARER =
  process.env.TAORI_DESKTOP_SMOKE_BEARER ??
  `taori_desktop_smoke_${Date.now()}_${Math.random().toString(36).slice(2)}`;
const SIDECAR_URL = `http://127.0.0.1:${SIDECAR_PORT}`;
const START_TIMEOUT_MS = Number(process.env.TAORI_DESKTOP_SMOKE_START_TIMEOUT_MS ?? 45_000);
const REAL_CHAT_TIMEOUT_MS = Number(process.env.TAORI_DESKTOP_SMOKE_CHAT_TIMEOUT_MS ?? 150_000);
const KEYCHAIN_TIMEOUT_MS = Number(process.env.TAORI_DESKTOP_SMOKE_KEYCHAIN_TIMEOUT_MS ?? 120_000);
const RUN_KEYCHAIN = process.env.TAORI_DESKTOP_SMOKE_KEYCHAIN === '1';
const RUN_REAL_CHAT = process.env.TAORI_DESKTOP_SMOKE_REAL_CHAT === '1';

fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
const desktopLogPath = artifactPath('desktop-dev.log');
const desktopLog = fs.createWriteStream(desktopLogPath, { flags: 'a' });

let desktopProc = null;
const state = {
  viteReady: false,
  controlReady: false,
  sidecarReady: false,
  controlConfigured: false,
  rendererHealth: false,
  rendererProviders: false,
  rendererModels: false,
  rendererTools: false,
  controlUrl: null,
  sidecarUrl: null,
};

function log(message) {
  process.stdout.write(`${message}\n`);
}

function artifactPath(name) {
  return path.join(ARTIFACT_DIR, name);
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
    const { stdout } = await execFileText('lsof', [
      '-nP',
      `-iTCP:${port}`,
      '-sTCP:LISTEN',
    ]);
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
  if (listeners) {
    fail(`${label} port ${port} is already in use`, { port, listeners });
  }
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
      TAORI_DESKTOP_DEV_KEYSTORE: RUN_KEYCHAIN || RUN_REAL_CHAT ? 'keychain' : 'dev_file',
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
      state.sidecarReady &&
      state.controlConfigured &&
      state.rendererHealth &&
      state.rendererProviders &&
      state.rendererModels &&
      state.rendererTools
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
  fail('timed out waiting for desktop dev startup checks', { state });
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

async function postJson(route, body, timeoutMs = 30_000) {
  return jsonFetch(
    route,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    timeoutMs,
  );
}

async function patchJson(route, body, timeoutMs = 30_000) {
  return jsonFetch(
    route,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    timeoutMs,
  );
}

async function verifyHealthAndModels() {
  const [health, providers, models] = await Promise.all([
    jsonFetch('/health'),
    jsonFetch('/v1/providers'),
    jsonFetch('/v1/models'),
  ]);
  writeJsonArtifact('health.json', health);
  writeJsonArtifact('providers.json', providers);
  writeJsonArtifact('models.json', models);

  if (health.control_channel === 'unknown') fail('desktop sidecar control channel is not configured', { health });
  return { health, providers: providers.providers ?? [], keyStatus: [], models: models.models ?? [] };
}

async function verifyKeychain() {
  let selfcheck;
  let providers;
  let keyStatus;
  try {
    selfcheck = await jsonFetch('/v1/selfcheck?include_keychain=1', {}, KEYCHAIN_TIMEOUT_MS);
    providers = await jsonFetch('/v1/providers');
    keyStatus = await jsonFetch('/v1/providers/key-status?confirm_keychain=1', {}, KEYCHAIN_TIMEOUT_MS);
  } catch (e) {
    fail('explicit desktop Keychain check failed or was not authorized in time', {
      message: e instanceof Error ? e.message : String(e),
      timeout_ms: KEYCHAIN_TIMEOUT_MS,
      note: 'This path is opt-in because macOS may show system authorization prompts for Keychain reads/writes.',
    });
  }
  writeJsonArtifact('selfcheck.json', selfcheck);
  writeJsonArtifact('provider-key-status.json', keyStatus);
  const failedChecks = (selfcheck.checks ?? []).filter((item) => !item.ok);
  if (!selfcheck.ok || failedChecks.length > 0) {
    fail('desktop selfcheck failed', { selfcheck, failedChecks });
  }
  const keyByProvider = new Map((keyStatus.statuses ?? []).map((s) => [s.provider_id, s.key_available]));
  const missingKeys = (providers.providers ?? [])
    .filter((p) => p.enabled && p.api_key_ref && keyByProvider.get(p.id) !== true)
    .map((p) => ({ id: p.id, name: p.name, type: p.type }));
  if (missingKeys.length > 0) {
    fail('enabled providers have missing Keychain entries', { missingKeys });
  }
  return { selfcheck, keyStatus: keyStatus.statuses ?? [] };
}

async function importBackupProbe() {
  const now = Date.now();
  const conversationId = `conv_desktop_smoke_import_${now}`;
  const title = `Desktop Smoke Imported ${now}`;
  const backup = {
    format_version: 'taori-backup-v1',
    exported_at: now,
    app_version: '0.0.0-desktop-smoke',
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
          id: `msg_desktop_smoke_import_${now}`,
          conversation_id: conversationId,
          role: 'assistant',
          content: 'Desktop smoke imported content',
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
  };
  const imported = await postJson('/v1/admin/import-data', { strategy: 'rename', backup });
  const conversations = await jsonFetch('/v1/conversations');
  const found = (conversations.conversations ?? []).find((item) => item.title === title);
  const result = {
    title,
    requested_conversation_id: conversationId,
    imported,
    found_conversation: found ? { id: found.id, title: found.title } : null,
  };
  writeJsonArtifact('backup-import.json', result);
  if (!found) fail('imported backup conversation is not visible in conversation list', result);
  return result;
}

function isRunnableModel(model, keyByProvider) {
  if (!model.enabled) return false;
  if (model.disabled_until && model.disabled_until > Date.now()) return false;
  if (!model.provider_id) return false;
  return keyByProvider.size === 0 || keyByProvider.get(model.provider_id) !== false;
}

function pickRealChatModel(models, keyStatus) {
  const explicitId = process.env.TAORI_DESKTOP_SMOKE_MODEL_ID;
  const keyByProvider = new Map(keyStatus.map((s) => [s.provider_id, s.key_available]));
  const runnable = models.filter(
    (m) =>
      isRunnableModel(m, keyByProvider) &&
      (m.capability === 'chat' || m.capability === 'multimodal'),
  );
  if (explicitId) {
    const explicit = runnable.find((m) => m.id === explicitId);
    if (!explicit) {
      fail('TAORI_DESKTOP_SMOKE_MODEL_ID is not an enabled real chat model with a Keychain key', {
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

function parseConversationIdFromDataStream(text) {
  for (const line of text.split('\n')) {
    if (!line.startsWith('8:')) continue;
    try {
      const arr = JSON.parse(line.slice(2));
      for (const item of arr) {
        if (item?.type === 'meta' && typeof item.conversation_id === 'string') {
          return item.conversation_id;
        }
      }
    } catch {
      // Continue scanning.
    }
  }
  return null;
}

async function verifyRealChat(models, keyStatus) {
  const model = pickRealChatModel(models, keyStatus);
  if (!model) {
    fail('no enabled real chat model with an available Keychain key', {
      model_count: models.length,
      key_status: keyStatus,
    });
  }
  const marker = `Desktop smoke real chat ${Date.now()}`;
  const res = await authedFetch(
    '/v1/chat',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model_id: model.id,
        messages: [
          {
            role: 'user',
            content: `${marker}. 请只用一句中文回复：桌面自动化 smoke 通过。`,
          },
        ],
      }),
    },
    REAL_CHAT_TIMEOUT_MS,
  );
  const streamText = await res.text();
  writeTextArtifact('real-chat-stream.txt', streamText);
  if (!res.ok) {
    fail('real desktop chat request failed', {
      status: res.status,
      model: { id: model.id, display_name: model.display_name, provider_id: model.provider_id },
      body: streamText.slice(0, 2000),
    });
  }
  const conversationId = parseConversationIdFromDataStream(streamText);
  if (!conversationId) fail('real chat stream did not include a conversation_id meta annotation');

  const [messages, runsBody, eventsBody, realtime, breakdown] = await Promise.all([
    jsonFetch(`/v1/conversations/${encodeURIComponent(conversationId)}/messages`),
    jsonFetch(`/v1/conversations/${encodeURIComponent(conversationId)}/runs?limit=5`),
    jsonFetch(`/v1/conversations/${encodeURIComponent(conversationId)}/run-events?limit=80`),
    jsonFetch(`/v1/costs/realtime?conversation_id=${encodeURIComponent(conversationId)}`),
    jsonFetch(`/v1/costs/breakdown?scope=session&conversation_id=${encodeURIComponent(conversationId)}`),
  ]);
  const assistant = (messages.messages ?? []).filter((m) => m.role === 'assistant').at(-1);
  const runs = runsBody.data?.runs ?? [];
  const events = eventsBody.data?.events ?? [];
  const eventKinds = new Set(events.map((e) => e.kind));
  const expectedKinds = [
    'turn.started',
    'context.snapshot',
    'model.started',
    'model.completed',
    'cost.recorded',
    'turn.completed',
  ];
  const missingKinds = expectedKinds.filter((kind) => !eventKinds.has(kind));
  const result = {
    model: {
      id: model.id,
      display_name: model.display_name,
      provider_id: model.provider_id,
    },
    conversation_id: conversationId,
    assistant: assistant
      ? {
          id: assistant.id,
          status: assistant.status,
          content_preview: assistant.content?.slice(0, 240),
        }
      : null,
    latest_run: runs[0] ?? null,
    event_kinds: [...eventKinds],
    realtime: realtime.data,
    breakdown: breakdown.data,
  };
  writeJsonArtifact('real-chat.json', result);
  writeJsonArtifact('real-chat-messages.json', messages);
  writeJsonArtifact('real-chat-runs.json', runsBody);
  writeJsonArtifact('real-chat-events.json', eventsBody);
  writeJsonArtifact('real-chat-costs.json', { realtime, breakdown });

  if (!assistant || assistant.status !== 'complete' || !assistant.content?.trim()) {
    fail('real chat did not persist a completed assistant message', result);
  }
  if (runs.length < 1 || runs[0].status !== 'completed') {
    fail('real chat did not produce a completed AgentRun', result);
  }
  if (missingKinds.length > 0) {
    fail('real chat run events are incomplete', { ...result, missingKinds });
  }
  if ((realtime.data?.current_conversation_calls ?? 0) < 1) {
    fail('real chat did not increment conversation cost calls', result);
  }
  const breakdownRows = breakdown.data?.rows ?? [];
  if (!breakdownRows.some((row) => row.count >= 1)) {
    fail('real chat did not produce a cost breakdown row', result);
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
    const [sidecar, vite] = await Promise.all([
      portListeners(SIDECAR_PORT),
      portListeners(VITE_PORT),
    ]);
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
    const [sidecar, vite] = await Promise.all([
      portListeners(SIDECAR_PORT),
      portListeners(VITE_PORT),
    ]);
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
  const [sidecar, vite] = await Promise.all([
    portListeners(SIDECAR_PORT),
    portListeners(VITE_PORT),
  ]);
  const result = { sidecar_port: SIDECAR_PORT, sidecar_listeners: sidecar, vite_port: VITE_PORT, vite_listeners: vite };
  writeJsonArtifact('port-cleanup.json', result);
  if (sidecar || vite) fail('desktop smoke left dev ports listening', result);
}

async function main() {
  const startedAt = Date.now();
  log(`桌面 smoke artifact: ${ARTIFACT_DIR}`);
  await assertPortFree(SIDECAR_PORT, 'sidecar');
  await assertPortFree(VITE_PORT, 'vite');
  await runCommandLogged('pnpm', ['build:sidecar'], 'build-sidecar');
  await startDesktopDev();
  const capabilities = await verifyHealthAndModels();
  if (RUN_KEYCHAIN) {
    const keychain = await verifyKeychain();
    capabilities.keyStatus = keychain.keyStatus;
  }
  const imported = await importBackupProbe();
  const realChat = RUN_REAL_CHAT
    ? await verifyRealChat(capabilities.models, capabilities.keyStatus)
    : null;
  const summary = {
    ok: true,
    artifact_dir: ARTIFACT_DIR,
    duration_ms: Date.now() - startedAt,
    startup: state,
    imported_conversation: imported.found_conversation,
    keychain_checked: RUN_KEYCHAIN,
    keychain_mode: RUN_KEYCHAIN || RUN_REAL_CHAT ? 'keychain' : 'dev_file',
    real_chat: realChat ? {
      conversation_id: realChat.conversation_id,
      model: realChat.model,
      latest_run: realChat.latest_run
        ? {
            id: realChat.latest_run.id,
            kind: realChat.latest_run.kind,
            status: realChat.latest_run.status,
            event_count: realChat.latest_run.event_count,
          }
        : null,
      event_kinds: realChat.event_kinds,
      current_conversation_calls: realChat.realtime?.current_conversation_calls,
    } : null,
  };
  writeJsonArtifact('summary.json', summary);
  log(`桌面 smoke 验证通过：${ARTIFACT_DIR}`);
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
    console.error(`桌面 smoke 验证失败：${failure.message}`);
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
