/**
 * GET /v1/costs/realtime — bottom status bar polling endpoint.
 * GET /v1/costs/summary  — per-model / per-feature aggregations (M1.3).
 *
 * Costs are written by the chat route on stream finalize (success or
 * failure); this route is read-only.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { BuildServerArgs } from '../server.js';
import { CostsRepo } from '../db/repos/index.js';

const RealtimeQuery = z.object({
  conversation_id: z.string().optional(),
});

const AvgOutputQuery = z.object({
  model_id: z.string().min(1),
});

const BreakdownQuery = z.object({
  scope: z.enum(['session', 'today', 'week', 'month']),
  conversation_id: z.string().optional(),
  group_by: z.enum(['model_feature', 'model', 'conversation', 'feature']).optional(),
});

const CallLogsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export function registerCostsRoute(app: FastifyInstance, deps: BuildServerArgs): void {
  const repo = new CostsRepo(deps.db);

  app.get('/v1/costs/realtime', async (req) => {
    const parsed = RealtimeQuery.safeParse(req.query);
    const convId = parsed.success ? parsed.data.conversation_id ?? null : null;
    const data = repo.realtime(convId);
    return {
      ok: true,
      data: { ...data, currency_display: 'USD' },
    };
  });

  app.get('/v1/costs/calls', async (req, reply) => {
    const parsed = CallLogsQuery.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { ok: false, error: parsed.error.errors[0]?.message ?? 'invalid query' };
    }
    return {
      ok: true,
      data: { rows: repo.callLogs(parsed.data.limit ?? 100) },
    };
  });

  // M1 §5.1: pre-send estimate uses rolling avg output_tokens per model.
  // Renderer combines this with a token estimate of the user input + history
  // and the model price snapshot to render "≈ $0.0023" (or a range when
  // sample_count < 5).
  app.get('/v1/costs/avg-output', async (req, reply) => {
    const parsed = AvgOutputQuery.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { ok: false, error: parsed.error.errors[0]?.message ?? 'invalid query' };
    }
    return { ok: true, data: repo.avgOutputTokens(parsed.data.model_id) };
  });

  // M2.2 session panel + D1 dashboard share this endpoint. The default
  // `group_by=model_feature` preserves the original M2 behavior so the
  // session-cost drawer stays backward-compatible; D1 opts into
  // `model|conversation|feature` plus `scope=week`.
  app.get('/v1/costs/breakdown', async (req, reply) => {
    const parsed = BreakdownQuery.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { ok: false, error: parsed.error.errors[0]?.message ?? 'invalid query' };
    }
    const { scope, conversation_id, group_by } = parsed.data;
    const normalizedGroupBy = group_by ?? 'model_feature';
    const rows =
      normalizedGroupBy === 'model_feature'
        ? repo.breakdown(scope, conversation_id ?? null)
        : repo.breakdownBy(scope, normalizedGroupBy, conversation_id ?? null);
    return { ok: true, data: { scope, group_by: normalizedGroupBy, rows } };
  });
}
