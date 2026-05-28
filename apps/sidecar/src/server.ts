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
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import { TaoriError, ERROR_HTTP_STATUS } from '@taori/shared';
import { normalizeSidecarConfig, type SidecarConfig, type SidecarConfigInput } from './config.js';
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
import { registerResearchRoute } from './routes/research.js';
import { ResearchRunner } from './research/task-runner.js';
import { scheduleCatalogSync } from './catalog/index.js';
import { CapabilityBus } from './bus/index.js';
import { createFileReadTool } from './bus/builtins/file_read.js';
import { createFileSearchTool } from './bus/builtins/file_search.js';
import { createImageGenerateTool } from './bus/builtins/image_generate.js';
import { createWebFetchTool, createWebFetchToolWithDeps } from './bus/builtins/web_fetch.js';
import { createWebSearchTool, createWebSearchToolWithDeps } from './bus/builtins/web_search.js';
import { buildRepos, type Repos } from './db/repos/index.js';
import { standaloneBrowserDisabledResponse, standaloneLoginResponse } from './standalone/login-page.js';
import path from 'node:path';

const BODY_LIMIT_BYTES = 25_000_000;

export interface BuildServerArgs {
  config: SidecarConfig;
  db: Db;
  repos: Repos;
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

type BuildServerInputArgs = Omit<BuildServerArgs, 'config' | 'repos'> & {
  config: SidecarConfigInput;
  repos?: Repos;
};

export function buildServer(input: BuildServerInputArgs): FastifyInstance {
  const config = normalizeSidecarConfig(input.config);
  const repos = input.repos ?? buildRepos(input.db);
  const args: BuildServerArgs = { ...input, config, repos };
  const standaloneWeb = resolveStandaloneWebAssets(args.config);
  const standaloneCookieName = 'taori_standalone_session';
  const standaloneSessionSecret = randomBytes(32).toString('hex');
  const standalonePassword = config.standalone ? config.standaloneAccessPassword : null;
  const standaloneLoginEnabled = Boolean(config.standalone && standalonePassword);

  const app = Fastify({
    // Chat requests can include image attachments as base64. Generated images
    // sent back into vision models commonly exceed Fastify's 1MB default, so
    // align the parser cap with ChatRequest's 20MB aggregate validation.
    bodyLimit: BODY_LIMIT_BYTES,
    logger: {
      level: config.isDev ? 'info' : 'warn',
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
      // Renderer either calls from http://localhost:5173 (vite dev) or
      // tauri://localhost / asset protocol. Allow all localhost origins.
      // CORS only matters for browser requests that carry an Origin header.
      // Non-browser callers (curl, SDKs, CLI) send no origin; allow them
      // through so Bearer auth is the sole gate.  Without this, curl/SDK
      // requests with a valid Bearer token get rejected by CORS before
      // the auth hook even runs.
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
    if (!config.standalone) return false;
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
      try {
        cookies.set(key, decodeURIComponent(value));
      } catch {
        cookies.set(key, value);
      }
    }
    return cookies;
  }

  const STANDALONE_SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

  function signStandaloneSession(payload: string): string {
    return createHmac('sha256', standaloneSessionSecret).update(payload).digest('hex');
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
    if (!constantTimeStringEqual(actual, expected)) return false;
    const issuedAt = Number(parts[0]);
    if (!Number.isFinite(issuedAt) || Date.now() - issuedAt > STANDALONE_SESSION_MAX_AGE_MS) return false;
    return true;
  }

  const STANDALONE_SESSION_COOKIE_MAX_AGE = 7 * 24 * 60 * 60; // 7 days, in seconds

  function setStandaloneSessionCookie(reply: { header: (name: string, value: string) => void }): void {
    reply.header(
      'Set-Cookie',
      `${standaloneCookieName}=${encodeURIComponent(makeStandaloneSessionCookie())}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${STANDALONE_SESSION_COOKIE_MAX_AGE}`,
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

  function isAllowedStandaloneOrigin(origin: string): boolean {
    return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)
      || origin === 'tauri://localhost'
      || origin.startsWith('http://tauri.localhost');
  }

  function authorizedByBearer(req: { headers: Record<string, unknown> }): boolean {
    const auth = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
    return constantTimeStringEqual(auth, expectedAuth);
  }

  function authorizedByCookie(req: { headers: Record<string, unknown> }): boolean {
    return standaloneAuthorizedByCookie(req);
  }

  // Bearer auth (skip /health for liveness probes). Uses constant-time
  // comparison to defeat timing-based token recovery against this localhost
  // service. See docs/architecture/05-security.md.
  const expectedAuth = `Bearer ${args.config.bearer}`;
  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/health') return;
    if (standaloneLoginEnabled && req.url === '/api/standalone-auth/session') return;
    if (standaloneLoginEnabled && req.url === '/api/standalone-auth/login') return;
    if (standaloneLoginEnabled && req.url === '/api/standalone-auth/logout') return;
    if (standaloneWeb && staticAssetPrefixes.some((prefix) => req.url.startsWith(prefix))) return;
    if (isStandaloneHtmlRequest(req)) {
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
      if (standaloneAuthorizedByCookie(req)) {
        if (standaloneWeb) return;
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
    const bearerOk = authorizedByBearer(req);
    const cookieOk = authorizedByCookie(req);
    if (!bearerOk && !cookieOk) {
      reply.code(ERROR_HTTP_STATUS.unauthorized).send({
        code: 'unauthorized',
        message: 'Missing or invalid bearer token',
      });
      return;
    }
    // CSRF mitigation: cookie-authenticated mutating requests must come from
    // an allowed origin. Bearer auth is immune because JS on another origin
    // cannot read or attach the Bearer header. SameSite=Lax already blocks
    // cross-site POST from simple form submissions, but this adds defense-in-
    // depth for any browser-initiated request that carries the session cookie.
    if (cookieOk && !bearerOk && req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
      const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
      if (!origin || !isAllowedStandaloneOrigin(origin)) {
        reply.code(403).send({ code: 'forbidden', message: 'Cross-origin request denied' });
        return;
      }
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
      const limitMb = Math.round(BODY_LIMIT_BYTES / 1_000_000);
      reply.code(ERROR_HTTP_STATUS.validation_error).send({
        code: 'validation_error',
        message: `请求体过大：图片或附件总大小不能超过 ${limitMb}MB（base64）`,
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
  const bus = args.bus ?? new CapabilityBus(repos.costs);
  if (!args.bus) {
    bus.register(createFileReadTool(repos.files));
    bus.register(createFileSearchTool({ filesRepo: repos.files, chunksRepo: repos.fileChunks }));
    if (args.config.testHooks.hermeticWeb) {
      bus.register(createWebSearchToolWithDeps({
        fetch: hermeticWebFetch,
        resolveConfig: (ctx) => ({
          engine: (repos.memories.getEffective(ctx.conversationId ?? null, 'builtin_web_search_engine') as 'duckduckgo' | 'exa' | 'bocha' | null) ?? 'duckduckgo',
          bochaApiKey: repos.memories.getEffective(ctx.conversationId ?? null, 'builtin_web_search_bocha_api_key'),
        }),
      }));
      bus.register(createWebFetchToolWithDeps({ fetch: hermeticWebFetch }));
    } else {
      bus.register(createWebSearchToolWithDeps({
        resolveConfig: (ctx) => ({
          engine: (repos.memories.getEffective(ctx.conversationId ?? null, 'builtin_web_search_engine') as 'duckduckgo' | 'exa' | 'bocha' | null) ?? 'duckduckgo',
          bochaApiKey: repos.memories.getEffective(ctx.conversationId ?? null, 'builtin_web_search_bocha_api_key'),
        }),
      }));
      bus.register(createWebFetchTool());
    }
    const filesDir = path.join(path.dirname(args.config.dbPath), 'files');
    bus.register(
      createImageGenerateTool({
        models: repos.models,
        providers: repos.providers,
        files: repos.files,
        messages: repos.messages,
        conversations: repos.conversations,
        memories: repos.memories,
        keystore: args.keystore,
        filesDir,
      }),
    );
  }
  void restoreMcpToolsAtStartup({ repos: repos.mcpServers, bus, config: args.config, log: app.log });
  for (const tool of bus.list()) {
    const persisted = repos.memories.get('global', null, toolEnabledKey(tool.name));
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
  const researchRunner = new ResearchRunner({
    repo: repos.research,
    bus,
    memories: repos.memories,
    modelsRepo: repos.models,
    providersRepo: repos.providers,
    keystore: args.keystore,
    testHooks: args.config.testHooks,
    log: app.log,
  });
  registerResearchRoute(app, { ...argsWithBus, researchRunner, keystore: args.keystore });

  registerToolsRoute(app, { bus, memories: repos.memories, costs: repos.costs, testHooks: args.config.testHooks });
  registerMcpRoute(app, { ...argsWithBus, bus });
  registerRoundtableRoute(app, argsWithBus);
  registerQuickCompareRoute(app, argsWithBus);
  registerCatalogRoute(app, { ...argsWithBus, keystore: args.keystore });
  registerDiagnosticsRoute(app, argsWithBus);

  return app;
}

function resolveStandaloneWebAssets(config: SidecarConfig): string | null {
  if (!config.standalone) return null;
  const runtimeEntrypoint =
    process.argv[1] && process.argv[1].trim()
      ? path.dirname(fs.realpathSync(process.argv[1]))
      : null;
  const candidates = [
    ...(runtimeEntrypoint
      ? [
          // npm global install resolves argv[1] through the bin symlink back to
          // <prefix>/node_modules/@chenpu17/taori/dist/cli.cjs, so ../dist-web
          // is the packaged Web UI location.
          path.resolve(runtimeEntrypoint, '..', 'dist-web'),
        ]
      : []),
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

function constantTimeStringEqual(actual: string, expected: string): boolean {
  const actualHash = createHash('sha256').update(actual, 'utf8').digest();
  const expectedHash = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(actualHash, expectedHash);
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
