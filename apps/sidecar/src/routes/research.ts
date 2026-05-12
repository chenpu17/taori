import type { FastifyInstance } from 'fastify';
import {
  ResearchSessionCreateSchema,
  ResearchSessionExportRequestSchema,
  ResearchSessionStartRequestSchema,
  ResearchPlanReviseRequestSchema,
  TaoriError,
} from '@taori/shared';
import type { BuildServerArgs } from '../server.js';
import { ConversationsRepo, ModelsRepo, ProvidersRepo, ResearchRepo } from '../db/repos/index.js';
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

export function registerResearchRoute(app: FastifyInstance, deps: ResearchRouteDeps): void {
  const repo = new ResearchRepo(deps.db);
  const conversations = new ConversationsRepo(deps.db);
  const runner = deps.researchRunner;
  const plannerDeps = {
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
    // Create session with an immediate template plan so the UI can show the
    // confirm button right away. Async AI planning will update the plan if it
    // produces something better.
    const session = repo.create(body);
    const templatePlan = buildResearchPlan({
      title: session.title,
      objective: session.objective,
      outputKind: session.output_kind,
      budgetMode: session.budget_mode,
      constraints: session.constraints,
    });
    repo.update(session.id, { plan: templatePlan, stage: 'planning' });
    // Kick off async AI planning — fire-and-forget; overwrites plan when done
    setImmediate(() => {
      void generateAIPlan(session, plannerDeps).then((plan) => {
        if (plan) {
          repo.update(session.id, { plan });
        }
      }).catch((err: unknown) => {
        app.log.error({ err }, 'Background AI planning failed');
      });
    });
    const withPlan = repo.getDetail(session.id)?.session ?? session;
    reply.code(201);
    return withPlan;
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

    // Attempt AI revision
    const result = await revisePlan(current, body.feedback, plannerDeps);

    if (result) {
      const assistantMessage = { role: 'assistant' as const, content: result.assistantMessage, ts: Date.now() };
      repo.update(current.id, {
        plan: result.plan,
        plan_messages: [...existingMessages, userMessage, assistantMessage],
      });
    } else {
      // No AI available — just record the user message and keep existing plan
      repo.update(current.id, {
        plan_messages: [...existingMessages, userMessage],
      });
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
    // Use AI-generated plan if available, otherwise fall back to template
    const plan = current.plan ?? buildResearchPlan({
      title: current.title,
      objective: current.objective,
      outputKind: current.output_kind,
      budgetMode: current.budget_mode,
      constraints: current.constraints,
    });
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
