/**
 * Fastify HTTP server: Renderer ↔ Sidecar.
 *
 * M0 endpoints:
 *   GET  /health                — liveness + control-channel probe
 *   POST /v1/chat               — streaming chat (mock provider in M0)
 *
 * All non-/health endpoints require Authorization: Bearer <SIDECAR_BEARER>.
 * Server only binds to 127.0.0.1.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { timingSafeEqual } from 'node:crypto';
import { TaoriError, ERROR_HTTP_STATUS } from '@taori/shared';
import { type SidecarConfig } from './config.js';
import { type Db } from './db/index.js';
import { type ControlClient } from './control/client.js';
import { type KeyStore } from './keystore.js';
import { registerHealthRoute } from './routes/health.js';
import { registerChatRoute } from './routes/chat.js';
import { registerProvidersRoute } from './routes/providers.js';
import { registerModelsRoute } from './routes/models.js';
import { registerCostsRoute } from './routes/costs.js';
import { registerMemoriesRoute } from './routes/memories.js';
import { registerConversationsRoute } from './routes/conversations.js';
import { registerAdminRoute } from './routes/admin.js';
import { registerToolsRoute } from './routes/tools.js';
import { CapabilityBus } from './bus/index.js';
import { createFileReadTool } from './bus/builtins/file_read.js';
import { createImageGenerateTool } from './bus/builtins/image_generate.js';
import { CostsRepo, FilesRepo, ProvidersRepo, ModelsRepo, MessagesRepo, ConversationsRepo } from './db/repos/index.js';
import path from 'node:path';

export interface BuildServerArgs {
  config: SidecarConfig;
  db: Db;
  control: ControlClient;
  keystore: KeyStore;
  startedAt: number;
}

export function buildServer(args: BuildServerArgs): FastifyInstance {
  const app = Fastify({
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
      // Renderer either calls from http://localhost:5173 (vite dev) or
      // tauri://localhost / asset protocol. Allow all localhost origins.
      if (!origin) return cb(null, true);
      const ok =
        /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin) ||
        origin === 'tauri://localhost' ||
        origin.startsWith('http://tauri.localhost');
      cb(null, ok);
    },
    credentials: false,
  });

  // Bearer auth (skip /health for liveness probes). Uses constant-time
  // comparison to defeat timing-based token recovery against this localhost
  // service. See docs/architecture/05-security.md.
  const expectedAuth = `Bearer ${args.config.bearer}`;
  const expectedBuf = Buffer.from(expectedAuth, 'utf8');
  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/health') return;
    const auth = req.headers.authorization ?? '';
    const authBuf = Buffer.from(auth, 'utf8');
    const ok =
      authBuf.length === expectedBuf.length &&
      timingSafeEqual(authBuf, expectedBuf);
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
    app.log.error({ err }, 'Unhandled error');
    reply.code(ERROR_HTTP_STATUS.internal).send({
      code: 'internal',
      message: 'Internal server error',
    });
  });

  registerHealthRoute(app, args);
  registerChatRoute(app, args);
  registerProvidersRoute(app, { ...args, keystore: args.keystore });
  registerModelsRoute(app, args);
  registerCostsRoute(app, args);
  registerMemoriesRoute(app, args);
  registerConversationsRoute(app, args);
  registerAdminRoute(app, args);

  // M2.3 — Capability Bus + builtin tools
  const costs = new CostsRepo(args.db);
  const files = new FilesRepo(args.db);
  const bus = new CapabilityBus(costs);
  bus.register(createFileReadTool(files));

  // M2.4 — image generation tool
  const filesDir = path.join(path.dirname(args.config.dbPath), 'files');
  bus.register(
    createImageGenerateTool({
      models: new ModelsRepo(args.db),
      providers: new ProvidersRepo(args.db),
      files,
      messages: new MessagesRepo(args.db),
      conversations: new ConversationsRepo(args.db),
      keystore: args.keystore,
      filesDir,
    }),
  );

  registerToolsRoute(app, { bus });

  return app;
}
