/**
 * Runtime config for the sidecar.
 *
 * In production (spawned by Tauri):
 *   - SIDECAR_BEARER         — token Renderer must present (req. by Tauri)
 *   - SIDECAR_PORT           — port to bind to (0 = pick random; default 0)
 *   - CONTROL_URL            — Rust control channel base URL (axum)
 *   - CONTROL_BEARER         — Bearer token for control channel
 *   - DB_PATH                — absolute path to sqlite file
 *
 * In dev (`pnpm dev:sidecar` standalone):
 *   - falls back to ./data/dev.db, port 17890, dev tokens.
 *   - control channel is optional (no Tauri running).
 */

import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function devToken(): string {
  // 32 random bytes = 256-bit entropy. Matches the security spec
  // (docs/architecture/05-security.md) and the Rust control channel.
  return `dev_${randomBytes(32).toString('hex')}`;
}

export interface SidecarConfig {
  port: number;
  bearer: string;
  dbPath: string;
  controlUrl: string | null;
  controlBearer: string | null;
  isDev: boolean;
  version: string;
}

export function loadConfig(): SidecarConfig {
  const isDev = process.env.NODE_ENV !== 'production';

  const port = process.env.SIDECAR_PORT
    ? Number(process.env.SIDECAR_PORT)
    : isDev
      ? 17890
      : 0;

  const bearer = process.env.SIDECAR_BEARER ?? devToken();

  const dbPath =
    process.env.DB_PATH ??
    path.resolve(__dirname, '..', 'data', isDev ? 'dev.db' : 'taori.db');

  const controlUrl = process.env.CONTROL_URL ?? null;
  const controlBearer = process.env.CONTROL_BEARER ?? null;

  return {
    port,
    bearer,
    dbPath,
    controlUrl,
    controlBearer,
    isDev,
    version: process.env.npm_package_version ?? '0.0.0',
  };
}
