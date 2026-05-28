import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ControlClient } from '../src/control/client.js';
import { openDb } from '../src/db/index.js';
import { MemoryStore } from '../src/keystore.js';
import { buildServer } from '../src/server.js';
import { ResearchRepo } from '../src/db/repos/index.js';

const bearer = 'test_bearer_research';

describe('research sessions', () => {
  let app: FastifyInstance;
  let dbPath: string;
  let db: ReturnType<typeof openDb>;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `taori-research-${Date.now()}-${Math.random()}.db`);
    db = openDb(dbPath);
    app = buildServer({
      config: {
        port: 0,
        bearer,
        dbPath,
        controlUrl: null,
        controlBearer: null,
        isDev: false,
        version: '0.0.0-test',
        testHooks: {
          hermeticWeb: false,
          hermeticAiPlanner: true,
          forceClassification: false,
          forceImageResult: false,
        },
      },
      db,
      control: new ControlClient({ url: null, bearer: null }),
      keystore: new MemoryStore(),
      startedAt: Date.now(),
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    fs.rmSync(dbPath, { force: true });
  });

  it('creates and lists research sessions', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/v1/research/sessions',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: {
        title: 'AI Coding 格局',
        objective: '对比主要 AI Coding 产品定位、价格和分发策略。',
        output_kind: 'comparison',
        budget_mode: 'balanced',
        constraints: {
          time_range: '近 12 个月',
          must_cover: ['价格', '定位'],
        },
      },
    });
    expect(create.statusCode).toBe(201);
    const created = create.json() as { id: string; status: string; stage: string; plan_origin: string };
    expect(created.status).toBe('reviewing');
    expect(created.stage).toBe('planning');
    expect(created.plan_origin).toBe('pending');

    const list = await app.inject({
      method: 'GET',
      url: '/v1/research/sessions',
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(list.statusCode).toBe(200);
    const body = list.json() as { research_sessions: Array<{ id: string }> };
    expect(body.research_sessions.map((item) => item.id)).toContain(created.id);
  });

  it('asks for clarification before planning when the topic is broad and underspecified', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/v1/research/sessions',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: {
        title: 'AI Coding 市场格局',
        objective: '分析 AI Coding 市场格局与主要玩家差异。',
        output_kind: 'comparison',
        budget_mode: 'balanced',
      },
    });
    expect(create.statusCode).toBe(201);
    const created = create.json() as {
      id: string;
      status: string;
      stage: string;
      plan_messages: Array<{ role: string; content: string }> | null;
    };
    expect(created.status).toBe('reviewing');
    expect(created.stage).toBe('scoping');
    expect(created.plan_messages?.[0]?.role).toBe('assistant');
    expect(created.plan_messages?.[0]?.content).toContain('确认几个边界');

    const revised = await app.inject({
      method: 'POST',
      url: `/v1/research/sessions/${created.id}/plan/revise`,
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: {
        feedback: '聚焦中国市场，近 12 个月，优先价格、稳定性和 SLA，中英资料都可以。',
      },
    });
    expect(revised.statusCode).toBe(200);
    const revisedBody = revised.json() as {
      session: {
        status: string;
        stage: string;
        plan: { summary: string } | null;
        plan_origin: string;
        constraints: { region: string | null; time_range: string | null; language: string | null; must_cover: string[] };
      };
    };
    expect(revisedBody.session.status).toBe('reviewing');
    expect(revisedBody.session.stage).toBe('planning');
    expect(revisedBody.session.plan).not.toBeNull();
    expect(revisedBody.session.plan_origin).toBe('ai');
    expect(revisedBody.session.constraints.region).toBe('中国');
    expect(revisedBody.session.constraints.time_range).toBe('近 12 个月');
    expect(revisedBody.session.constraints.language).toBe('中文 + 英文');
    expect(revisedBody.session.constraints.must_cover).toContain('价格');
    expect(revisedBody.session.constraints.must_cover).toContain('SLA');
  });

  it('previews a plan and confirms start with seeded tasks', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/v1/research/sessions',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: {
        title: '国产模型价格变化',
        objective: '梳理近一年的国产大模型价格趋势和对开发者的影响。',
        output_kind: 'report',
        budget_mode: 'fast',
      },
    });
    const created = create.json() as { id: string };

    const preview = await app.inject({
      method: 'POST',
      url: `/v1/research/sessions/${created.id}/start`,
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: {},
    });
    expect(preview.statusCode).toBe(200);
    const previewBody = preview.json() as {
      session: { status: string; stage: string; plan: { key_questions: unknown[] } | null; plan_origin: string };
      tasks: unknown[];
    };
    expect(previewBody.session.status).toBe('reviewing');
    expect(previewBody.session.stage).toBe('planning');
    expect(previewBody.session.plan?.key_questions.length).toBeGreaterThan(0);
    expect(previewBody.session.plan_origin).toBe('ai');
    expect(previewBody.tasks).toHaveLength(0);

    const confirm = await app.inject({
      method: 'POST',
      url: `/v1/research/sessions/${created.id}/start`,
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: { confirm: true },
    });
    expect(confirm.statusCode).toBe(200);
    const confirmBody = confirm.json() as {
      session: { status: string; draft_markdown: string | null; started_at: number | null };
      tasks: Array<{ status: string; title: string; input?: { query?: string } }>;
    };
    expect(confirmBody.session.status).toBe('running');
    expect(confirmBody.session.started_at).not.toBeNull();
    expect(confirmBody.session.draft_markdown).toContain('# 国产模型价格变化');
    expect(confirmBody.tasks.length).toBeGreaterThan(1);
    expect(confirmBody.tasks.some((task) => task.status === 'queued')).toBe(true);
    expect(confirmBody.tasks.some((task) => task.title.includes('国产模型价格变化'))).toBe(true);
    expect(confirmBody.tasks.some((task) => task.input?.query?.includes('国产模型价格变化'))).toBe(true);
  });

  it('revises a generated plan before confirm with AI updates', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/v1/research/sessions',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: {
        title: '国产模型价格变化',
        objective: '梳理近一年的国产大模型价格趋势和对开发者的影响。',
        output_kind: 'report',
        budget_mode: 'balanced',
        constraints: {
          time_range: '近 12 个月',
          region: '全球',
          language: '中文 + 英文',
          must_cover: ['价格'],
        },
      },
    });
    const created = create.json() as { id: string };

    const preview = await app.inject({
      method: 'POST',
      url: `/v1/research/sessions/${created.id}/start`,
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: {},
    });
    expect(preview.statusCode).toBe(200);

    const revised = await app.inject({
      method: 'POST',
      url: `/v1/research/sessions/${created.id}/plan/revise`,
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: {
        feedback: '改为聚焦中国市场，优先中文资料，并加入价格战和免费额度维度。',
      },
    });
    expect(revised.statusCode).toBe(200);
    const revisedBody = revised.json() as {
      session: {
        status: string;
        constraints: {
          region: string | null;
          language: string | null;
          must_cover: string[];
        };
        plan: {
          summary: string;
        } | null;
        plan_origin: string;
        plan_messages: Array<{ role: string; content: string }>;
      };
      tasks: unknown[];
    };
    expect(revisedBody.session.status).toBe('reviewing');
    expect(revisedBody.session.constraints.region).toBe('中国');
    expect(revisedBody.session.constraints.language).toBe('中文');
    expect(revisedBody.session.constraints.must_cover).toContain('价格战');
    expect(revisedBody.session.constraints.must_cover).toContain('免费额度');
    expect(revisedBody.session.plan?.summary).toContain('区域：中国');
    expect(revisedBody.session.plan_origin).toBe('ai');
    expect(revisedBody.session.plan_messages.at(-1)?.role).toBe('assistant');
    expect(revisedBody.tasks).toHaveLength(0);
  });

  it('marks the session failed when plan generation exhausts retries', async () => {
    await app.close();
    app = buildServer({
      config: {
        port: 0,
        bearer,
        dbPath,
        controlUrl: null,
        controlBearer: null,
        isDev: false,
        version: '0.0.0-test',
        testHooks: {
          hermeticWeb: false,
          hermeticAiPlanner: false,
          forceClassification: false,
          forceImageResult: false,
        },
      },
      db,
      control: new ControlClient({ url: null, bearer: null }),
      keystore: new MemoryStore(),
      startedAt: Date.now(),
    });
    await app.ready();

    const create = await app.inject({
      method: 'POST',
      url: '/v1/research/sessions',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: {
        title: 'AI Coding 失败案例',
        objective: '对比主要 AI Coding 产品定位、价格和分发策略。',
        output_kind: 'comparison',
        budget_mode: 'balanced',
        constraints: {
          time_range: '近 12 个月',
        },
      },
    });
    expect(create.statusCode).toBe(201);
    const created = create.json() as { id: string };

    await new Promise((resolve) => setTimeout(resolve, 1500));
    const detail = await app.inject({
      method: 'GET',
      url: `/v1/research/sessions/${created.id}`,
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(detail.statusCode).toBe(200);
    const body = detail.json() as {
      session: {
        status: string;
        stage: string;
        plan: { summary: string } | null;
        plan_origin: string;
        plan_messages: Array<{ role: string; content: string }> | null;
      };
    };
    expect(body.session.status).toBe('failed');
    expect(body.session.stage).toBe('planning');
    expect(body.session.plan).toBeNull();
    expect(body.session.plan_origin).toBe('pending');
    expect(body.session.plan_messages?.at(-1)?.content).toContain('研究计划生成失败');
  });

  it('pauses, resumes, cancels, and exports a research session', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/v1/research/sessions',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: {
        title: '浏览器 AI 助手机会',
        objective: '总结浏览器形态 AI 助手的机会点。',
        output_kind: 'decision',
        budget_mode: 'deep',
      },
    });
    const created = create.json() as { id: string };
    await app.inject({
      method: 'POST',
      url: `/v1/research/sessions/${created.id}/start`,
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: { confirm: true },
    });

    const paused = await app.inject({
      method: 'POST',
      url: `/v1/research/sessions/${created.id}/pause`,
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(paused.statusCode).toBe(200);
    expect((paused.json() as { session: { status: string } }).session.status).toBe('paused');

    const resumed = await app.inject({
      method: 'POST',
      url: `/v1/research/sessions/${created.id}/resume`,
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(resumed.statusCode).toBe(200);
    expect(['running', 'completed']).toContain((resumed.json() as { session: { status: string } }).session.status);

    const exported = await app.inject({
      method: 'POST',
      url: `/v1/research/sessions/${created.id}/export`,
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: { format: 'markdown' },
    });
    expect(exported.statusCode).toBe(200);
    const exportBody = exported.json() as { filename: string; content: string };
    expect(exportBody.filename).toMatch(/\.md$/);
    expect(exportBody.content).toContain('## 研究目标');

    const cancelled = await app.inject({
      method: 'POST',
      url: `/v1/research/sessions/${created.id}/cancel`,
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(cancelled.statusCode).toBe(200);
    expect((cancelled.json() as { session: { status: string } }).session.status).toBe('cancelled');
  });

  it('resume requeues a paused run when all searches previously failed with no sources', async () => {
    const repo = new ResearchRepo(db);
    const create = await app.inject({
      method: 'POST',
      url: '/v1/research/sessions',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: {
        title: '浏览器 AI 助手交互趋势',
        objective: '梳理浏览器端 AI 助手的典型交互设计趋势。',
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

    const beforeResume = repo.getDetail(created.id)!;
    for (const task of beforeResume.tasks) {
      if (task.kind === 'search') {
        repo.updateTask(task.id, {
          status: 'failed',
          error: { message: 'web_search returned no usable results' },
          finished_at: Date.now(),
        });
      } else if (task.kind === 'summarize') {
        repo.updateTask(task.id, {
          status: 'failed',
          error: { message: 'missing_sources' },
          finished_at: Date.now(),
        });
      } else if (task.kind === 'verify_citation') {
        repo.updateTask(task.id, {
          status: 'skipped',
          output: { reason: 'missing_sources' },
          finished_at: Date.now(),
        });
      }
    }
    repo.update(created.id, { status: 'paused', stage: 'searching' });

    const resumed = await app.inject({
      method: 'POST',
      url: `/v1/research/sessions/${created.id}/resume`,
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(resumed.statusCode).toBe(200);
    const resumedBody = resumed.json() as {
      session: { status: string; stage: string; draft_markdown: string | null };
      tasks: Array<{ kind: string; status: string; error?: unknown }>;
      sources: unknown[];
      claims: unknown[];
    };
    expect(resumedBody.session.status).toBe('running');
    expect(resumedBody.session.stage).toBe('planning');
    expect(resumedBody.session.draft_markdown).toContain('# 浏览器 AI 助手交互趋势');
    expect(resumedBody.tasks.some((task) => task.kind === 'search' && task.status === 'queued')).toBe(true);
    expect(resumedBody.tasks.some((task) => task.kind === 'search' && task.status === 'failed')).toBe(false);
    expect(resumedBody.sources).toHaveLength(0);
    expect(resumedBody.claims).toHaveLength(0);
  });
});
