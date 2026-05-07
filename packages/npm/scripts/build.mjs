import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const outdir = path.resolve(__dirname, '..', 'dist');
const entry = path.resolve(__dirname, '..', '..', '..', 'apps', 'sidecar', 'src', 'cli.ts');
const outfile = path.join(outdir, 'cli.cjs');
const requestedEngine = process.env.TAORI_BUNDLE_ENGINE?.trim().toLowerCase() ?? '';

fs.rmSync(outdir, { recursive: true, force: true });
fs.mkdirSync(outdir, { recursive: true });

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
