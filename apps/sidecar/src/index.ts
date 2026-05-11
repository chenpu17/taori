/**
 * Sidecar entry point.
 *
 * Lifecycle:
 *   1. Load config from env (Tauri-provided in production; defaults in dev).
 *   2. Open SQLite + run DDL.
 *   3. Build Fastify app + bind to the configured host/port.
 *   4. Print exactly one line to stdout: `READY <port> <bearer>`.
 *      Tauri's spawn watcher reads this line, then routes it through the
 *      `sidecar_endpoint` Tauri command to the Renderer.
 *   5. Handle SIGTERM/SIGINT for graceful shutdown.
 *
 * Stdout is reserved for the READY line (and, in dev, nothing else). All
 * logs are written to stderr so the parent process never confuses log output
 * with the handshake.
 */

import { startSidecar } from './runtime.js';

startSidecar({
  onReady: ({ port, bearer }) => {
    process.stdout.write(`READY ${port} ${bearer}\n`);
  },
}).catch((err) => {
  process.stderr.write(`[sidecar] fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
