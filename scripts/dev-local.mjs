#!/usr/bin/env node
/**
 * dev-local.mjs — one-command browser developer mode.
 *
 * It keeps the product testing path focused on WebUI + Sidecar:
 *   - clears stale Taori dev processes and the default Sidecar port;
 *   - builds shared types/contracts;
 *   - starts the browser Sidecar + Vite stack;
 *   - does not start Desktop or read the system Keychain.
 */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

function log(line) {
  process.stderr.write(`[dev-local] ${line}\n`);
}

function runStep(label, command, args, options = {}) {
  return new Promise((resolveStep, rejectStep) => {
    log(label);
    const child = spawn(command, args, {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, ...options.env },
    });
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolveStep();
        return;
      }
      rejectStep(new Error(`${label} failed code=${code} signal=${signal ?? 'none'}`));
    });
  });
}

function startLongRunning(command, args) {
  const child = spawn(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
  });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      child.kill('SIGTERM');
    });
  }

  child.on('exit', (code, signal) => {
    if (signal) {
      process.exit(0);
      return;
    }
    process.exit(code ?? 0);
  });
}

async function main() {
  log('starting browser developer mode (WebUI + Sidecar, no Desktop/Keychain).');
  await runStep('preflight cleanup', 'node', ['./scripts/dev-clean.mjs', '--quiet']);
  await runStep('build shared package', 'pnpm', ['build:shared']);
  log('starting browser stack; open the Vite Local URL printed below.');
  startLongRunning('node', ['./scripts/dev-browser.mjs']);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
