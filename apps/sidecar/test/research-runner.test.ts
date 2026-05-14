import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ControlClient } from '../src/control/client.js';
import { openDb } from '../src/db/index.js';
import { MemoryStore } from '../src/keystore.js';
import { buildServer } from '../src/server.js';
import { CapabilityBus } from '../src/bus/index.js';
import { createWebSearchToolWithDeps } from '../src/bus/builtins/web_search.js';
import { createWebFetchToolWithDeps } from '../src/bus/builtins/web_fetch.js';
import { createFileReadTool } from '../src/bus/builtins/file_read.js';
import { createFileSearchTool } from '../src/bus/builtins/file_search.js';
import { CostsRepo, FilesRepo, FileChunksRepo, ResearchRepo } from '../src/db/repos/index.js';
import { buildResearchDraftSkeleton, buildResearchPlan, buildResearchTasks } from '../src/research/planner.js';
import { ResearchRunner } from '../src/research/task-runner.js';

const bearer = 'test_bearer_runner';

function hermeticFetch(url: string | URL | Request, _init?: RequestInit): Promise<Response> {
  const target = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
  const u = new URL(target);
  if (u.hostname.endsWith('duckduckgo.com')) {
    return Promise.resolve(
      new Response(
        `<a class="result__a" href="https://example.com/ai-coding-2026">2026 AI Coding 总览</a>
         <a class="result__snippet">AI coding 在 2026 年的关键趋势与产品对比。</a>
         <a class="result__a" href="https://example.com/landscape">国产 AI Coding 全景</a>
         <a class="result__snippet">主要厂商定位、价格与分发策略概览。</a>
         <a class="result__a" href="https://example.com/risks">风险与争议</a>
         <a class="result__snippet">关于 AI coding 工具的安全与版权讨论。</a>`,
        { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
      ),
    );
  }
  if (u.hostname === 'example.com') {
    return Promise.resolve(
      new Response(
        `<!doctype html><html><head><title>AI Coding 2026 全景</title></head><body>
          <h1>AI Coding 2026 全景</h1>
          <p>本文梳理了 2026 年 AI Coding 的主要厂商、价格策略与开发者生态变化。</p>
        </body></html>`,
        { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
      ),
    );
  }
  return Promise.resolve(new Response('', { status: 404 }));
}

describe('research runner', () => {
  let app: FastifyInstance;
  let dbPath: string;
  let db: ReturnType<typeof openDb>;
  let runner: ResearchRunner;
  let repo: ResearchRepo;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `taori-runner-${Date.now()}-${Math.random()}.db`);
    db = openDb(dbPath);
    const costs = new CostsRepo(db);
    const files = new FilesRepo(db);
    const chunks = new FileChunksRepo(db);
    const bus = new CapabilityBus(costs);
    bus.register(createFileReadTool(files));
    bus.register(createFileSearchTool({ filesRepo: files, chunksRepo: chunks }));
    bus.register(createWebSearchToolWithDeps({ fetch: hermeticFetch as typeof fetch }));
    bus.register(createWebFetchToolWithDeps({ fetch: hermeticFetch as typeof fetch }));

    repo = new ResearchRepo(db);
    runner = new ResearchRunner({ repo, bus });
    app = buildServer({
      config: {
        port: 0,
        bearer,
        dbPath,
        controlUrl: null,
        controlBearer: null,
        isDev: false,
        version: '0.0.0-test',
      },
      db,
      control: new ControlClient({ url: null, bearer: null }),
      keystore: new MemoryStore(),
      startedAt: Date.now(),
      bus,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    fs.rmSync(dbPath, { force: true });
  });

  it('runs the full pipeline: search → sources → draft → claims', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/v1/research/sessions',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: {
        title: 'AI Coding 2026',
        objective: '梳理 2026 年 AI Coding 的格局、价格与风险。',
        output_kind: 'report',
        budget_mode: 'balanced',
      },
    });
    const created = create.json() as { id: string };

    await app.inject({
      method: 'POST',
      url: `/v1/research/sessions/${created.id}/start`,
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: { confirm: true },
    });

    // Server-side runner was started via the route; reuse the same DB+bus to
    // drive it deterministically in-test as well (idempotent).
    await runner.start(created.id);

    const detail = repo.getDetail(created.id);
    expect(detail).toBeTruthy();
    expect(detail?.session.status === 'completed' || detail?.session.status === 'running').toBe(true);
    expect(detail!.sources.length).toBeGreaterThan(0);
    expect(detail!.claims.length).toBeGreaterThan(0);
    expect(detail!.session.draft_markdown).toContain('## 关键问题与证据');
    expect(detail!.session.final_markdown).toBe(detail!.session.draft_markdown);
    expect(String(detail!.sources[0]?.metadata?.query ?? '')).toBeTruthy();
    expect(String(detail!.sources[0]?.metadata?.question_id ?? '')).toBeTruthy();
    expect(Array.isArray(detail!.tasks.find((task) => task.kind === 'search')?.output?.rounds)).toBe(true);
    expect(detail!.claims.some((claim) => claim.support_status !== 'unverified')).toBe(true);
    // All search/summarize/verify tasks should have left the queue.
    const queued = detail!.tasks.filter((t) => t.status === 'queued');
    expect(queued).toHaveLength(0);
  }, 30_000);

  it('pauses instead of claiming completion when searches return no usable results', async () => {
    const costs = new CostsRepo(db);
    const bus = new CapabilityBus(costs);
    bus.register(createWebSearchToolWithDeps({
      fetch: (() => Promise.resolve(new Response('<html></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }))) as typeof fetch,
    }));
    bus.register(createWebFetchToolWithDeps({ fetch: hermeticFetch as typeof fetch }));
    const emptyRunner = new ResearchRunner({ repo, bus });

    const created = repo.create({
      title: '空结果研究',
      objective: '验证没有搜索结果时不会显示为已完成。',
      output_kind: 'report',
      budget_mode: 'balanced',
    });
    const plan = buildResearchPlan({
      title: created.title,
      objective: created.objective,
      outputKind: created.output_kind,
      budgetMode: created.budget_mode,
      constraints: created.constraints,
    });
    repo.update(created.id, {
      plan,
      status: 'running',
      stage: 'planning',
      started_at: Date.now(),
      draft_markdown: buildResearchDraftSkeleton(created, plan),
    });
    repo.replaceTasks(created.id, buildResearchTasks({
      plan,
      title: created.title,
      objective: created.objective,
    }));

    await emptyRunner.start(created.id);

    const detail = repo.getDetail(created.id);
    expect(detail).toBeTruthy();
    expect(detail!.session.status).toBe('paused');
    expect(detail!.tasks.some((t) => t.status === 'failed')).toBe(true);
    expect(detail!.sources).toHaveLength(0);
    expect(detail!.claims).toHaveLength(0);
    expect(detail!.tasks.find((t) => t.kind === 'summarize')?.status).toBe('failed');
    expect(detail!.tasks.find((t) => t.kind === 'verify_citation')?.status).toBe('skipped');
  }, 30_000);

  it('expands deep research searches across multiple rounds before synthesis', async () => {
    const costs = new CostsRepo(db);
    const bus = new CapabilityBus(costs);
    bus.register(createWebSearchToolWithDeps({
      fetch: ((url: string | URL | Request) => {
        const target = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
        const query = new URL(target).searchParams.get('q') ?? '';
        if (query.includes('官方') || query.includes('文档')) {
          return Promise.resolve(new Response(
            `<a class="result__a" href="https://docs.vendor.example/pricing">官方定价</a>
             <a class="result__snippet">官方文档提供 API 定价、SLA 与限制。</a>
             <a class="result__a" href="https://status.vendor.example/sla">服务承诺</a>
             <a class="result__snippet">官方状态页说明 SLA 和地域可用性。</a>`,
            { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
          ));
        }
        return Promise.resolve(new Response(
          `<a class="result__a" href="https://example.com/overview">行业综述</a>
           <a class="result__snippet">概述各家产品现状，但站点覆盖有限。</a>`,
          { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
        ));
      }) as typeof fetch,
    }));
    bus.register(createWebFetchToolWithDeps({
      fetch: ((url: string | URL | Request) => {
        const target = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
        const u = new URL(target);
        return Promise.resolve(new Response(
          `<!doctype html><html><head><title>${u.hostname}</title></head><body><p>${u.hostname} 提供了更具体的官方说明。</p></body></html>`,
          { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
        ));
      }) as typeof fetch,
    }));
    const deepRunner = new ResearchRunner({ repo, bus });

    const created = repo.create({
      title: '国产模型 API 对比',
      objective: '对比主要国产模型 API 的价格、SLA 与可用性。',
      output_kind: 'comparison',
      budget_mode: 'deep',
    });
    const plan = buildResearchPlan({
      title: created.title,
      objective: created.objective,
      outputKind: created.output_kind,
      budgetMode: created.budget_mode,
      constraints: created.constraints,
    });
    repo.update(created.id, {
      plan,
      status: 'running',
      stage: 'planning',
      started_at: Date.now(),
      draft_markdown: buildResearchDraftSkeleton(created, plan),
    });
    repo.replaceTasks(created.id, buildResearchTasks({
      plan,
      title: created.title,
      objective: created.objective,
    }));

    await deepRunner.start(created.id);

    const detail = repo.getDetail(created.id);
    const searchTask = detail?.tasks.find((task) => task.kind === 'search');
    expect(searchTask).toBeTruthy();
    expect(Array.isArray(searchTask?.output?.rounds)).toBe(true);
    expect((searchTask?.output?.rounds as Array<unknown>).length).toBeGreaterThan(1);
    expect(Number(searchTask?.output?.unique_hosts ?? 0)).toBeGreaterThanOrEqual(2);
  }, 30_000);
});
