import type { FastifyInstance } from 'fastify';
import {
  ResearchSessionCreateSchema,
  ResearchSessionExportRequestSchema,
  ResearchSessionStartRequestSchema,
  TaoriError,
} from '@taori/shared';
import type { BuildServerArgs } from '../server.js';
import { ConversationsRepo, ResearchRepo } from '../db/repos/index.js';
import {
  buildResearchDraftSkeleton,
  buildResearchPlan,
  buildResearchTasks,
} from '../research/planner.js';
import type { ResearchRunner } from '../research/task-runner.js';

interface ResearchRouteDeps extends BuildServerArgs {
  researchRunner?: ResearchRunner;
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
    reply.code(201);
    return repo.create(body);
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
    const plan = buildResearchPlan({
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
      repo.replaceTasks(current.id, buildResearchTasks(plan));
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
