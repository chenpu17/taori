import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BuildServerArgs } from '../server.js';
import { createRuntimeMonitor } from '../runtime-monitor.js';

interface RealProviderStep {
  name: string;
  ok: boolean;
  [key: string]: unknown;
}

interface RealProviderEvents {
  run_id?: string;
  artifact_dir?: string;
  structured_risks?: Array<{ code?: string; message?: string; [key: string]: unknown }>;
  steps?: RealProviderStep[];
  agent_runtime?: {
    run_count?: number;
    run_event_count?: number;
    cost_call_count?: number;
    latest_run_status?: string;
  };
  final_screenshot?: string;
}

interface CapabilitySummary {
  collected_at?: string;
  selected?: Record<string, { label?: string; id?: string; capability?: string; supports_tools?: boolean; supports_vision?: boolean }>;
}

export function registerDiagnosticsRoute(
  app: FastifyInstance,
  deps: BuildServerArgs,
): void {
  const readRuntimeResources = createRuntimeMonitor({
    startedAt: deps.startedAt,
    config: deps.config,
  });

  app.get('/v1/diagnostics/runtime', async () => {
    return {
      ok: true,
      data: readRuntimeResources(),
    };
  });

  app.get('/v1/diagnostics/real-provider/latest', async () => {
    const dir = findLatestRealProviderArtifact();
    if (!dir) {
      return {
        ok: true,
        available: false,
        message: '尚未找到 verify:real 产物；运行 pnpm verify:real 后可查看真实模型诊断。',
      };
    }

    const events = readJson<RealProviderEvents>(path.join(dir, 'events.json')) ?? {};
    const capability = readJson<CapabilitySummary>(path.join(dir, 'capability-summary.json')) ?? {};
    const steps = Array.isArray(events.steps) ? events.steps : [];
    const risks = Array.isArray(events.structured_risks) ? events.structured_risks : [];
    const passedSteps = steps.filter((step) => step.ok === true).length;
    const failedSteps = steps.filter((step) => step.ok === false).length;
    const required = [
      'image_generate_tool_from_chat',
      'generated_image_to_vision_understanding',
      'web_fetch_tool_from_chat',
      'web_search_tool_from_chat',
      'mcp_tool_from_ordinary_chat',
      'real_context_window_and_compact_context_recover',
      'real_skip_tool_recovery',
      'real_roundtable_timeline',
      'backup_import_then_real_chat',
      'cost_dashboard_source_backlink_visible',
    ];
    const stepMap = new Map(steps.map((step) => [step.name, step]));
    return {
      ok: true,
      available: true,
      artifact_dir: dir,
      run_id: events.run_id ?? path.basename(dir).replace(/^taori-real-journey-/, ''),
      collected_at: capability.collected_at ?? null,
      summary: {
        passed_steps: passedSteps,
        failed_steps: failedSteps,
        risk_count: risks.length,
        run_count: events.agent_runtime?.run_count ?? null,
        run_event_count: events.agent_runtime?.run_event_count ?? null,
        cost_call_count: events.agent_runtime?.cost_call_count ?? null,
        latest_run_status: events.agent_runtime?.latest_run_status ?? null,
      },
      selected: capability.selected ?? {},
      required_steps: required.map((name) => ({
        name,
        ok: stepMap.get(name)?.ok === true,
      })),
      risks: risks.slice(0, 20).map((risk) => ({
        code: typeof risk.code === 'string' ? risk.code : 'unknown',
        message: typeof risk.message === 'string' ? risk.message : JSON.stringify(risk),
      })),
      final_screenshot: events.final_screenshot ?? null,
    };
  });
}

function findLatestRealProviderArtifact(): string | null {
  const tmp = os.tmpdir();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(tmp, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidates = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('taori-real-journey-'))
    .map((entry) => {
      const fullPath = path.join(tmp, entry.name);
      try {
        return { path: fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((entry): entry is { path: string; mtimeMs: number } => Boolean(entry))
    .filter((entry) => fs.existsSync(path.join(entry.path, 'events.json')))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.path ?? null;
}

function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}
