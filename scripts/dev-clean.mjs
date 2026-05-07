#!/usr/bin/env node
/**
 * dev-clean.mjs — remove stale Taori browser-dev processes before local testing.
 *
 * This script only targets processes that look like they belong to this repo's
 * browser Sidecar/Web dev stack. If port 17890 is held by something else, it
 * reports the owner and exits non-zero instead of killing it.
 */
import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SIDECAR_PORT = process.env.SIDECAR_PORT ?? '17890';

function log(line) {
  process.stderr.write(`[dev-clean] ${line}\n`);
}

function parseArgs(argv) {
  return {
    dryRun: argv.includes('--dry-run'),
    quiet: argv.includes('--quiet'),
  };
}

async function run(command, args) {
  try {
    const { stdout } = await execFileAsync(command, args, { maxBuffer: 1024 * 1024 });
    return stdout;
  } catch (error) {
    if (typeof error.stdout === 'string') return error.stdout;
    return '';
  }
}

async function listProcesses() {
  const stdout = await run('ps', ['-ax', '-o', 'pid=', '-o', 'ppid=', '-o', 'command=']);
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (!match) return null;
      return { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] };
    })
    .filter(Boolean);
}

function belongsToThisRepo(command) {
  return command.includes(ROOT);
}

function isTaoriDevProcess(proc) {
  if (proc.pid === process.pid) return false;
  if (!belongsToThisRepo(proc.command)) return false;
  return [
    'scripts/dev-browser.mjs',
    'pnpm --filter @taori/sidecar dev',
    'pnpm --filter @taori/web dev',
    'tsx/dist/cli.mjs watch src/index.ts',
    'tsx/dist/loader.mjs src/index.ts',
    'apps/web/node_modules/.bin/../vite',
  ].some((needle) => proc.command.includes(needle));
}

async function pidsListeningOnPort(port) {
  const stdout = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
  return stdout
    .split('\n')
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

async function killPids(pids, dryRun) {
  const uniquePids = [...new Set(pids)].filter((pid) => pid !== process.pid);
  if (uniquePids.length === 0) return;
  if (dryRun) {
    log(`would kill stale pid(s): ${uniquePids.join(', ')}`);
    return;
  }
  for (const pid of uniquePids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
  }
  await new Promise((resolveTimer) => setTimeout(resolveTimer, 800));
  for (const pid of uniquePids) {
    try {
      process.kill(pid, 0);
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

async function main() {
  const { dryRun, quiet } = parseArgs(process.argv.slice(2));
  const processes = await listProcesses();
  const stale = processes.filter(isTaoriDevProcess);
  const portPids = await pidsListeningOnPort(SIDECAR_PORT);
  const byPid = new Map(processes.map((proc) => [proc.pid, proc]));
  const ownedPortPids = [];
  const foreignPortOwners = [];

  for (const pid of portPids) {
    const proc = byPid.get(pid);
    if (proc && (isTaoriDevProcess(proc) || belongsToThisRepo(proc.command))) {
      ownedPortPids.push(pid);
    } else {
      foreignPortOwners.push(proc ? `${pid} ${proc.command}` : String(pid));
    }
  }

  if (foreignPortOwners.length > 0) {
    log(`port ${SIDECAR_PORT} is held by a non-Taori process:`);
    for (const owner of foreignPortOwners) log(`  ${owner}`);
    log('stop that process or set SIDECAR_PORT to a free port before starting dev mode.');
    process.exit(1);
  }

  const killTargets = [...stale.map((proc) => proc.pid), ...ownedPortPids];
  if (killTargets.length === 0) {
    if (!quiet) log(`no stale Taori dev processes found; port ${SIDECAR_PORT} is free.`);
    return;
  }

  if (!quiet) log(`cleaning stale Taori dev pid(s): ${[...new Set(killTargets)].join(', ')}`);
  await killPids(killTargets, dryRun);

  const remaining = await pidsListeningOnPort(SIDECAR_PORT);
  if (remaining.length > 0 && !dryRun) {
    log(`port ${SIDECAR_PORT} is still busy after cleanup: ${remaining.join(', ')}`);
    process.exit(1);
  }
  if (!quiet) log('cleanup complete.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
