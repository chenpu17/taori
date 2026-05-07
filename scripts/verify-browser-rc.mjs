#!/usr/bin/env node
/**
 * Browser-first release-candidate gate.
 *
 * This script composes the existing WebUI + Sidecar checks into one command:
 *   1. pnpm verify:web
 *   2. pnpm verify:real:report
 *   3. git diff --check
 *
 * It does not start desktop, does not call live providers, and does not read
 * system Keychain. Real provider evidence is read from the latest local
 * verify:real artifact through verify:real:report.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPORT_ONLY = process.argv.includes('--report');
const RUN_ID = `browser-rc-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
const ARTIFACT_DIR =
  process.env.TAORI_BROWSER_RC_OUT ?? process.env.TAORI_BROWSER_RC_REPORT_DIR ??
  path.join('/tmp', `taori-browser-rc-${RUN_ID}`);

const STEPS = [
  {
    name: 'verify_web',
    label: 'WebUI + Sidecar full verification',
    command: 'pnpm',
    args: ['verify:web'],
  },
  {
    name: 'verify_real_report',
    label: 'Real provider artifact risk report',
    command: 'pnpm',
    args: ['verify:real:report'],
  },
  {
    name: 'diff_check',
    label: 'Git whitespace check',
    command: 'git',
    args: ['diff', '--check'],
  },
];

if (!REPORT_ONLY) {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) return 'unknown';
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${minutes}m ${rest}s` : `${seconds}s`;
}

function log(message) {
  process.stdout.write(`${message}\n`);
}

function artifactPath(name) {
  return path.join(ARTIFACT_DIR, name);
}

function artifactPathForDir(dir, name) {
  return path.join(dir, name);
}

function writeJsonArtifact(name, data) {
  const file = artifactPath(name);
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  return file;
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function findLatestArtifactDir() {
  const roots = ['/tmp'];
  return roots
    .flatMap((root) => {
      let entries = [];
      try {
        entries = fs.readdirSync(root, { withFileTypes: true });
      } catch {
        return [];
      }
      return entries
        .filter((entry) => entry.isDirectory() && entry.name.startsWith('taori-browser-rc-'))
        .map((entry) => {
          const dir = path.join(root, entry.name);
          const summaryFile = artifactPathForDir(dir, 'summary.json');
          try {
            return fs.existsSync(summaryFile) ? { dir, mtimeMs: fs.statSync(summaryFile).mtimeMs } : null;
          } catch {
            return null;
          }
        });
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.dir ?? null;
}

function stripAnsi(value) {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

function readTextFile(file) {
  try {
    return stripAnsi(fs.readFileSync(file, 'utf8'));
  } catch {
    return '';
  }
}

function findJsonObjects(text) {
  const objects = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (char !== '}' || depth === 0) continue;
    depth -= 1;
    if (depth === 0 && start >= 0) {
      const candidate = text.slice(start, index + 1);
      try {
        objects.push(JSON.parse(candidate));
      } catch {
        // Not every balanced brace block in command output is JSON.
      }
      start = -1;
    }
  }
  return objects;
}

function summarizeStepDetails(step) {
  const text = readTextFile(step.log_file);
  if (step.name === 'verify_web') {
    const passed = Array.from(text.matchAll(/(\d+)\s+passed/g)).at(-1)?.[1] ?? null;
    return passed ? `${passed} Playwright tests passed` : '';
  }
  if (step.name === 'verify_real_report') {
    const report = findJsonObjects(text).findLast((item) => item?.artifact_dir && item?.summary);
    if (!report) return '';
    return [
      report.artifact_dir ? `artifact ${report.artifact_dir}` : null,
      report.summary?.passed_steps != null ? `${report.summary.passed_steps} real steps passed` : null,
      report.summary?.risk_count != null ? `risk_count=${report.summary.risk_count}` : null,
    ]
      .filter(Boolean)
      .join('; ');
  }
  if (step.name === 'diff_check') {
    return step.ok ? 'no whitespace errors' : '';
  }
  return '';
}

function writeMarkdownReport(summary, targetDir = ARTIFACT_DIR) {
  const status = summary.ok ? 'passed' : 'failed';
  const lines = [
    '# Browser-first RC Report',
    '',
    `Status: ${status}`,
    `Generated: ${summary.generated_at}`,
    `Artifact: ${summary.artifact_dir}`,
    `Duration: ${formatDuration(summary.duration_ms)}`,
    '',
    '## Steps',
    '',
    '| Step | Status | Duration | Command | Log | Details |',
    '|---|---:|---:|---|---|---|',
  ];
  for (const step of summary.steps ?? []) {
    const command = step.command_text ?? '';
    const details = summarizeStepDetails(step);
    lines.push(
      `| ${step.label} | ${step.ok ? 'passed' : 'failed'} | ${formatDuration(step.duration_ms)} | \`${command}\` | \`${step.log_file}\` | ${details || '-'} |`,
    );
  }
  if (summary.error) {
    lines.push('', '## Error', '', '```text', summary.error, '```');
  }
  lines.push(
    '',
    '## Notes',
    '',
    '- This Browser-first gate does not start Desktop.',
    '- It does not call live providers; real-provider status is read from the latest local artifact via `verify:real:report`.',
    '- It does not read the system Keychain.',
    '',
  );
  const file = artifactPathForDir(targetDir, 'report.md');
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  return file;
}

function writeSummary(summary) {
  writeJsonArtifact('summary.json', summary);
  writeMarkdownReport(summary);
}

function reportOnly() {
  const dir = process.env.TAORI_BROWSER_RC_REPORT_DIR ?? findLatestArtifactDir();
  if (!dir) {
    throw new Error('no Browser RC artifact found; run pnpm verify:browser-rc or set TAORI_BROWSER_RC_REPORT_DIR');
  }
  const summary = readJsonFile(artifactPathForDir(dir, 'summary.json'));
  if (!summary) {
    throw new Error(`missing or invalid summary.json in ${dir}`);
  }
  const reportFile = writeMarkdownReport(summary, dir);
  log(fs.readFileSync(reportFile, 'utf8'));
  if (!summary.ok) {
    process.exitCode = 1;
  }
}

function runStep(step) {
  const startedAt = Date.now();
  const outputFile = artifactPath(`${step.name}.log`);
  const output = fs.createWriteStream(outputFile, { flags: 'w' });
  log(`\n[${step.name}] ${step.label}`);
  log(`$ ${step.command} ${step.args.join(' ')}`);

  return new Promise((resolve) => {
    const child = spawn(step.command, step.args, {
      cwd: ROOT,
      env: { ...process.env, FORCE_COLOR: process.env.FORCE_COLOR ?? '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
      output.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk);
      output.write(chunk);
    });
    child.on('error', (error) => {
      output.write(`\n[spawn-error] ${error.stack ?? error.message}\n`);
      output.end();
      resolve({
        name: step.name,
        label: step.label,
        ok: false,
        code: null,
        signal: null,
        duration_ms: Date.now() - startedAt,
        log_file: outputFile,
        command_text: `${step.command} ${step.args.join(' ')}`,
        error: error.message,
      });
    });
    child.on('exit', (code, signal) => {
      output.end();
      resolve({
        name: step.name,
        label: step.label,
        ok: code === 0,
        code,
        signal,
        duration_ms: Date.now() - startedAt,
        log_file: outputFile,
        command_text: `${step.command} ${step.args.join(' ')}`,
      });
    });
  });
}

async function main() {
  if (REPORT_ONLY) {
    reportOnly();
    return;
  }
  const startedAt = Date.now();
  const steps = [];
  for (const step of STEPS) {
    const result = await runStep(step);
    steps.push(result);
    writeSummary({
      ok: steps.every((item) => item.ok),
      artifact_dir: ARTIFACT_DIR,
      generated_at: new Date().toISOString(),
      duration_ms: Date.now() - startedAt,
      steps,
    });
    if (!result.ok) {
      log(`\nBrowser RC gate failed at ${step.name}. Artifacts: ${ARTIFACT_DIR}`);
      process.exitCode = 1;
      return;
    }
  }
  const summary = {
    ok: true,
    artifact_dir: ARTIFACT_DIR,
    generated_at: new Date().toISOString(),
    duration_ms: Date.now() - startedAt,
    steps,
  };
  writeSummary(summary);
  log(`\nBrowser RC gate passed. Artifacts: ${ARTIFACT_DIR}`);
}

main().catch((error) => {
  const summary = {
    ok: false,
    artifact_dir: ARTIFACT_DIR,
    generated_at: new Date().toISOString(),
    error: error instanceof Error ? error.stack ?? error.message : String(error),
  };
  writeSummary(summary);
  console.error(summary.error);
  process.exit(1);
});
