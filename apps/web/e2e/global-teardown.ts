/**
 * Playwright global teardown — kills the test sidecar + Vite server started
 * by global-setup.ts and cleans up the temp DB and .test-env file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TEST_ENV_FILE = path.join(HERE, '.test-env');
export const TEST_LOCK_FILE = path.join(HERE, '.test-lock');

function readTestEnv(): Record<string, string> {
  if (!fs.existsSync(TEST_ENV_FILE)) return {};
  const map: Record<string, string> = {};
  for (const line of fs.readFileSync(TEST_ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) map[m[1]!] = m[2]!;
  }
  return map;
}

function tryKill(pidStr: string | undefined): void {
  if (!pidStr) return;
  const pid = Number(pidStr);
  if (!pid || isNaN(pid)) return;
  try {
    process.kill(pid, 'SIGTERM');
    console.log(`[global-teardown] Sent SIGTERM to pid ${pid}`);
  } catch (e) {
    // Process may have already exited.
    const msg = (e as NodeJS.ErrnoException).code;
    if (msg !== 'ESRCH') console.warn(`[global-teardown] kill ${pid}: ${msg}`);
  }
}

export default async function globalTeardown(): Promise<void> {
  const env = readTestEnv();

  tryKill(env['_SIDECAR_PID']);
  tryKill(env['_VITE_PID']);

  // Clean up temp DB.
  if (env['_DB_PATH'] && fs.existsSync(env['_DB_PATH'])) {
    try {
      fs.unlinkSync(env['_DB_PATH']);
      console.log(`[global-teardown] Deleted temp DB: ${env['_DB_PATH']}`);
    } catch { /* ignore */ }
  }

  // Clean up .test-env.
  try { fs.unlinkSync(TEST_ENV_FILE); } catch { /* ignore */ }
  try { fs.unlinkSync(TEST_LOCK_FILE); } catch { /* ignore */ }

  console.log('[global-teardown] Done.');
}
