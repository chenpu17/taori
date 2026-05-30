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
const TEST_ENV_FILE = path.join(HERE, '.test-env');
const TEST_LOCK_FILE = path.join(HERE, '.test-lock');
const TEST_SIDECAR_PORT = Number(process.env.TAORI_E2E_SIDECAR_PORT ?? 17901);
const TEST_VITE_PORT = 5174;
const TEST_BEARER = 'test_bearer_playwright_e2e_isolated';

async function waitForUrl(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function startProcess(cmd: string, args: string[], cwd: string, env: Record<string, string>): ChildProcess {
  const proc = spawn(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout?.on('data', (data: Buffer) => process.stdout.write(`[test-${path.basename(cmd)}] ${data}`));
  proc.stderr?.on('data', (data: Buffer) => process.stderr.write(`[test-${path.basename(cmd)}] ${data}`));
  return proc;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock(): void {
  if (fs.existsSync(TEST_LOCK_FILE)) {
    const pid = Number(fs.readFileSync(TEST_LOCK_FILE, 'utf8'));
    if (Number.isFinite(pid) && isAlive(pid)) {
      throw new Error(`Another e2e run is active: ${pid}`);
    }
    fs.rmSync(TEST_LOCK_FILE, { force: true });
  }
  fs.writeFileSync(TEST_LOCK_FILE, String(process.pid), { flag: 'wx' });
}

export default async function globalSetup(): Promise<void> {
  acquireLock();
  if (!fs.existsSync(SIDECAR_TSX) || !fs.existsSync(SIDECAR_ENTRY)) {
    throw new Error('Sidecar source runtime is missing. Run pnpm install.');
  }
  const dbPath = path.join(os.tmpdir(), `taori-webui-${Date.now()}.db`);
  const sidecar = startProcess('node', [SIDECAR_TSX, SIDECAR_ENTRY], SIDECAR_DIR, {
    DB_PATH: dbPath,
    SIDECAR_PORT: String(TEST_SIDECAR_PORT),
    SIDECAR_BEARER: TEST_BEARER,
    NODE_ENV: 'development',
    TAORI_E2E_HERMETIC_WEB: '1',
    TAORI_HERMETIC_AI_PLANNER: '1',
    TAORI_FORCE_CLASSIFICATION: '1',
    TAORI_FORCE_IMAGE_RESULT: '1',
  });
  await waitForUrl(`http://127.0.0.1:${TEST_SIDECAR_PORT}/health`);

  const vite = startProcess(
    'node',
    [path.join(WEB_DIR, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(TEST_VITE_PORT), '--strictPort'],
    WEB_DIR,
    {
      VITE_SIDECAR_URL: `http://127.0.0.1:${TEST_SIDECAR_PORT}`,
      VITE_SIDECAR_BEARER: TEST_BEARER,
    },
  );
  await waitForUrl(`http://127.0.0.1:${TEST_VITE_PORT}`);

  fs.writeFileSync(TEST_ENV_FILE, [
    `VITE_SIDECAR_URL=http://127.0.0.1:${TEST_SIDECAR_PORT}`,
    `VITE_SIDECAR_BEARER=${TEST_BEARER}`,
    `_SIDECAR_PID=${sidecar.pid}`,
    `_VITE_PID=${vite.pid}`,
    `_DB_PATH=${dbPath}`,
  ].join('\n'));
}
