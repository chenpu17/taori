import type { FastifyInstance } from 'fastify';
import {
  ResearchSessionCreateSchema,
  ResearchSessionExportRequestSchema,
  ResearchSessionStartRequestSchema,
  ResearchPlanReviseRequestSchema,
  TaoriError,
} from '@taori/shared';
import type { PlanMessage, ResearchConstraints, ResearchSession } from '@taori/shared';
import type { BuildServerArgs } from '../server.js';
import { ConversationsRepo, MemoriesRepo, ModelsRepo, ProvidersRepo, ResearchRepo } from '../db/repos/index.js';
import {
  buildResearchDraftSkeleton,
  buildResearchPlan,
  buildResearchTasks,
} from '../research/planner.js';
import { generateAIPlan, revisePlan } from '../research/ai-planner.js';
import type { ResearchRunner } from '../research/task-runner.js';
import type { KeyStore } from '../keystore.js';

interface ResearchRouteDeps extends BuildServerArgs {
  researchRunner?: ResearchRunner;
  keystore: KeyStore;
}

function shouldRestartFailedSearchRun(detail: ReturnType<ResearchRepo['getDetail']>): boolean {
  if (!detail) return false;
  if (detail.sources.length > 0) return false;
  return detail.tasks.some((task) =>
    (task.kind === 'search' && task.status === 'failed') ||
    ((task.kind === 'summarize' || task.kind === 'verify_citation') && task.status !== 'completed'),
  );
}

function parseOrValidation<T>(
  result: { success: true; data: T } | { success: false; error: { errors: Array<{ message: string }> } },
): T {
  if (result.success) return result.data;
  throw new TaoriError({
    code: 'validation_error',
    message: result.error.errors.map((e) => e.message).join('; '),
  });
}

function shouldClarifyBeforePlanning(session: Pick<ResearchSession, 'objective' | 'constraints'>): boolean {
  const objective = session.objective.trim();
  if (!objective) return false;
  if (session.constraints.time_range || session.constraints.region || session.constraints.language) return false;
  if ((session.constraints.must_cover ?? []).length > 0) return false;
  if (session.constraints.min_citations != null) return false;
  if (objective.length > 160) return false;
  return /(市场格局|主要玩家|竞争格局|机会点|行业趋势|生态|全景|定位|策略|差异)/.test(objective);
}

function buildClarificationMessage(session: Pick<ResearchSession, 'objective' | 'constraints'>): string {
  const prompts: string[] = [];
  if (!session.constraints.region) prompts.push('这次更想聚焦哪个市场/地区？例如中国、北美、全球。');
  if (!session.constraints.time_range) prompts.push('时间范围更希望看近 6/12/24 个月，还是更长期？');
  if ((session.constraints.must_cover ?? []).length === 0) {
    prompts.push('最优先的比较维度是哪几个？例如价格、速度、可用性、风险、生态、SLA。');
  }
  if (!session.constraints.language && prompts.length < 3) {
    prompts.push('来源语言只看中文，还是中英都可以？');
  }
  return [
    '为把这次研究做深，我先确认几个边界，再给你计划：',
    ...prompts.slice(0, 3).map((item, index) => `${index + 1}. ${item}`),
    '',
    '直接回复一句话即可，例如：聚焦中国市场，近 12 个月，优先价格、稳定性和 SLA，中英资料都可以。',
  ].join('\n');
}

function mergeClarifiedConstraints(current: ResearchConstraints, feedback: string): ResearchConstraints {
  const next: ResearchConstraints = {
    time_range: current.time_range ?? null,
    region: current.region ?? null,
    language: current.language ?? null,
    must_cover: [...(current.must_cover ?? [])],
    min_citations: current.min_citations ?? null,
  };
  const text = feedback.trim();
  if (!next.time_range) {
    if (/近\s*6\s*个?月|最近半年|过去半年/.test(text)) next.time_range = '近 6 个月';
    else if (/近\s*12\s*个?月|最近一年|过去一年|近一年/.test(text)) next.time_range = '近 12 个月';
    else if (/近\s*24\s*个?月|最近两年|过去两年/.test(text)) next.time_range = '近 24 个月';
    else if (/近\s*3\s*年|最近三年|过去三年/.test(text)) next.time_range = '近 3 年';
  }
  if (!next.region) {
    if (/(中国|国内)/.test(text)) next.region = '中国';
    else if (/(北美|美国|加拿大)/.test(text)) next.region = '北美';
    else if (/(欧洲|欧盟)/.test(text)) next.region = '欧洲';
    else if (/全球/.test(text)) next.region = '全球';
    else if (/(亚太|亚洲)/.test(text)) next.region = '亚太';
  }
  if (!next.language) {
    if (/(中英|中文.*英文|英文.*中文)/.test(text)) next.language = '中文 + 英文';
    else if (/中文/.test(text)) next.language = '中文';
    else if (/英文/.test(text)) next.language = '英文';
  }
  const mustCoverTerms = ['价格', '速度', '可用性', '风险', '生态', 'SLA', '稳定性', '文档', '社区', '延迟', '并发', '成本'];
  const mustCover = new Set(next.must_cover);
  for (const term of mustCoverTerms) {
    if (text.includes(term)) mustCover.add(term);
  }
  next.must_cover = Array.from(mustCover);
  return next;
}

function buildPlanFallback(session: ResearchSession, constraints: ResearchConstraints, notes: string[] = []) {
  return buildResearchPlan({
    title: session.title,
    objective: session.objective,
    outputKind: session.output_kind,
    budgetMode: session.budget_mode,
    constraints,
    planningNotes: notes,
  });
}

export function registerResearchRoute(app: FastifyInstance, deps: ResearchRouteDeps): void {
  const repo = new ResearchRepo(deps.db);
  const conversations = new ConversationsRepo(deps.db);
  const runner = deps.researchRunner;
  const plannerDeps = {
    memories: new MemoriesRepo(deps.db),
    modelsRepo: new ModelsRepo(deps.db),
    providersRepo: new ProvidersRepo(deps.db),
    keystore: deps.keystore,
    log: app.log,
  };

  app.get('/v1/research/sessions', async () => ({
    research_sessions: repo.list(),
  }));

  app.post('/v1/research/sessions', async (req, reply) => {
    const body = parseOrValidation(ResearchSessionCreateSchema.safeParse(req.body));
    if (body.conversation_id && !conversations.get(body.conversation_id)) {
      throw new TaoriError({
        code: 'not_found',
        message: `Conversation ${body.conversation_id} not found`,
      });
    }
    const session = repo.create(body);
    if (shouldClarifyBeforePlanning(session)) {
      repo.update(session.id, {
        stage: 'scoping',
        plan_messages: [{
          role: 'assistant',
          content: buildClarificationMessage(session),
          ts: Date.now(),
        }],
      });
      const scoped = repo.getDetail(session.id)?.session ?? session;
      reply.code(201);
      return scoped;
    }

    repo.update(session.id, { stage: 'planning' });
    setImmediate(() => {
      const fallbackPlan = () => buildPlanFallback(session, session.constraints);
      void generateAIPlan(session, plannerDeps).then((plan) => {
        repo.update(session.id, { plan: plan ?? fallbackPlan() });
      }).catch((err: unknown) => {
        app.log.error({ err }, 'Background AI planning failed');
        repo.update(session.id, { plan: fallbackPlan() });
      });
    });
    const withSession = repo.getDetail(session.id)?.session ?? session;
    reply.code(201);
    return withSession;
  });

  app.get<{ Params: { id: string } }>('/v1/research/sessions/:id', async (req) => {
    const detail = repo.getDetail(req.params.id);
    if (!detail) {
      throw new TaoriError({ code: 'not_found', message: `Research session ${req.params.id} not found` });
    }
    return detail;
  });

  app.get<{ Params: { id: string } }>('/v1/research/sessions/:id/tasks', async (req) => ({
    tasks: repo.listTasks(req.params.id),
  }));

  app.get<{ Params: { id: string } }>('/v1/research/sessions/:id/sources', async (req) => ({
    sources: repo.listSources(req.params.id),
  }));

  app.get<{ Params: { id: string } }>('/v1/research/sessions/:id/claims', async (req) => ({
    claims: repo.listClaims(req.params.id),
  }));

  // Revise research plan via conversational feedback
  app.post<{ Params: { id: string } }>('/v1/research/sessions/:id/plan/revise', async (req) => {
    const body = parseOrValidation(ResearchPlanReviseRequestSchema.safeParse(req.body));
    const current = repo.get(req.params.id);
    if (!current) {
      throw new TaoriError({ code: 'not_found', message: `Research session ${req.params.id} not found` });
    }
    if (current.status !== 'reviewing') {
      throw new TaoriError({
        code: 'validation_error',
        message: `Cannot revise plan when session is in status ${current.status}`,
      });
    }

    const existingMessages = current.plan_messages ?? [];
    const userMessage = { role: 'user' as const, content: body.feedback, ts: Date.now() };

    if (!current.plan) {
      const nextConstraints = mergeClarifiedConstraints(current.constraints, body.feedback);
      const nextMessages: PlanMessage[] = [...existingMessages, userMessage];
      const planningSession: ResearchSession = {
        ...current,
        constraints: nextConstraints,
        stage: 'planning',
        plan_messages: nextMessages,
      };
      const aiPlan = await generateAIPlan(planningSession, plannerDeps);
      const plan = aiPlan ?? buildPlanFallback(current, nextConstraints, [body.feedback]);
      repo.update(current.id, {
        stage: 'planning',
        constraints: nextConstraints,
        plan,
        plan_messages: [
          ...nextMessages,
          { role: 'assistant', content: plan.summary, ts: Date.now() },
        ],
      });
    } else {
      const result = await revisePlan(current, body.feedback, plannerDeps);

      if (result) {
        const assistantMessage = { role: 'assistant' as const, content: result.assistantMessage, ts: Date.now() };
        repo.update(current.id, {
          plan: result.plan,
          plan_messages: [...existingMessages, userMessage, assistantMessage],
        });
      } else {
        repo.update(current.id, {
          plan_messages: [...existingMessages, userMessage],
        });
      }
    }

    const detail = repo.getDetail(current.id);
    if (!detail) {
      throw new TaoriError({ code: 'not_found', message: `Research session ${current.id} not found` });
    }
    return detail;
  });

  app.post<{ Params: { id: string } }>('/v1/research/sessions/:id/start', async (req) => {
    const body = parseOrValidation(ResearchSessionStartRequestSchema.safeParse(req.body ?? {}));
    const current = repo.get(req.params.id);
    if (!current) {
      throw new TaoriError({ code: 'not_found', message: `Research session ${req.params.id} not found` });
    }
    if (current.status === 'cancelled' || current.status === 'completed') {
      throw new TaoriError({
        code: 'validation_error',
        message: `Research session cannot start from status ${current.status}`,
      });
    }
    if (!current.plan && current.stage === 'scoping') {
      throw new TaoriError({
        code: 'validation_error',
        message: '请先补充研究范围，Taori 再为你生成计划。',
      });
    }
    // Use AI-generated plan if available, otherwise fall back to template
    const plan = current.plan ?? buildPlanFallback(current, current.constraints);
    repo.update(current.id, {
      plan,
      stage: 'planning',
      status: body.confirm ? 'running' : 'reviewing',
    });
    if (body.confirm) {
      repo.replaceTasks(current.id, buildResearchTasks({
        plan,
        title: current.title,
        objective: current.objective,
      }));
      repo.update(current.id, {
        draft_markdown: buildResearchDraftSkeleton(current, plan),
        started_at: current.started_at ?? Date.now(),
      });
      // Fire-and-forget kick the runner. If a loop is already alive it
      // becomes a no-op. Errors inside the loop are written back to
      // tasks/sessions, so we don't await here.
      if (runner) {
        void runner.start(current.id);
      }
    }
    const detail = repo.getDetail(current.id);
    if (!detail) {
      throw new TaoriError({ code: 'not_found', message: `Research session ${current.id} not found` });
    }
    return detail;
  });

  app.post<{ Params: { id: string } }>('/v1/research/sessions/:id/pause', async (req) => {
    const row = repo.update(req.params.id, { status: 'paused' });
    if (!row) {
      throw new TaoriError({ code: 'not_found', message: `Research session ${req.params.id} not found` });
    }
    return repo.getDetail(row.id);
  });

  app.post<{ Params: { id: string } }>('/v1/research/sessions/:id/resume', async (req) => {
    const current = repo.get(req.params.id);
    if (!current) {
      throw new TaoriError({ code: 'not_found', message: `Research session ${req.params.id} not found` });
    }
    if (current.status === 'cancelled' || current.status === 'completed') {
      throw new TaoriError({
        code: 'validation_error',
        message: `Research session cannot resume from status ${current.status}`,
      });
    }
    const detail = repo.getDetail(req.params.id);
    if (shouldRestartFailedSearchRun(detail)) {
      const plan = current.plan ?? buildResearchPlan({
        title: current.title,
        objective: current.objective,
        outputKind: current.output_kind,
        budgetMode: current.budget_mode,
        constraints: current.constraints,
      });
      repo.replaceTasks(req.params.id, buildResearchTasks({
        plan,
        title: current.title,
        objective: current.objective,
      }));
      repo.replaceSources(req.params.id, []);
      repo.replaceClaims(req.params.id, []);
      repo.update(req.params.id, {
        plan,
        stage: 'planning',
        draft_markdown: buildResearchDraftSkeleton(current, plan),
        final_markdown: null,
      });
    }
    repo.update(req.params.id, {
      status: 'running',
      started_at: current.started_at ?? Date.now(),
    });
    if (runner) {
      void runner.start(req.params.id);
    }
    return repo.getDetail(req.params.id);
  });

  app.post<{ Params: { id: string } }>('/v1/research/sessions/:id/cancel', async (req) => {
    const row = repo.update(req.params.id, {
      status: 'cancelled',
      completed_at: Date.now(),
    });
    if (!row) {
      throw new TaoriError({ code: 'not_found', message: `Research session ${req.params.id} not found` });
    }
    return repo.getDetail(row.id);
  });

  app.post<{ Params: { id: string } }>('/v1/research/sessions/:id/export', async (req, reply) => {
    const body = parseOrValidation(ResearchSessionExportRequestSchema.safeParse(req.body ?? {}));
    const exported = repo.exportSession(req.params.id, body);
    if (!exported) {
      throw new TaoriError({ code: 'not_found', message: `Research session ${req.params.id} not found` });
    }
    reply.header('Content-Type', 'application/json; charset=utf-8');
    return exported;
  });
}
