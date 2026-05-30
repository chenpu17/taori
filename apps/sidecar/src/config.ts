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

function cleanVersion(value: string | undefined): string {
  return (value ?? '0.0.2').replace(/^['"]+|['"]+$/g, '');
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
  standaloneAccessPassword: string | null;
  version: string;
  testHooks: SidecarTestHooksConfig;
}

export type SidecarConfigInput =
  Omit<SidecarConfig, 'host' | 'standalone' | 'standaloneAccessPassword' | 'testHooks'>
  & Partial<Pick<SidecarConfig, 'host' | 'standalone' | 'standaloneAccessPassword'>>
  & { testHooks?: Partial<SidecarTestHooksConfig> };

export interface SidecarTestHooksConfig {
  hermeticWeb: boolean;
  hermeticAiPlanner: boolean;
  forceClassification: boolean;
  forceImageResult: boolean;
  /** True only under the automated test runner (vitest). Used to suppress
   *  best-effort background LLM calls (e.g. auto-title) that would otherwise
   *  fire extra requests against the test mock server. Dev + production = false. */
  automatedTest: boolean;
}

export function defaultTestHooksConfig(): SidecarTestHooksConfig {
  return {
    hermeticWeb: false,
    hermeticAiPlanner: false,
    forceClassification: false,
    forceImageResult: false,
    automatedTest: false,
  };
}

function runtimeDir(): string {
  if (process.env.TAORI_STANDALONE === '1') {
    return process.cwd();
  }
  return path.dirname(fileURLToPath(import.meta.url));
}

function testHooksEnabled(): boolean {
  return process.env.NODE_ENV !== 'production' && process.env.TAORI_DISABLE_TEST_HOOKS !== '1';
}

export function loadTestHooksConfig(): SidecarTestHooksConfig {
  const enabled = testHooksEnabled();
  const hermeticWeb = enabled && process.env.TAORI_E2E_HERMETIC_WEB === '1';
  return {
    ...defaultTestHooksConfig(),
    hermeticWeb,
    hermeticAiPlanner: enabled && (process.env.TAORI_HERMETIC_AI_PLANNER === '1' || hermeticWeb),
    forceClassification: enabled && process.env.TAORI_FORCE_CLASSIFICATION === '1',
    forceImageResult: enabled && process.env.TAORI_FORCE_IMAGE_RESULT === '1',
  };
}

export function normalizeSidecarConfig(config: SidecarConfigInput): SidecarConfig {
  return {
    host: '127.0.0.1',
    standalone: false,
    standaloneAccessPassword: null,
    ...config,
    testHooks: {
      ...defaultTestHooksConfig(),
      ...(config.testHooks ?? {}),
      // Derived signal — every config (dev / prod / test) flows through here.
      // vitest sets NODE_ENV=test + VITEST; dev and production never do.
      automatedTest: process.env.NODE_ENV === 'test' || process.env.VITEST != null,
    },
  };
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
  const standaloneAccessPassword = process.env.TAORI_STANDALONE_ACCESS_PASSWORD?.trim() || null;

  return normalizeSidecarConfig({
    host,
    port,
    bearer,
    dbPath,
    controlUrl,
    controlBearer,
    isDev,
    standalone,
    standaloneAccessPassword,
    version: cleanVersion(process.env.TAORI_CLI_VERSION ?? process.env.npm_package_version ?? '0.0.2'),
    testHooks: loadTestHooksConfig(),
  });
}
