#!/usr/bin/env node
/**
 * Desktop dev wrapper.
 *
 * By default this keeps the Tauri shell but uses the sidecar dev_file
 * keystore, so opening the desktop app during development does not repeatedly
 * trigger macOS Keychain authorization prompts.
 *
 * To exercise the real OS Keychain path explicitly:
 *   TAORI_DESKTOP_DEV_KEYSTORE=keychain pnpm dev:desktop
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const keyStoreMode = process.env.TAORI_DESKTOP_DEV_KEYSTORE ?? 'dev_file';

function log(message) {
  process.stderr.write(`[dev:desktop] ${message}\n`);
}

async function main() {
  if (!['dev_file', 'keychain'].includes(keyStoreMode)) {
    throw new Error('TAORI_DESKTOP_DEV_KEYSTORE must be "dev_file" or "keychain"');
  }
  if (keyStoreMode === 'dev_file') {
    log('using dev_file keystore; system Keychain is not used by default');
    log('set TAORI_DESKTOP_DEV_KEYSTORE=keychain to verify the real Keychain path');
  } else {
    log('using system Keychain; macOS may show authorization prompts');
  }

  const child = spawn('pnpm', ['--filter', '@taori/desktop', 'tauri', 'dev'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      TAORI_DESKTOP_DEV_KEYSTORE: keyStoreMode,
    },
  });
  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
