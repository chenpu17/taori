/**
 * Sidecar entry point.
 *
 * Lifecycle:
 *   1. Load config from env (Tauri-provided in production; defaults in dev).
 *   2. Open SQLite + run DDL.
 *   3. Build Fastify app + bind to 127.0.0.1:<port>.
 *   4. Print exactly one line to stdout: `READY <port> <bearer>`.
 *      Tauri's spawn watcher reads this line, then routes it through the
 *      `sidecar_endpoint` Tauri command to the Renderer.
 *   5. Handle SIGTERM/SIGINT for graceful shutdown.
 *
 * Stdout is reserved for the READY line (and, in dev, nothing else). All
 * logs are written to stderr so the parent process never confuses log output
 * with the handshake.
 */

import { loadConfig } from './config.js';
import { openDb } from './db/index.js';
import { ControlClient } from './control/client.js';
import { buildKeyStore } from './keystore.js';
import { buildServer } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = openDb(config.dbPath);
  const control = new ControlClient({
    url: config.controlUrl,
    bearer: config.controlBearer,
  });
  const keystore = buildKeyStore({
    control,
    isDev: config.isDev,
    dbPath: config.dbPath,
    log: (msg) => process.stderr.write(msg + '\n'),
  });
  const startedAt = Date.now();

  const app = buildServer({ config, db, control, keystore, startedAt });

  const address = await app.listen({ host: '127.0.0.1', port: config.port });
  const url = new URL(address);
  const port = Number(url.port);

  // The handshake line — Tauri reads exactly this format.
  process.stdout.write(`READY ${port} ${config.bearer}\n`);

  // Boot the catalog price sync. Best-effort; ignores failures so we never
  // hold up the READY handshake or crash the sidecar on transient network.
  const { ProvidersRepo, ModelsRepo } = await import('./db/repos/index.js');
  const { scheduleCatalogSync } = await import('./catalog/index.js');
  const catalogTask = scheduleCatalogSync({
    providers: new ProvidersRepo(db),
    models: new ModelsRepo(db),
    keystore,
    log: {
      info: (...a) => process.stderr.write('[catalog] ' + a.join(' ') + '\n'),
      warn: (...a) => process.stderr.write('[catalog] WARN ' + a.join(' ') + '\n'),
    },
  });

  if (config.isDev) {
    process.stderr.write(
      `[sidecar] dev mode listening on http://127.0.0.1:${port} (control=${config.controlUrl ? 'configured' : 'none'})\n`,
    );
  }

  const shutdown = async (signal: string) => {
    process.stderr.write(`[sidecar] received ${signal}, shutting down\n`);
    try {
      catalogTask.stop();
      await app.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  process.stderr.write(`[sidecar] fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
