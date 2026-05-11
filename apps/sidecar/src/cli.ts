import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { startSidecar } from './runtime.js';
import {
  applyCliEnv,
  cleanupStaleDaemonState,
  parseCliArgs,
  printDaemonHelp,
  printHelp,
  removeDaemonState,
  resolveDaemonPaths,
  waitForDaemonReady,
  waitForProcessExit,
  writeDaemonState,
} from './standalone-cli.js';

let daemonCleanupRegistered = false;
const CLI_VERSION = (process.env.TAORI_CLI_VERSION ?? process.env.npm_package_version ?? '0.0.0')
  .replace(/^['"]+|['"]+$/g, '');

async function main(): Promise<void> {
  const command = parseCliArgs(process.argv.slice(2));
  if (command.kind === 'help') {
    printHelp();
    return;
  }
  if (command.kind === 'daemon-help') {
    printDaemonHelp();
    return;
  }
  if (command.kind === 'version') {
    process.stdout.write(`${CLI_VERSION}\n`);
    return;
  }
  if (command.kind === 'daemon-start') {
    await startDaemon(command.options);
    return;
  }
  if (command.kind === 'daemon-status') {
    await printDaemonStatus();
    return;
  }
  if (command.kind === 'daemon-stop') {
    await stopDaemon();
    return;
  }

  applyCliEnv(command.options);
  const started = await startSidecar();
  persistDaemonStateIfNeeded(started);
  if (process.env.TAORI_DAEMON_STATE_FILE) {
    return;
  }
  process.stdout.write(
    [
      `Taori sidecar is running at ${started.url}`,
      `Bind: ${started.bindUrl}`,
      `Port: ${started.port}`,
      `Host: ${started.config.host ?? '127.0.0.1'}`,
      `Bearer: ${started.bearer}`,
      `DB: ${started.config.dbPath}`,
      '',
    ].join('\n'),
  );
}

async function startDaemon(options: {
  port?: number;
  dbPath?: string;
  host?: string;
  logFile?: string;
}): Promise<void> {
  const paths = resolveDaemonPaths(options.logFile);
  const existing = cleanupStaleDaemonState(paths.stateFile);
  if (existing) {
    throw new Error(`Taori daemon is already running (pid ${existing.pid})`);
  }

  fs.mkdirSync(paths.rootDir, { recursive: true });
  fs.mkdirSync(path.dirname(paths.logFile), { recursive: true });
  const logFd = fs.openSync(paths.logFile, 'a');
  const child = spawn(process.execPath, buildChildArgs(options), {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: {
      ...process.env,
      TAORI_DAEMON_STATE_FILE: paths.stateFile,
      TAORI_DAEMON_LOG_FILE: paths.logFile,
    },
  });
  fs.closeSync(logFd);
  child.unref();
  if (!child.pid) {
    throw new Error('Failed to start Taori daemon process');
  }

  let state;
  try {
    state = await waitForDaemonReady({
      stateFile: paths.stateFile,
      expectedPid: child.pid,
      timeoutMs: 15_000,
    });
  } catch (error) {
    removeDaemonState(paths.stateFile);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}. Check daemon log: ${paths.logFile}`,
    );
  }

  process.stdout.write(
    [
      'Taori daemon started',
      `PID: ${state.pid}`,
      `Bind: ${state.bindUrl}`,
      `Local: ${state.localUrl}`,
      `Host: ${state.host}`,
      `Port: ${state.port}`,
      `Bearer: ${state.bearer}`,
      `DB: ${state.dbPath}`,
      `Log: ${state.logFile}`,
      '',
    ].join('\n'),
  );
}

async function printDaemonStatus(): Promise<void> {
  const paths = resolveDaemonPaths();
  const state = cleanupStaleDaemonState(paths.stateFile);
  if (!state) {
    process.stdout.write('Taori daemon is not running.\n');
    return;
  }
  const healthy = await fetch(`${state.localUrl}/health`, { signal: AbortSignal.timeout(1_500) })
    .then((response) => response.ok)
    .catch(() => false);
  process.stdout.write(
    [
      `Taori daemon is ${healthy ? 'running' : 'running (health probe failed)'}`,
      `PID: ${state.pid}`,
      `Bind: ${state.bindUrl}`,
      `Local: ${state.localUrl}`,
      `Host: ${state.host}`,
      `Port: ${state.port}`,
      `Bearer: ${state.bearer}`,
      `DB: ${state.dbPath}`,
      `Log: ${state.logFile}`,
      '',
    ].join('\n'),
  );
}

async function stopDaemon(): Promise<void> {
  const paths = resolveDaemonPaths();
  const state = cleanupStaleDaemonState(paths.stateFile);
  if (!state) {
    process.stdout.write('Taori daemon is not running.\n');
    return;
  }
  try {
    process.kill(state.pid, 'SIGTERM');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
      removeDaemonState(paths.stateFile);
      process.stdout.write('Taori daemon is not running.\n');
      return;
    }
    throw error;
  }
  await waitForProcessExit(state.pid, 10_000);
  removeDaemonState(paths.stateFile);
  process.stdout.write(`Taori daemon stopped (pid ${state.pid}).\n`);
}

function persistDaemonStateIfNeeded(started: Awaited<ReturnType<typeof startSidecar>>): void {
  const stateFile = process.env.TAORI_DAEMON_STATE_FILE;
  if (!stateFile) {
    return;
  }
  if (!daemonCleanupRegistered) {
    daemonCleanupRegistered = true;
    process.on('exit', () => removeDaemonState(stateFile));
  }
  writeDaemonState(stateFile, {
    pid: process.pid,
    startedAt: Date.now(),
    host: started.config.host ?? '127.0.0.1',
    port: started.port,
    bindUrl: started.bindUrl,
    localUrl: started.url,
    bearer: started.bearer,
    dbPath: started.config.dbPath,
    logFile: process.env.TAORI_DAEMON_LOG_FILE ?? resolveDaemonPaths().logFile,
  });
}

function buildChildArgs(options: { port?: number; dbPath?: string; host?: string }): string[] {
  const entry = process.argv[1];
  if (!entry) {
    throw new Error('Cannot determine Taori CLI entry path');
  }
  const args = [entry];
  if (options.host) {
    args.push('--host', options.host);
  }
  if (options.port != null) {
    args.push('--port', String(options.port));
  }
  if (options.dbPath) {
    args.push('--db-path', options.dbPath);
  }
  return args;
}

main().catch((err) => {
  if (process.env.TAORI_DAEMON_STATE_FILE) {
    removeDaemonState(process.env.TAORI_DAEMON_STATE_FILE);
  }
  process.stderr.write(`[taori-cli] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
