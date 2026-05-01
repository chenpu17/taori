/**
 * Playwright global setup — starts a dedicated test sidecar + Vite server so
 * that e2e tests never touch the developer's real dev.db / providers / models.
 *
 * Resources:
 *   - Test sidecar : 127.0.0.1:17900, fresh temp DB, fixed bearer token
 *   - Test Vite    : 127.0.0.1:5174
 *   - Writes       : e2e/.test-env  (read by _helpers.ts, cleaned up in teardown)
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(HERE, '..');
const ROOT = path.resolve(WEB_DIR, '..', '..');
const SIDECAR_DIR = path.join(ROOT, 'apps', 'sidecar');
const SIDECAR_ENTRY = path.join(SIDECAR_DIR, 'src', 'index.ts');
const SIDECAR_TSX = path.join(SIDECAR_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs');
export const TEST_ENV_FILE = path.join(HERE, '.test-env');
export const TEST_LOCK_FILE = path.join(HERE, '.test-lock');

export const TEST_SIDECAR_PORT = 17900;
export const TEST_VITE_PORT = 5174;
// Fixed token so tests are deterministic and don't need to parse stdout.
export const TEST_BEARER = 'test_bearer_playwright_e2e_isolated';

async function waitForUrl(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // Not ready yet.
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function startProcess(
  cmd: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
): ChildProcess {
  const proc = spawn(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });
  proc.stdout?.on('data', (d: Buffer) => {
    process.stdout.write(`[test-${path.basename(cmd)}] ${d}`);
  });
  proc.stderr?.on('data', (d: Buffer) => {
    process.stderr.write(`[test-${path.basename(cmd)}] ${d}`);
  });
  return proc;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireE2ELock(): void {
  if (fs.existsSync(TEST_LOCK_FILE)) {
    const existingPid = Number(fs.readFileSync(TEST_LOCK_FILE, 'utf8'));
    if (Number.isFinite(existingPid) && isProcessAlive(existingPid)) {
      throw new Error(
        `Another Playwright e2e run is active (pid=${existingPid}). ` +
        'Run e2e specs in a single Playwright process; shared test ports and .test-env are not parallel-safe.',
      );
    }
    fs.rmSync(TEST_LOCK_FILE, { force: true });
  }
  fs.writeFileSync(TEST_LOCK_FILE, String(process.pid), { flag: 'wx' });
}

export default async function globalSetup(): Promise<void> {
  acquireE2ELock();

  // E2E must boot the current sidecar source, not a potentially stale dist
  // build, otherwise renderer/sidecar contract changes can silently diverge.
  if (!fs.existsSync(SIDECAR_TSX) || !fs.existsSync(SIDECAR_ENTRY)) {
    throw new Error(
      `Sidecar runtime not found.\n` +
      `Expected: ${SIDECAR_TSX}\n` +
      `Entry: ${SIDECAR_ENTRY}\n` +
      `Run: pnpm install`,
    );
  }

  // Fresh temp DB — isolated from dev.db.
  const dbPath = path.join(os.tmpdir(), `taori-test-${Date.now()}.db`);

  // ── Start test sidecar ──────────────────────────────────────────────────
  const sidecarProc = startProcess('node', [SIDECAR_TSX, SIDECAR_ENTRY], SIDECAR_DIR, {
    DB_PATH: dbPath,
    SIDECAR_PORT: String(TEST_SIDECAR_PORT),
    SIDECAR_BEARER: TEST_BEARER,
    NODE_ENV: 'development',
  });

  await waitForUrl(`http://127.0.0.1:${TEST_SIDECAR_PORT}/health`);
  console.log(`[global-setup] Test sidecar ready on :${TEST_SIDECAR_PORT} (db=${dbPath})`);

  // ── Start test Vite server ──────────────────────────────────────────────
  const viteBin = path.join(WEB_DIR, 'node_modules', 'vite', 'bin', 'vite.js');
  const viteProc = startProcess(
    'node',
    [viteBin, '--port', String(TEST_VITE_PORT), '--strictPort'],
    WEB_DIR,
    {
      VITE_SIDECAR_URL: `http://127.0.0.1:${TEST_SIDECAR_PORT}`,
      VITE_SIDECAR_BEARER: TEST_BEARER,
    },
  );

  await waitForUrl(`http://127.0.0.1:${TEST_VITE_PORT}`);
  console.log(`[global-setup] Test Vite ready on :${TEST_VITE_PORT}`);

  // ── Write .test-env so _helpers.ts and teardown can find the processes ──
  fs.writeFileSync(
    TEST_ENV_FILE,
    [
      `VITE_SIDECAR_URL=http://127.0.0.1:${TEST_SIDECAR_PORT}`,
      `VITE_SIDECAR_BEARER=${TEST_BEARER}`,
      `_SIDECAR_PID=${sidecarProc.pid}`,
      `_VITE_PID=${viteProc.pid}`,
      `_DB_PATH=${dbPath}`,
    ].join('\n'),
  );
}
