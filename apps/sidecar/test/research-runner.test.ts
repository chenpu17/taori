import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
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
    const created = repo.create({
      title: 'AI Coding 2026',
      objective: '梳理 2026 年 AI Coding 的格局、价格与风险。',
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
    expect(String(detail!.sources[0]?.metadata?.source_kind ?? '')).toBeTruthy();
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

  it('classifies source kinds and accumulates research budget from tool costs', async () => {
    const costs = new CostsRepo(db);
    const bus = new CapabilityBus(costs);
    bus.register({
      name: 'builtin.web_search',
      description: 'budgeted search',
      capability: 'web',
      source: 'builtin',
      source_id: 'builtin',
      enabled: true,
      inputSchema: z.object({ query: z.string(), num_results: z.number().optional() }),
      async execute() {
        return {
          output: {
            engine: 'exa',
            results: [
              {
                title: 'Vendor Docs',
                url: 'https://docs.vendor.example/pricing',
                snippet: 'Official API pricing and rate limits.',
              },
              {
                title: 'Independent Review',
                url: 'https://independent.example/review',
                snippet: 'Third-party comparison and field notes.',
              },
            ],
          },
          cost: { actual_usd: 0.12 },
        };
      },
    });
    bus.register({
      name: 'builtin.web_fetch',
      description: 'budgeted fetch',
      capability: 'web',
      source: 'builtin',
      source_id: 'builtin',
      enabled: true,
      inputSchema: z.object({
        url: z.string(),
        format: z.string().optional(),
        max_chars: z.number().optional(),
      }),
      async execute(input) {
        return {
          output: {
            title: input.url.includes('docs.')
              ? 'Vendor Docs'
              : 'Independent Review',
            content: `Fetched details for ${input.url}`,
          },
          cost: { actual_usd: 0.03 },
        };
      },
    });
    const budgetRunner = new ResearchRunner({ repo, bus });

    const created = repo.create({
      title: '研究预算追踪',
      objective: '比较某 API 的官方价格与第三方评价。',
      output_kind: 'brief',
      budget_mode: 'fast',
      budget_limit_usd: 2,
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

    await budgetRunner.start(created.id);

    const detail = repo.getDetail(created.id);
    expect(detail).toBeTruthy();
    expect(detail!.session.budget_spent_usd).toBeGreaterThan(0.1);
    expect(detail!.sources.some((source) => source.metadata?.source_kind === 'official')).toBe(true);
    expect(detail!.tasks.some((task) =>
      task.kind === 'search'
      && Array.isArray(task.output?.rounds)
      && task.output.rounds.some(
        (round) => typeof round === 'object' && round !== null && round.search_track === 'official',
      ))).toBe(true);
  }, 30_000);

  it('recovers from zero-result follow-up searches by broadening queries automatically', async () => {
    const costs = new CostsRepo(db);
    const bus = new CapabilityBus(costs);
    bus.register({
      name: 'builtin.web_search',
      description: 'recovery search',
      capability: 'web',
      source: 'builtin',
      source_id: 'builtin',
      enabled: true,
      inputSchema: z.object({ query: z.string(), num_results: z.number().optional() }),
      async execute(input) {
        const query = input.query;
        if (/DeepSeek.*pricing|API pricing token price/i.test(query)) {
          return {
            output: {
              engine: 'exa',
              results: [
                {
                  title: 'DeepSeek API Pricing',
                  url: 'https://api-docs.deepseek.com/quick_start/pricing',
                  snippet: 'Official DeepSeek API pricing and token rates.',
                },
              ],
            },
            cost: { actual_usd: 0.05 },
          };
        }
        return {
          output: {
            engine: 'exa',
            results: [],
          },
          cost: { actual_usd: 0.01 },
        };
      },
    });
    bus.register({
      name: 'builtin.web_fetch',
      description: 'recovery fetch',
      capability: 'web',
      source: 'builtin',
      source_id: 'builtin',
      enabled: true,
      inputSchema: z.object({
        url: z.string(),
        format: z.string().optional(),
        max_chars: z.number().optional(),
      }),
      async execute(input) {
        return {
          output: {
            title: 'DeepSeek API Pricing',
            content: `Fetched ${input.url}`,
          },
          cost: { actual_usd: 0.01 },
        };
      },
    });
    const recoveryRunner = new ResearchRunner({ repo, bus });

    const created = repo.create({
      title: '中国主流大模型 API 对比',
      objective: '对比中国主流大模型 API 的模型清单与 token 价格。',
      output_kind: 'brief',
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
    repo.replaceTasks(created.id, [
      {
        kind: 'search',
        status: 'queued',
        title: '补充检索：官方价格',
        input: {
          question_id: 'q-gap',
          question: '中国主流大模型API官方模型清单与token价格',
          reason: '信息空白补充',
          query: '中国主流大模型API官方模型清单与token价格',
        },
      },
      {
        kind: 'summarize',
        status: 'queued',
        title: '整理证据并生成结构化草稿',
        input: { sections: ['摘要', '关键事实'] },
      },
      {
        kind: 'verify_citation',
        status: 'queued',
        title: '校验关键结论的引用充分性',
        input: {},
      },
    ]);

    await recoveryRunner.start(created.id);

    const detail = repo.getDetail(created.id);
    const searchTask = detail?.tasks.find((task) => task.kind === 'search');
    expect(searchTask?.status).toBe('completed');
    expect(searchTask?.output?.recovery_attempted).toBe(true);
    expect(searchTask?.output?.recovery_successful).toBe(true);
    expect(Array.isArray(searchTask?.output?.recovery_queries)).toBe(true);
    expect(
      Array.isArray(searchTask?.output?.rounds)
      && searchTask.output.rounds.some(
        (round) => typeof round === 'object' && round !== null && round.phase === 'recovery' && Number(round.hits ?? 0) > 0,
      ),
    ).toBe(true);
    expect(detail?.sources.some((source) => source.locator.includes('deepseek.com'))).toBe(true);
  }, 30_000);

  it('records no-usable-source coverage without failing an individual search branch', async () => {
    const costs = new CostsRepo(db);
    const bus = new CapabilityBus(costs);
    bus.register(createWebSearchToolWithDeps({
      fetch: (() => Promise.resolve(new Response('<html></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }))) as typeof fetch,
    }));
    bus.register(createWebFetchToolWithDeps({ fetch: hermeticFetch as typeof fetch }));
    const failingRunner = new ResearchRunner({ repo, bus });

    const created = repo.create({
      title: '国产模型 API 可用性研究',
      objective: '补充中国主流大模型 API 的 SLA、并发限制与稳定性信息。',
      output_kind: 'comparison',
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
    repo.replaceTasks(created.id, [
      {
        kind: 'search',
        status: 'queued',
        title: '补充检索：可用性指标',
        input: {
          question_id: 'q-gap-availability',
          question: '中国主流大模型API可用性指标（SLA、并发限制等）',
          reason: '信息空白补充',
          query: '中国主流大模型API可用性指标（SLA、并发限制等）',
        },
      },
      {
        kind: 'summarize',
        status: 'queued',
        title: '整理证据并生成结构化草稿',
        input: { sections: ['摘要', '关键事实'] },
      },
      {
        kind: 'verify_citation',
        status: 'queued',
        title: '校验关键结论的引用充分性',
        input: {},
      },
    ]);

    await failingRunner.start(created.id);

    const detail = repo.getDetail(created.id);
    const searchTask = detail?.tasks.find((task) => task.kind === 'search');
    expect(searchTask?.status).toBe('completed');
    expect(searchTask?.output?.recovery_attempted).toBe(true);
    expect(searchTask?.output?.failure_reason).toBe('needs_official_sources');
    expect(searchTask?.output?.coverage_status).toBe('no_usable_sources');
    expect(detail?.session.status).toBe('paused');
  }, 30_000);

  it('continues synthesis when only some follow-up searches have no usable sources', async () => {
    const costs = new CostsRepo(db);
    const bus = new CapabilityBus(costs);
    bus.register({
      name: 'builtin.web_search',
      description: 'partial coverage search',
      capability: 'web',
      source: 'builtin',
      source_id: 'builtin',
      enabled: true,
      inputSchema: z.object({ query: z.string(), num_results: z.number().optional() }),
      async execute(input) {
        const query = input.query;
        if (/官方价格|定价|pricing/i.test(query)) {
          return {
            output: {
              engine: 'exa',
              results: [
                {
                  title: 'Vendor API Pricing',
                  url: 'https://docs.vendor.example/pricing',
                  snippet: 'Official API pricing and model list for the vendor.',
                },
              ],
            },
          };
        }
        return { output: { engine: 'exa', results: [] } };
      },
    });
    bus.register(createWebFetchToolWithDeps({
      fetch: (() => Promise.resolve(new Response(
        '<html><head><title>Vendor API Pricing</title></head><body>Official pricing evidence.</body></html>',
        { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
      ))) as typeof fetch,
    }));
    const partialRunner = new ResearchRunner({ repo, bus });

    const created = repo.create({
      title: '模型 API 选型',
      objective: '比较模型 API 的价格与延迟。',
      output_kind: 'brief',
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
    repo.replaceTasks(created.id, [
      {
        kind: 'search',
        status: 'queued',
        title: '补充检索：官方价格',
        input: {
          question_id: 'q-price',
          question: '模型 API 官方价格',
          reason: '价格口径',
          query: '模型 API 官方价格 定价 pricing',
        },
      },
      {
        kind: 'search',
        status: 'queued',
        title: '补充检索：延迟实测',
        input: {
          question_id: 'q-latency',
          question: '模型 API 首 token 延迟实测',
          reason: '速度表现',
          query: '模型 API 首 token 延迟实测 benchmark',
        },
      },
      {
        kind: 'summarize',
        status: 'queued',
        title: '整理证据并生成结构化草稿',
        input: { sections: ['摘要', '关键事实'] },
      },
      {
        kind: 'verify_citation',
        status: 'queued',
        title: '校验关键结论的引用充分性',
        input: {},
      },
    ]);

    await partialRunner.start(created.id);

    const detail = repo.getDetail(created.id);
    const latencyTask = detail?.tasks.find((task) => task.title.includes('延迟实测'));
    expect(detail?.session.status).toBe('completed');
    expect(detail?.sources.length).toBeGreaterThan(0);
    expect(detail?.session.final_markdown).toContain('## 关键问题与证据');
    expect(latencyTask?.status).toBe('completed');
    expect(latencyTask?.output?.coverage_status).toBe('no_usable_sources');
    expect(detail?.tasks.find((task) => task.kind === 'summarize')?.status).toBe('completed');
  }, 30_000);

  it('tries Exa explicitly after an empty builtin engine round in deep research', async () => {
    const costs = new CostsRepo(db);
    const bus = new CapabilityBus(costs);
    bus.register({
      name: 'builtin.web_search',
      description: 'engine ladder search',
      capability: 'web',
      source: 'builtin',
      source_id: 'builtin',
      enabled: true,
      inputSchema: z.object({
        query: z.string(),
        num_results: z.number().optional(),
        engine: z.enum(['duckduckgo', 'exa', 'bocha']).optional(),
      }),
      async execute(input) {
        if (input.engine === 'exa') {
          return {
            output: {
              engine: 'exa',
              results: [
                {
                  title: 'Exa Pricing',
                  url: 'https://example.com/exa-pricing',
                  snippet: 'Exa found the official pricing comparison page.',
                },
              ],
            },
          };
        }
        return {
          output: {
            engine: input.engine ?? 'duckduckgo',
            results: [],
          },
        };
      },
    });
    bus.register(createWebFetchToolWithDeps({ fetch: hermeticFetch as typeof fetch }));
    const ladderRunner = new ResearchRunner({ repo, bus });

    const created = repo.create({
      title: '中国主流大模型 API 定价',
      objective: '对比中国主流大模型 API 的官方定价。',
      output_kind: 'brief',
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
    repo.replaceTasks(created.id, [
      {
        kind: 'search',
        status: 'queued',
        title: '补充检索：官方定价',
        input: {
          question_id: 'q-gap-pricing',
          question: '中国主流大模型API官方定价对比',
          reason: '信息空白补充',
          query: '中国主流大模型API官方定价对比',
        },
      },
      {
        kind: 'summarize',
        status: 'queued',
        title: '整理证据并生成结构化草稿',
        input: { sections: ['摘要', '关键事实'] },
      },
      {
        kind: 'verify_citation',
        status: 'queued',
        title: '校验关键结论的引用充分性',
        input: {},
      },
    ]);

    await ladderRunner.start(created.id);

    const detail = repo.getDetail(created.id);
    const searchTask = detail?.tasks.find((task) => task.kind === 'search');
    expect(searchTask?.status).toBe('completed');
    expect(searchTask?.output?.search_engine).toBe('exa');
    expect(searchTask?.output?.engine_attempts).toEqual(expect.arrayContaining(['duckduckgo', 'exa']));
    expect(
      Array.isArray(searchTask?.output?.rounds)
      && searchTask.output.rounds.some(
        (round) => typeof round === 'object' && round !== null && round.requested_engine === 'exa' && Number(round.hits ?? 0) > 0,
      ),
    ).toBe(true);
  }, 30_000);
});
