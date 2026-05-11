/**
 * Fastify HTTP server: Renderer ↔ Sidecar.
 *
 * M0 endpoints:
 *   GET  /health                — liveness + control-channel probe
 *   POST /v1/chat               — streaming chat (mock provider in M0)
 *
 * All non-/health endpoints require Authorization: Bearer <SIDECAR_BEARER>.
 * Server bind host comes from runtime config; desktop keeps 127.0.0.1 while
 * standalone CLI can opt into remote-safe addresses like 0.0.0.0.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import { TaoriError, ERROR_HTTP_STATUS } from '@taori/shared';
import { type SidecarConfig } from './config.js';
import { type Db } from './db/index.js';
import { type ControlClient } from './control/client.js';
import { type KeyStore } from './keystore.js';
import { registerHealthRoute } from './routes/health.js';
import { registerSelfCheckRoute } from './routes/selfcheck.js';
import { registerChatRoute } from './routes/chat.js';
import { registerProvidersRoute } from './routes/providers.js';
import { registerModelsRoute } from './routes/models.js';
import { registerCostsRoute } from './routes/costs.js';
import { registerMemoriesRoute } from './routes/memories.js';
import { registerConversationsRoute } from './routes/conversations.js';
import { registerFilesRoute } from './routes/files.js';
import { registerAdminRoute } from './routes/admin.js';
import { registerToolsRoute, toolEnabledKey } from './routes/tools.js';
import { registerRoundtableRoute } from './routes/roundtable.js';
import { registerQuickCompareRoute } from './routes/quick-compare.js';
import { registerCatalogRoute } from './routes/catalog.js';
import { registerMcpRoute, restoreMcpToolsAtStartup } from './routes/mcp.js';
import { registerDiagnosticsRoute } from './routes/diagnostics.js';
import { closeAllMcpSessions } from './mcp/client.js';
import type { MemoryProvider } from './memory/provider.js';
import { registerTemplatesPersonasRoute } from './routes/templates-personas.js';
import { registerWorkflowRecipesRoute } from './routes/workflow-recipes.js';
import { scheduleCatalogSync } from './catalog/index.js';
import { CapabilityBus } from './bus/index.js';
import { createFileReadTool } from './bus/builtins/file_read.js';
import { createFileSearchTool } from './bus/builtins/file_search.js';
import { createImageGenerateTool } from './bus/builtins/image_generate.js';
import { createWebFetchTool, createWebFetchToolWithDeps } from './bus/builtins/web_fetch.js';
import { createWebSearchTool, createWebSearchToolWithDeps } from './bus/builtins/web_search.js';
import { CostsRepo, FilesRepo, FileChunksRepo, ProvidersRepo, ModelsRepo, MessagesRepo, ConversationsRepo, MemoriesRepo } from './db/repos/index.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BuildServerArgs {
  config: SidecarConfig;
  db: Db;
  control: ControlClient;
  keystore: KeyStore;
  startedAt: number;
  /**
   * Optional: when provided, the chat route gets access to the capability
   * bus and can offer LLM-side `image_generate` tool calls (M2.5 §F-CR).
   * Defaults to undefined for legacy callers + existing tests.
   */
  bus?: CapabilityBus;
  memoryProvider?: MemoryProvider;
}

export function buildServer(args: BuildServerArgs): FastifyInstance {
  const standaloneWeb = resolveStandaloneWebAssets(args.config);
  const standaloneCookieName = 'taori_standalone_session';
  const standaloneSessionSecret = randomBytes(32).toString('hex');
  const standalonePassword = args.config.standalone ? args.config.standaloneAccessPassword : null;
  const standaloneLoginEnabled = Boolean(standaloneWeb && standalonePassword);

  const app = Fastify({
    // Chat requests can include image attachments as base64. Generated images
    // sent back into vision models commonly exceed Fastify's 1MB default, so
    // align the parser cap with ChatRequest's 20MB aggregate validation.
    bodyLimit: 25_000_000,
    logger: {
      level: args.config.isDev ? 'info' : 'warn',
      // Sidecar logs go to stderr so stdout stays clean for the READY line.
      transport: undefined,
      stream: process.stderr,
      // Hard-coded redaction rules. Never log Authorization headers, Keys, or URL queries.
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers["x-api-key"]',
          'res.headers.authorization',
          '*.api_key',
          '*.apiKey',
          '*.secret',
        ],
        censor: '[REDACTED]',
      },
    },
  });

  app.register(cors, {
    origin: (origin, cb) => {
      if (args.config.standalone && !origin) return cb(null, true);
      // Renderer either calls from http://localhost:5173 (vite dev) or
      // tauri://localhost / asset protocol. Allow all localhost origins.
      if (!origin) return cb(null, true);
      const ok =
        /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin) ||
        origin === 'tauri://localhost' ||
        origin.startsWith('http://tauri.localhost');
      cb(null, ok);
    },
    credentials: true,
  });

  const loginPage = standaloneWeb ? fs.readFileSync(path.join(standaloneWeb, 'index.html'), 'utf8') : null;
  const staticAssetPrefixes = standaloneWeb ? ['/assets/', '/favicon', '/taori-browser-boot.js'] : [];

  function isStandaloneHtmlRequest(req: { method: string; headers: Record<string, unknown>; url: string }): boolean {
    if (!standaloneWeb) return false;
    if (req.method !== 'GET') return false;
    if (req.url.startsWith('/v1/') || req.url === '/health') return false;
    if (req.url.startsWith('/api/standalone-auth/')) return false;
    return !staticAssetPrefixes.some((prefix) => req.url.startsWith(prefix));
  }

  function parseCookies(headerValue: string | undefined): Map<string, string> {
    const cookies = new Map<string, string>();
    if (!headerValue) return cookies;
    for (const part of headerValue.split(';')) {
      const index = part.indexOf('=');
      if (index <= 0) continue;
      const key = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();
      cookies.set(key, decodeURIComponent(value));
    }
    return cookies;
  }

  function signStandaloneSession(payload: string): string {
    return createHash('sha256').update(`${standaloneSessionSecret}:${payload}`).digest('hex');
  }

  function makeStandaloneSessionCookie(): string {
    const issuedAt = String(Date.now());
    const nonce = randomBytes(12).toString('hex');
    const payload = `${issuedAt}.${nonce}`;
    const signature = signStandaloneSession(payload);
    return `${payload}.${signature}`;
  }

  function verifyStandaloneSessionCookie(value: string | undefined): boolean {
    if (!value) return false;
    const parts = value.split('.');
    if (parts.length !== 3) return false;
    const payload = `${parts[0]}.${parts[1]}`;
    const actual = parts[2] ?? '';
    const expected = signStandaloneSession(payload);
    const actualBuf = Buffer.from(actual, 'utf8');
    const expectedBuf = Buffer.from(expected, 'utf8');
    return actualBuf.length === expectedBuf.length && timingSafeEqual(actualBuf, expectedBuf);
  }

  function setStandaloneSessionCookie(reply: { header: (name: string, value: string) => void }): void {
    reply.header(
      'Set-Cookie',
      `${standaloneCookieName}=${encodeURIComponent(makeStandaloneSessionCookie())}; Path=/; HttpOnly; SameSite=Lax`,
    );
  }

  function clearStandaloneSessionCookie(reply: { header: (name: string, value: string) => void }): void {
    reply.header(
      'Set-Cookie',
      `${standaloneCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
    );
  }

  function standaloneAuthorizedByCookie(req: { headers: Record<string, unknown> }): boolean {
    if (!standaloneLoginEnabled) return false;
    const cookieHeader = typeof req.headers.cookie === 'string' ? req.headers.cookie : undefined;
    const cookies = parseCookies(cookieHeader);
    return verifyStandaloneSessionCookie(cookies.get(standaloneCookieName));
  }

  function standaloneLoginResponse(args: { authenticated: boolean; bindUrl: string | null; localUrl: string | null }): string {
    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Taori 登录</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #0d1423;
      --bg2: #132033;
      --card: rgba(255,255,255,0.08);
      --card-border: rgba(255,255,255,0.14);
      --fg: #f8fafc;
      --muted: #cbd5e1;
      --accent: #59c3c3;
      --accent2: #f97316;
      --bad: #f87171;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', sans-serif;
      background:
        radial-gradient(900px 500px at 10% 0%, rgba(89,195,195,0.24), transparent 55%),
        radial-gradient(1000px 640px at 100% 100%, rgba(249,115,22,0.18), transparent 60%),
        linear-gradient(160deg, var(--bg) 0%, var(--bg2) 100%);
      color: var(--fg);
      display: grid;
      place-items: center;
      padding: 24px;
    }
    .shell {
      width: min(480px, 100%);
      padding: 28px;
      border-radius: 24px;
      background: var(--card);
      border: 1px solid var(--card-border);
      backdrop-filter: blur(18px);
      box-shadow: 0 24px 60px rgba(0,0,0,0.35);
    }
    h1 { margin: 0 0 10px; font-size: 30px; }
    p { margin: 0 0 16px; color: var(--muted); line-height: 1.6; }
    form { display: grid; gap: 12px; margin-top: 18px; }
    input {
      width: 100%;
      border: 1px solid rgba(255,255,255,0.12);
      background: rgba(15,23,42,0.4);
      color: var(--fg);
      border-radius: 14px;
      padding: 14px 16px;
      font-size: 15px;
    }
    button {
      border: 0;
      border-radius: 14px;
      padding: 14px 16px;
      font-weight: 600;
      font-size: 15px;
      color: #08111f;
      background: linear-gradient(135deg, var(--accent) 0%, #8be9d0 100%);
      cursor: pointer;
    }
    .meta {
      margin-top: 18px;
      padding-top: 16px;
      border-top: 1px solid rgba(255,255,255,0.12);
      font-size: 13px;
      color: var(--muted);
      display: grid;
      gap: 6px;
    }
    .error {
      display: none;
      margin-top: 10px;
      color: var(--bad);
      font-size: 14px;
    }
    .hint {
      margin-top: 12px;
      font-size: 13px;
      color: var(--muted);
    }
    .ready {
      display: ${args.authenticated ? 'block' : 'none'};
      margin-top: 14px;
      color: #8be9d0;
      font-size: 14px;
    }
  </style>
</head>
<body>
  <div class="shell">
    <h1>Taori Browser Access</h1>
    <p>这是 Taori standalone 的浏览器入口。输入启动服务时设置的访问密码后，即可进入完整 Web 界面。</p>
    <form id="login-form" ${args.authenticated ? 'style="display:none"' : ''}>
      <input id="password" name="password" type="password" placeholder="输入访问密码" autocomplete="current-password" required />
      <button type="submit">登录 Taori</button>
    </form>
    <div class="ready" id="ready-box">已验证，正在进入 Taori…</div>
    <div class="error" id="login-error"></div>
    <div class="hint">脚本和自动化仍可继续使用 Bearer Token 访问 API；浏览器访问建议使用这个登录页。</div>
    <div class="meta">
      ${args.bindUrl ? `<div>Bind: ${escapeHtml(args.bindUrl)}</div>` : ''}
      ${args.localUrl ? `<div>Local: ${escapeHtml(args.localUrl)}</div>` : ''}
      <div>Health: <a href="/health" style="color:#8be9d0">/health</a></div>
    </div>
  </div>
  <script>
    const form = document.getElementById('login-form');
    const errorBox = document.getElementById('login-error');
    const readyBox = document.getElementById('ready-box');
    async function goApp() {
      window.location.replace('/app');
    }
    if (${JSON.stringify(args.authenticated)}) {
      goApp();
    }
    form?.addEventListener('submit', async (event) => {
      event.preventDefault();
      errorBox.style.display = 'none';
      const password = document.getElementById('password').value;
      const response = await fetch('/api/standalone-auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ password })
      });
      if (!response.ok) {
        let message = '登录失败，请检查密码。';
        try {
          const body = await response.json();
          if (body && typeof body.message === 'string') message = body.message;
        } catch {}
        errorBox.textContent = message;
        errorBox.style.display = 'block';
        return;
      }
      readyBox.style.display = 'block';
      goApp();
    });
  </script>
</body>
</html>`;
  }

  function standaloneBrowserDisabledResponse(args: { bindUrl: string | null; localUrl: string | null }): string {
    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Taori 浏览器入口未启用</title>
  <style>
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
      font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', sans-serif;
      background: linear-gradient(160deg, #0f172a 0%, #111827 100%);
      color: #f8fafc;
    }
    .card {
      width: min(560px, 100%);
      padding: 28px;
      border-radius: 22px;
      background: rgba(255,255,255,0.08);
      border: 1px solid rgba(255,255,255,0.12);
    }
    h1 { margin: 0 0 12px; font-size: 28px; }
    p, li { color: #cbd5e1; line-height: 1.7; }
    code { color: #8be9d0; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Taori 浏览器入口未启用</h1>
    <p>当前 standalone 已启动，但你没有设置 <code>--password</code>，所以浏览器 Web UI 登录入口不会开放。</p>
    <p>重新启动示例：</p>
    <p><code>taori --host 0.0.0.0 --port 4101 --password my-secret</code></p>
    <p>你仍然可以直接使用：</p>
    <ul>
      <li><code>/health</code> 做探活</li>
      <li>带 Bearer 的 API 调用做自动化访问</li>
    </ul>
    <p>Bind: ${escapeHtml(args.bindUrl ?? 'n/a')}</p>
    <p>Local: ${escapeHtml(args.localUrl ?? 'n/a')}</p>
  </div>
</body>
</html>`;
  }

  // Bearer auth (skip /health for liveness probes). Uses constant-time
  // comparison to defeat timing-based token recovery against this localhost
  // service. See docs/architecture/05-security.md.
  const expectedAuth = `Bearer ${args.config.bearer}`;
  const expectedBuf = Buffer.from(expectedAuth, 'utf8');
  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/health') return;
    if (standaloneLoginEnabled && req.url === '/api/standalone-auth/session') return;
    if (standaloneLoginEnabled && req.url === '/api/standalone-auth/login') return;
    if (standaloneLoginEnabled && req.url === '/api/standalone-auth/logout') return;
    if (standaloneWeb && staticAssetPrefixes.some((prefix) => req.url.startsWith(prefix))) return;
    if (isStandaloneHtmlRequest(req)) {
      if (standaloneWeb && !standaloneLoginEnabled) {
        reply
          .type('text/html; charset=utf-8')
          .send(
            standaloneBrowserDisabledResponse({
              bindUrl: formatStandaloneBindUrl(args.config),
              localUrl: formatStandaloneLocalUrl(args.config),
            }),
          );
        return;
      }
      if (!standaloneLoginEnabled || standaloneAuthorizedByCookie(req)) return;
      reply
        .type('text/html; charset=utf-8')
        .send(
          standaloneLoginResponse({
            authenticated: false,
            bindUrl: formatStandaloneBindUrl(args.config),
            localUrl: formatStandaloneLocalUrl(args.config),
          }),
        );
      return;
    }
    const auth = req.headers.authorization ?? '';
    const authBuf = Buffer.from(auth, 'utf8');
    const ok =
      authBuf.length === expectedBuf.length &&
      timingSafeEqual(authBuf, expectedBuf);
    if (!ok && standaloneAuthorizedByCookie(req)) {
      return;
    }
    if (!ok) {
      reply.code(ERROR_HTTP_STATUS.unauthorized).send({
        code: 'unauthorized',
        message: 'Missing or invalid bearer token',
      });
    }
  });

  // Centralized error formatting.
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof TaoriError) {
      reply.code(ERROR_HTTP_STATUS[err.code]).send(err.toBody());
      return;
    }
    if (err.validation) {
      reply.code(ERROR_HTTP_STATUS.validation_error).send({
        code: 'validation_error',
        message: err.message,
      });
      return;
    }
    if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      reply.code(ERROR_HTTP_STATUS.validation_error).send({
        code: 'validation_error',
        message: '请求体过大：图片或附件总大小不能超过 20MB（base64）',
      });
      return;
    }
    app.log.error({ err }, 'Unhandled error');
    reply.code(ERROR_HTTP_STATUS.internal).send({
      code: 'internal',
      message: 'Internal server error',
    });
  });

  registerHealthRoute(app, args);
  if (standaloneLoginEnabled) {
    app.get('/api/standalone-auth/session', async (req, reply) => {
      return {
        ok: true as const,
        authenticated: standaloneAuthorizedByCookie(req),
      };
    });
    app.post('/api/standalone-auth/login', async (req, reply) => {
      const body = (req.body ?? {}) as { password?: unknown };
      const password = typeof body.password === 'string' ? body.password : '';
      if (!standalonePassword || password !== standalonePassword) {
        reply.code(ERROR_HTTP_STATUS.unauthorized).send({
          code: 'unauthorized',
          message: '密码错误，请重试。',
        });
        return;
      }
      setStandaloneSessionCookie(reply);
      return { ok: true as const };
    });
    app.post('/api/standalone-auth/logout', async (_req, reply) => {
      clearStandaloneSessionCookie(reply);
      return { ok: true as const };
    });
  }
  if (standaloneWeb) {
    app.get('/app', async (req, reply) => {
      if (!standaloneLoginEnabled) {
        reply
          .type('text/html; charset=utf-8')
          .send(
            standaloneBrowserDisabledResponse({
              bindUrl: formatStandaloneBindUrl(args.config),
              localUrl: formatStandaloneLocalUrl(args.config),
            }),
          );
        return;
      }
      if (standaloneLoginEnabled && !standaloneAuthorizedByCookie(req)) {
        reply.redirect('/');
        return;
      }
      reply.type('text/html; charset=utf-8').send(loginPage ?? '');
    });
    app.get('/', async (req, reply) => {
      if (!standaloneLoginEnabled) {
        reply
          .type('text/html; charset=utf-8')
          .send(
            standaloneBrowserDisabledResponse({
              bindUrl: formatStandaloneBindUrl(args.config),
              localUrl: formatStandaloneLocalUrl(args.config),
            }),
          );
        return;
      }
      if (standaloneLoginEnabled && !standaloneAuthorizedByCookie(req)) {
        reply
          .type('text/html; charset=utf-8')
          .send(
            standaloneLoginResponse({
              authenticated: false,
              bindUrl: formatStandaloneBindUrl(args.config),
              localUrl: formatStandaloneLocalUrl(args.config),
            }),
          );
        return;
      }
      reply.redirect('/app');
    });
    app.get('/*', async (req, reply) => {
      if (!standaloneWeb) return;
      const requested = req.url.split('?')[0] || '/';
      if (requested.startsWith('/v1/') || requested.startsWith('/api/standalone-auth/') || requested === '/health') {
        return;
      }
      const assetPath = requested === '/' ? '/index.html' : requested;
      const diskPath = path.join(standaloneWeb, assetPath.replace(/^\/+/, ''));
      if (fs.existsSync(diskPath) && fs.statSync(diskPath).isFile()) {
        reply.type(contentTypeForAsset(diskPath)).send(fs.readFileSync(diskPath));
        return;
      }
      if (!standaloneLoginEnabled) {
        reply
          .type('text/html; charset=utf-8')
          .send(
            standaloneBrowserDisabledResponse({
              bindUrl: formatStandaloneBindUrl(args.config),
              localUrl: formatStandaloneLocalUrl(args.config),
            }),
          );
        return;
      }
      if (standaloneLoginEnabled && !standaloneAuthorizedByCookie(req)) {
        reply
          .type('text/html; charset=utf-8')
          .send(
            standaloneLoginResponse({
              authenticated: false,
              bindUrl: formatStandaloneBindUrl(args.config),
              localUrl: formatStandaloneLocalUrl(args.config),
            }),
          );
        return;
      }
      reply.type('text/html; charset=utf-8').send(loginPage ?? '');
    });
  }
  registerSelfCheckRoute(app, args);

  // M2.3 — Capability Bus + builtin tools (created BEFORE chat so the chat
  // route can attach `image_generate` as an LLM tool — M2.5 §F-CR / batch A2).
  const costs = new CostsRepo(args.db);
  const files = new FilesRepo(args.db);
  const fileChunks = new FileChunksRepo(args.db);
  const memories = new MemoriesRepo(args.db);
  const bus = args.bus ?? new CapabilityBus(costs);
  if (!args.bus) {
    bus.register(createFileReadTool(files));
    bus.register(createFileSearchTool({ filesRepo: files, chunksRepo: fileChunks }));
    if (process.env.TAORI_E2E_HERMETIC_WEB === '1') {
      bus.register(createWebSearchToolWithDeps({ fetch: hermeticWebFetch }));
      bus.register(createWebFetchToolWithDeps({ fetch: hermeticWebFetch }));
    } else {
      bus.register(createWebSearchTool());
      bus.register(createWebFetchTool());
    }
    const filesDir = path.join(path.dirname(args.config.dbPath), 'files');
    bus.register(
      createImageGenerateTool({
        models: new ModelsRepo(args.db),
        providers: new ProvidersRepo(args.db),
        files,
        messages: new MessagesRepo(args.db),
        conversations: new ConversationsRepo(args.db),
        memories,
        keystore: args.keystore,
        filesDir,
      }),
    );
  }
  void restoreMcpToolsAtStartup({ db: args.db, bus, config: args.config, log: app.log });
  for (const tool of bus.list()) {
    const persisted = memories.get('global', null, toolEnabledKey(tool.name));
    if (persisted === 'true' || persisted === 'false') {
      bus.setEnabled(tool.name, persisted === 'true');
    }
  }

  const argsWithBus = { ...args, bus };
  app.addHook('onClose', async () => {
    closeAllMcpSessions();
  });
  registerChatRoute(app, argsWithBus);
  registerProvidersRoute(app, { ...argsWithBus, keystore: args.keystore });
  registerModelsRoute(app, argsWithBus);
  registerCostsRoute(app, argsWithBus);
  registerMemoriesRoute(app, argsWithBus);
  registerFilesRoute(app, argsWithBus);
  registerConversationsRoute(app, argsWithBus);
  registerAdminRoute(app, argsWithBus);
  registerTemplatesPersonasRoute(app, argsWithBus);
  registerWorkflowRecipesRoute(app, argsWithBus);

  registerToolsRoute(app, { bus, memories, costs });
  registerMcpRoute(app, { ...argsWithBus, bus });
  registerRoundtableRoute(app, argsWithBus);
  registerQuickCompareRoute(app, argsWithBus);
  registerCatalogRoute(app, { ...argsWithBus, keystore: args.keystore });
  registerDiagnosticsRoute(app, argsWithBus);

  return app;
}

function resolveStandaloneWebAssets(config: SidecarConfig): string | null {
  if (!config.standalone) return null;
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // npm global install: <prefix>/lib/node_modules/@chenpu17/taori/dist/cli.cjs → ../dist-web
    path.resolve(currentDir, '..', 'dist-web'),
    path.resolve(currentDir, '..', '..', '..', 'packages', 'npm', 'dist-web'),
    path.resolve(process.cwd(), 'packages', 'npm', 'dist-web'),
    path.resolve(process.cwd(), 'dist-web'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'index.html'))) {
      return candidate;
    }
  }
  return null;
}

function contentTypeForAsset(filePath: string): string {
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.svg')) return 'image/svg+xml';
  if (filePath.endsWith('.png')) return 'image/png';
  if (filePath.endsWith('.jpg') || filePath.endsWith('.jpeg')) return 'image/jpeg';
  if (filePath.endsWith('.webp')) return 'image/webp';
  if (filePath.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'text/html; charset=utf-8';
}

function formatStandaloneBindUrl(config: SidecarConfig): string | null {
  if (!config.standalone) return null;
  const host = config.host || '127.0.0.1';
  return `http://${host}:${config.port}`;
}

function formatStandaloneLocalUrl(config: SidecarConfig): string | null {
  if (!config.standalone) return null;
  const host = config.host === '0.0.0.0' ? '127.0.0.1' : config.host || '127.0.0.1';
  return `http://${host}:${config.port}`;
}

async function hermeticWebFetch(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<Response> {
  const rawUrl = input instanceof Request ? input.url : String(input);
  const url = new URL(rawUrl);
  if (url.hostname === 'html.duckduckgo.com') {
    const q = url.searchParams.get('q') ?? 'Taori';
    return new Response(
      `<!doctype html><html><body>
        <a class="result__a" href="https://example.com/taori">Taori 多模型助手</a>
        <a class="result__snippet">关于 ${escapeHtml(q)} 的测试搜索结果。</a>
        <a class="result__a" href="https://example.com/runtime">Agent Runtime</a>
        <a class="result__snippet">用于 E2E 的可控网页搜索材料。</a>
      </body></html>`,
      { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
    );
  }
  if (url.hostname === 'example.com') {
    return new Response(
      `<!doctype html><html><head><title>Example Domain</title></head><body>
        <h1>Example Domain</h1>
        <p>This page is a deterministic Taori E2E fixture for web_fetch.</p>
      </body></html>`,
      { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
    );
  }
  return fetch(input, init);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
