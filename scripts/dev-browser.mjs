#!/usr/bin/env node
/**
 * dev-browser.mjs — boot sidecar (tsx watch) + web (vite) for browser-only dev.
 *
 * Flow:
 *  1. Spawn sidecar via `pnpm --filter @taori/sidecar dev` and read stdout for
 *     the `READY <port> <bearer>` handshake line.
 *  2. Write apps/web/.env.local with VITE_SIDECAR_URL & VITE_SIDECAR_BEARER.
 *  3. Spawn `pnpm --filter @taori/web dev`.
 *  4. Forward both processes' stdio to this terminal; SIGINT kills both.
 */
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const WEB_ENV = resolve(ROOT, 'apps/web/.env.local');

function log(tag, line) {
  process.stderr.write(`[${tag}] ${line}\n`);
}

async function main() {
  const sidecar = spawn('pnpm', ['--filter', '@taori/sidecar', 'dev'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, FORCE_COLOR: '1' },
  });
  let sidecarReady = false;
  let webProc = null;
  let stdoutBuf = '';

  const handleReady = async (port, bearer) => {
    const url = `http://127.0.0.1:${port}`;
    log('dev', `sidecar READY url=${url} bearer=${bearer.slice(0, 12)}…`);
    await writeFile(
      WEB_ENV,
      `VITE_SIDECAR_URL=${url}\nVITE_SIDECAR_BEARER=${bearer}\n`,
      'utf8',
    );
    if (!sidecarReady) {
      sidecarReady = true;
      webProc = spawn('pnpm', ['--filter', '@taori/web', 'dev'], {
        cwd: ROOT,
        stdio: 'inherit',
        env: { ...process.env, VITE_SIDECAR_URL: url, VITE_SIDECAR_BEARER: bearer },
      });
      webProc.on('exit', (code) => {
        log('dev', `web exited code=${code}`);
        sidecar.kill('SIGTERM');
        process.exit(code ?? 0);
      });
    } else {
      log(
        'dev',
        'sidecar restarted; .env.local refreshed. Refresh the browser tab to pick up the new bearer.',
      );
    }
  };

  sidecar.stdout.on('data', async (chunk) => {
    const text = chunk.toString('utf8');
    stdoutBuf += text;
    let m;
    while ((m = stdoutBuf.match(/READY\s+(\d+)\s+(\S+)/))) {
      const [matched, port, bearer] = m;
      stdoutBuf = stdoutBuf.slice(stdoutBuf.indexOf(matched) + matched.length);
      await handleReady(port, bearer);
    }
    // Always echo sidecar logs so they appear in the dev terminal.
    process.stdout.write(text);
  });

  sidecar.on('exit', (code) => {
    log('dev', `sidecar exited code=${code}`);
    if (webProc) webProc.kill('SIGTERM');
    process.exit(code ?? 0);
  });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      sidecar.kill('SIGTERM');
      if (webProc) webProc.kill('SIGTERM');
    });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
