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
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function devToken(): string {
  // 32 random bytes = 256-bit entropy. Matches the security spec
  // (docs/architecture/05-security.md) and the Rust control channel.
  return `dev_${randomBytes(32).toString('hex')}`;
}

export interface SidecarConfig {
  host: string;
  port: number;
  bearer: string;
  dbPath: string;
  controlUrl: string | null;
  controlBearer: string | null;
  isDev: boolean;
  standalone: boolean;
  version: string;
}

function runtimeDir(): string {
  if (process.env.TAORI_STANDALONE === '1') {
    return process.cwd();
  }
  return path.dirname(fileURLToPath(import.meta.url));
}

export function loadConfig(): SidecarConfig {
  const standalone = process.env.TAORI_STANDALONE === '1';
  const isDev = !standalone && process.env.NODE_ENV !== 'production';
  const host = process.env.SIDECAR_HOST?.trim() || '127.0.0.1';

  const port = process.env.SIDECAR_PORT
    ? Number(process.env.SIDECAR_PORT)
    : isDev
      ? 17890
      : standalone
        ? 17890
        : 0;

  const bearer = process.env.SIDECAR_BEARER ?? devToken();

  const dbPath =
    process.env.DB_PATH ??
    (standalone
      ? path.join(os.homedir(), '.taori', 'taori.db')
      : path.resolve(runtimeDir(), '..', 'data', isDev ? 'dev.db' : 'taori.db'));

  const controlUrl = process.env.CONTROL_URL ?? null;
  const controlBearer = process.env.CONTROL_BEARER ?? null;

  return {
    host,
    port,
    bearer,
    dbPath,
    controlUrl,
    controlBearer,
    isDev,
    standalone,
    version: process.env.npm_package_version ?? '0.0.2',
  };
}
