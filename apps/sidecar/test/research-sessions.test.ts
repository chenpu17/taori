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
    const created = create.json() as { id: string; status: string; stage: string };
    expect(created.status).toBe('draft');
    expect(created.stage).toBe('scoping');

    const list = await app.inject({
      method: 'GET',
      url: '/v1/research/sessions',
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(list.statusCode).toBe(200);
    const body = list.json() as { research_sessions: Array<{ id: string }> };
    expect(body.research_sessions.map((item) => item.id)).toContain(created.id);
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
      session: { status: string; stage: string; plan: { key_questions: unknown[] } | null };
      tasks: unknown[];
    };
    expect(previewBody.session.status).toBe('reviewing');
    expect(previewBody.session.stage).toBe('planning');
    expect(previewBody.session.plan?.key_questions.length).toBeGreaterThan(0);
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
    expect((resumed.json() as { session: { status: string } }).session.status).toBe('running');

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
