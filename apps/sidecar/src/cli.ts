import path from 'node:path';
import { startSidecar } from './runtime.js';

function printHelp(): void {
  process.stdout.write(
    [
      'Taori sidecar CLI',
      '',
      'Usage:',
      '  taori [--port <number>] [--db-path <path>]',
      '',
      'Options:',
      '  --port, -p      Bind port (default: 17890)',
      '  --db-path       Override sqlite file path (default: ~/.taori/taori.db)',
      '  --help, -h      Show this help',
      '',
    ].join('\n'),
  );
}

function readArgValue(args: string[], index: number, label: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('-')) {
    throw new Error(`Missing value for ${label}`);
  }
  return value;
}

function applyCliEnv(argv: string[]): void {
  process.env.TAORI_STANDALONE = '1';

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    if (arg === '--port' || arg === '-p') {
      const value = readArgValue(argv, i, arg);
      const port = Number(value);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error(`Invalid port: ${value}`);
      }
      process.env.SIDECAR_PORT = String(port);
      i += 1;
      continue;
    }
    if (arg === '--db-path') {
      process.env.DB_PATH = path.resolve(readArgValue(argv, i, arg));
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
}

async function main(): Promise<void> {
  applyCliEnv(process.argv.slice(2));
  const started = await startSidecar();
  process.stdout.write(
    [
      `Taori sidecar is running at ${started.url}`,
      `Port: ${started.port}`,
      `Bearer: ${started.bearer}`,
      `DB: ${started.config.dbPath}`,
      '',
    ].join('\n'),
  );
}

main().catch((err) => {
  process.stderr.write(`[taori-cli] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
