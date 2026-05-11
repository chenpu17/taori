import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ServeOptions {
  port?: number;
  dbPath?: string;
  host?: string;
}

export interface DaemonStartOptions extends ServeOptions {
  logFile?: string;
}

export type CliCommand =
  | { kind: 'help' }
  | { kind: 'daemon-help' }
  | { kind: 'version' }
  | { kind: 'serve'; options: ServeOptions }
  | { kind: 'daemon-start'; options: DaemonStartOptions }
  | { kind: 'daemon-status' }
  | { kind: 'daemon-stop' };

export interface DaemonPaths {
  rootDir: string;
  stateFile: string;
  logFile: string;
}

export interface StandaloneDaemonState {
  pid: number;
  startedAt: number;
  host: string;
  port: number;
  bindUrl: string;
  localUrl: string;
  bearer: string;
  dbPath: string;
  logFile: string;
}

const DEFAULT_STATE_FILE = 'taori-daemon.json';
const DEFAULT_LOG_FILE = 'taori-daemon.log';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 17890;
const DEFAULT_DB_FILE = 'taori.db';

export function printHelp(): void {
  process.stdout.write(
    [
      'Taori sidecar CLI',
      '',
      'Run the Taori sidecar as a local or remote HTTP runtime.',
      '',
      'Usage:',
      '  taori [options]',
      '  taori serve [options]',
      '  taori version',
      '  taori daemon <start|status|stop|help> [options]',
      '',
      'Commands:',
      '  serve            Start the sidecar in the foreground',
      '  version          Print the installed Taori CLI version',
      '  daemon start     Start the sidecar in the background',
      '  daemon status    Show daemon pid, bind/local url, bearer, db and log path',
      '  daemon stop      Stop the background daemon',
      '  daemon help      Show daemon-specific help',
      '',
      'Global options:',
      `  --host <addr>    Bind host (default: ${DEFAULT_HOST}; use 0.0.0.0 for remote/web deployment)`,
      `  --port, -p <n>   Bind port (default: ${DEFAULT_PORT})`,
      `  --db-path <path> SQLite path (default: ~/.taori/${DEFAULT_DB_FILE})`,
      '  --help, -h       Show this help',
      '  --version, -v    Show CLI version',
      '',
      'Foreground examples:',
      `  taori`,
      `  taori serve --port ${DEFAULT_PORT}`,
      '  taori --host 0.0.0.0 --port 18901',
      '  taori --db-path ~/.taori/my-taori.db',
      '',
      'Daemon examples:',
      '  taori daemon status',
      `  taori daemon start --host 0.0.0.0 --port ${DEFAULT_PORT}`,
      '  taori daemon start --db-path ~/.taori/my-taori.db --log-file /var/log/taori.log',
      '  taori daemon stop',
      '',
      'Runtime files:',
      `  DB file          ~/.taori/${DEFAULT_DB_FILE}`,
      `  Daemon state     ~/.taori/${DEFAULT_STATE_FILE}`,
      `  Daemon log       ~/.taori/${DEFAULT_LOG_FILE}`,
      '',
      'Notes:',
      '  - Foreground mode keeps the current terminal attached.',
      '  - Daemon mode writes pid/state/log files under ~/.taori by default.',
      '  - Host 0.0.0.0 is suitable for servers, but should be protected by network policy or a reverse proxy.',
      '  - On startup/status the CLI prints the bearer token required by the HTTP API.',
      '',
    ].join('\n'),
  );
}

export function printDaemonHelp(): void {
  process.stdout.write(
    [
      'Taori daemon commands',
      '',
      'Usage:',
      '  taori daemon start [--host <address>] [--port <number>] [--db-path <path>] [--log-file <path>]',
      '  taori daemon status',
      '  taori daemon stop',
      '',
      'Options for `daemon start`:',
      `  --host <addr>    Bind host (default: ${DEFAULT_HOST})`,
      `  --port, -p <n>   Bind port (default: ${DEFAULT_PORT})`,
      `  --db-path <path> SQLite path (default: ~/.taori/${DEFAULT_DB_FILE})`,
      `  --log-file <p>   Daemon log path (default: ~/.taori/${DEFAULT_LOG_FILE})`,
      '',
      'Examples:',
      `  taori daemon start --port ${DEFAULT_PORT}`,
      '  taori daemon start --host 0.0.0.0 --port 18901',
      '  taori daemon status',
      '  taori daemon stop',
      '',
    ].join('\n'),
  );
}

export function parseCliArgs(argv: string[]): CliCommand {
  if (argv.length === 0) {
    return { kind: 'serve', options: {} };
  }

  if (argv.includes('--version') || argv.includes('-v') || argv[0] === 'version') {
    return { kind: 'version' };
  }

  if (argv[0] === 'help') {
    return { kind: 'help' };
  }

  if (argv[0] === 'daemon') {
    const action = argv[1];
    if (action == null || action === 'help' || action === '--help' || action === '-h') {
      return { kind: 'daemon-help' };
    }
    if (action === 'start') {
      return { kind: 'daemon-start', options: parseOptions(argv.slice(2), { allowLogFile: true }) };
    }
    if (action === 'status') {
      ensureNoExtraArgs(argv.slice(2), 'taori daemon status');
      return { kind: 'daemon-status' };
    }
    if (action === 'stop') {
      ensureNoExtraArgs(argv.slice(2), 'taori daemon stop');
      return { kind: 'daemon-stop' };
    }
    throw new Error('Usage: taori daemon <start|status|stop>');
  }

  if (argv[0] === 'serve') {
    const rest = argv.slice(1);
    if (rest.includes('--help') || rest.includes('-h')) {
      return { kind: 'help' };
    }
    return { kind: 'serve', options: parseOptions(rest, { allowLogFile: false }) };
  }

  if (argv.includes('--help') || argv.includes('-h')) {
    return { kind: 'help' };
  }

  return { kind: 'serve', options: parseOptions(argv, { allowLogFile: false }) };
}

export function applyCliEnv(options: ServeOptions): void {
  process.env.TAORI_STANDALONE = '1';
  delete process.env.SIDECAR_PORT;
  delete process.env.DB_PATH;
  delete process.env.SIDECAR_HOST;

  if (options.port != null) {
    process.env.SIDECAR_PORT = String(options.port);
  }
  if (options.dbPath) {
    process.env.DB_PATH = path.resolve(options.dbPath);
  }
  if (options.host) {
    process.env.SIDECAR_HOST = options.host;
  }
}

export function resolveDaemonPaths(logFile?: string): DaemonPaths {
  const rootDir = path.join(os.homedir(), '.taori');
  return {
    rootDir,
    stateFile: path.join(rootDir, DEFAULT_STATE_FILE),
    logFile: logFile ? path.resolve(logFile) : path.join(rootDir, DEFAULT_LOG_FILE),
  };
}

export function readDaemonState(stateFile: string): StandaloneDaemonState | null {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8')) as StandaloneDaemonState;
  } catch (error) {
    if (isMissingFile(error)) {
      return null;
    }
    throw error;
  }
}

export function writeDaemonState(stateFile: string, state: StandaloneDaemonState): void {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n');
}

export function removeDaemonState(stateFile: string): void {
  try {
    fs.rmSync(stateFile, { force: true });
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isMissingProcess(error)) {
      return false;
    }
    throw error;
  }
}

export async function waitForDaemonReady(args: {
  stateFile: string;
  expectedPid: number;
  timeoutMs: number;
}): Promise<StandaloneDaemonState> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < args.timeoutMs) {
    const state = readDaemonState(args.stateFile);
    if (state?.pid === args.expectedPid) {
      const healthy = await probeHealth(state.localUrl);
      if (healthy) {
        return state;
      }
    }
    if (!isProcessAlive(args.expectedPid)) {
      throw new Error('Taori daemon exited before becoming ready');
    }
    await delay(150);
  }
  throw new Error('Timed out waiting for Taori daemon readiness');
}

export async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await delay(150);
  }
  throw new Error(`Timed out waiting for process ${pid} to exit`);
}

export function cleanupStaleDaemonState(stateFile: string): StandaloneDaemonState | null {
  const state = readDaemonState(stateFile);
  if (!state) {
    return null;
  }
  if (!isProcessAlive(state.pid)) {
    removeDaemonState(stateFile);
    return null;
  }
  return state;
}

export async function probeHealth(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1_500) });
    return response.ok;
  } catch {
    return false;
  }
}

export function formatHttpUrl(host: string, port: number): string {
  const hostname = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${hostname}:${port}`;
}

export function normalizeLocalConnectUrl(host: string, port: number): string {
  if (host === '0.0.0.0') {
    return formatHttpUrl('127.0.0.1', port);
  }
  if (host === '::') {
    return formatHttpUrl('::1', port);
  }
  return formatHttpUrl(host, port);
}

function parseOptions(
  argv: string[],
  args: { allowLogFile: boolean },
): ServeOptions | DaemonStartOptions {
  const options: DaemonStartOptions = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--port' || arg === '-p') {
      const value = readArgValue(argv, i, arg);
      const port = Number(value);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error(`Invalid port: ${value}`);
      }
      options.port = port;
      i += 1;
      continue;
    }
    if (arg === '--db-path') {
      options.dbPath = path.resolve(readArgValue(argv, i, arg));
      i += 1;
      continue;
    }
    if (arg === '--host') {
      options.host = validateHost(readArgValue(argv, i, arg));
      i += 1;
      continue;
    }
    if (arg === '--log-file') {
      if (!args.allowLogFile) {
        throw new Error('--log-file is only supported with `taori daemon start`');
      }
      options.logFile = path.resolve(readArgValue(argv, i, arg));
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function readArgValue(args: string[], index: number, label: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('-')) {
    throw new Error(`Missing value for ${label}`);
  }
  return value;
}

function ensureNoExtraArgs(args: string[], usage: string): void {
  if (args.length > 0) {
    throw new Error(`Unexpected arguments. Usage: ${usage}`);
  }
}

function validateHost(value: string): string {
  const host = value.trim();
  if (!host) {
    throw new Error('Host cannot be empty');
  }
  if (host.includes('://')) {
    throw new Error(`Host must not include a URL scheme: ${value}`);
  }
  if (host.includes('/')) {
    throw new Error(`Host must not include a path: ${value}`);
  }
  if (/\s/.test(host)) {
    throw new Error(`Host must not contain whitespace: ${value}`);
  }
  return host;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function isMissingProcess(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ESRCH';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
