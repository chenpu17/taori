import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEST_ENV_FILE = path.join(HERE, '.test-env');
const TEST_LOCK_FILE = path.join(HERE, '.test-lock');

function readEnv(): Record<string, string> {
  if (!fs.existsSync(TEST_ENV_FILE)) return {};
  const result: Record<string, string> = {};
  for (const line of fs.readFileSync(TEST_ENV_FILE, 'utf8').split('\n')) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match) result[match[1]!] = match[2]!;
  }
  return result;
}

function kill(pidValue: string | undefined): void {
  const pid = Number(pidValue);
  if (!Number.isFinite(pid) || pid <= 0) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // already gone
  }
}

export default async function globalTeardown(): Promise<void> {
  const env = readEnv();
  kill(env['_SIDECAR_PID']);
  kill(env['_VITE_PID']);
  if (env['_DB_PATH']) {
    try {
      fs.rmSync(env['_DB_PATH'], { force: true });
    } catch {
      // ignore
    }
  }
  fs.rmSync(TEST_ENV_FILE, { force: true });
  fs.rmSync(TEST_LOCK_FILE, { force: true });
}
