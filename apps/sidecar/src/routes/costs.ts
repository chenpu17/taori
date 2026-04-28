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
  scope: z.enum(['session', 'today', 'month']),
  conversation_id: z.string().optional(),
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

  // M2.2 §3.3: session-cost panel breakdown by (model, feature). Rendered
  // when the user clicks any segment of the bottom cost-bar (`今日 / 本月
  // / 本会话`). One query per scope; the renderer joins to active models
  // for display names — we return both the live model id and the
  // snapshot name so deleted-model rows keep their label.
  app.get('/v1/costs/breakdown', async (req, reply) => {
    const parsed = BreakdownQuery.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { ok: false, error: parsed.error.errors[0]?.message ?? 'invalid query' };
    }
    const { scope, conversation_id } = parsed.data;
    const rows = repo.breakdown(scope, conversation_id ?? null);
    return { ok: true, data: { scope, rows } };
  });
}
