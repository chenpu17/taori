import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const outdir = path.resolve(__dirname, '..', 'dist');
const webOutdir = path.resolve(__dirname, '..', 'dist-web');
const pkgJsonPath = path.resolve(__dirname, '..', 'package.json');
const entry = path.resolve(__dirname, '..', '..', '..', 'apps', 'sidecar', 'src', 'cli.ts');
const webRoot = path.resolve(__dirname, '..', '..', '..', 'apps', 'web');
const webDist = path.resolve(webRoot, 'dist');
const outfile = path.join(outdir, 'cli.cjs');
const requestedEngine = process.env.TAORI_BUNDLE_ENGINE?.trim().toLowerCase() ?? '';
const packageJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
const cliVersion = String(packageJson.version ?? '0.0.0');

fs.rmSync(outdir, { recursive: true, force: true });
fs.mkdirSync(outdir, { recursive: true });
fs.rmSync(webOutdir, { recursive: true, force: true });

function buildWithEsbuild() {
  return build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['better-sqlite3'],
    banner: {
      js: '#!/usr/bin/env node',
    },
    define: {
      'process.env.TAORI_CLI_VERSION': JSON.stringify(cliVersion),
    },
  });
}

function tryBuildWithBun({ required }) {
  const result = spawnSync(
    'bun',
    [
      'build',
      entry,
      `--outfile=${outfile}`,
      '--target=node',
      '--format=cjs',
      '--external=better-sqlite3',
      '--banner=#!/usr/bin/env node',
      `--define=process.env.TAORI_CLI_VERSION='\"${cliVersion}\"'`,
    ],
    {
      stdio: 'inherit',
      env: process.env,
    },
  );
  if (result.error) {
    if (!required && result.error.code === 'ENOENT') return false;
    throw result.error;
  }
  if (result.status !== 0) {
    if (!required) return false;
    throw new Error(`bun build failed with exit code ${result.status ?? 'unknown'}`);
  }
  return true;
}

if (requestedEngine === 'bun') {
  console.log('Building @chenpu17/taori with Bun bundler');
  tryBuildWithBun({ required: true });
} else if (requestedEngine === 'esbuild') {
  console.log('Building @chenpu17/taori with esbuild');
  await buildWithEsbuild();
} else if (tryBuildWithBun({ required: false })) {
  console.log('Building @chenpu17/taori with Bun bundler');
} else {
  console.log('Bun not available, falling back to esbuild');
  await buildWithEsbuild();
}

fs.chmodSync(outfile, 0o755);

spawnSync('pnpm', ['--filter', '@taori/web', 'build'], {
  stdio: 'inherit',
  env: process.env,
});

fs.cpSync(webDist, webOutdir, { recursive: true });
