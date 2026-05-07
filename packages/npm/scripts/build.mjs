import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const outdir = path.resolve(__dirname, '..', 'dist');

fs.rmSync(outdir, { recursive: true, force: true });
fs.mkdirSync(outdir, { recursive: true });

await build({
  entryPoints: [path.resolve(__dirname, '..', '..', '..', 'apps', 'sidecar', 'src', 'cli.ts')],
  outfile: path.join(outdir, 'cli.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['better-sqlite3'],
  banner: {
    js: '#!/usr/bin/env node',
  },
});

fs.chmodSync(path.join(outdir, 'cli.cjs'), 0o755);
