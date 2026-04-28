/**
 * /v1/roundtable — M3.A roundtable orchestration.
 *
 * M3.A.1 (this file currently): POST + GET only.
 *   POST /v1/roundtable                       → create + run analyzer + persist
 *   GET  /v1/roundtable/:id                   → full state + messages
 *
 * M3.A.2 will add:
 *   POST /v1/roundtable/:id/round/:round/start
 *   POST /v1/roundtable/:id/summarize
 *   PUT  /v1/roundtable/:id/round/:round/participant/:index/retry
 *   GET  /v1/roundtable/:id/export
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  TaoriError,
  CreateRoundtableRequestSchema,
  type AnalyzerOutput,
} from '@taori/shared';
import {
  ConversationsRepo,
  CostsRepo,
  MemoriesRepo,
  ModelsRepo,
  ProvidersRepo,
  RoundtableMessagesRepo,
  RoundtablesRepo,
} from '../db/repos/index.js';
import type { BuildServerArgs } from '../server.js';
import {
  pickAnalyzerModel,
  pickFallbackParticipantModels,
} from '../roundtable/model-pick.js';
import { runAnalyzer, buildFallbackOutput } from '../roundtable/analyzer.js';
import { estimateRoundtableCostRange } from '../roundtable/cost-estimate.js';

export function registerRoundtableRoute(
  app: FastifyInstance,
  deps: BuildServerArgs,
): void {
  const convRepo = new ConversationsRepo(deps.db);
  const modelsRepo = new ModelsRepo(deps.db);
  const providersRepo = new ProvidersRepo(deps.db);
  const memoriesRepo = new MemoriesRepo(deps.db);
  const costsRepo = new CostsRepo(deps.db);
  const rtRepo = new RoundtablesRepo(deps.db);
  const rtMsgRepo = new RoundtableMessagesRepo(deps.db);

  app.post('/v1/roundtable', async (req, reply) => {
    const parsed = CreateRoundtableRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new TaoriError({
        code: 'validation_error',
        message: parsed.error.issues
          .map((i) => `${i.path.join('.')}:${i.message}`)
          .join('; '),
      });
    }
    const body = parsed.data;
    const conv = convRepo.ensure(body.conversation_id);
    const requestedMode = body.mode ?? 'auto';

    const allEnabledChat = modelsRepo
      .list()
      .filter(
        (m) =>
          m.enabled &&
          !m.demoted &&
          m.provider_id &&
          m.capability === 'chat' &&
          (!m.disabled_until || m.disabled_until < Date.now()),
      );
    if (allEnabledChat.length === 0) {
      throw new TaoriError({
        code: 'conflict',
        message: 'no_available_chat_models',
        details: { hint: '请先在设置中启用至少一个 chat 模型' },
      });
    }

    const candidateModels = allEnabledChat.map((m) => ({
      id: m.id,
      display_name: m.display_name,
      model_name: m.model_name,
    }));
    const analyzerModel = pickAnalyzerModel(modelsRepo, memoriesRepo);
    const analyzerProvider = analyzerModel?.provider_id
      ? providersRepo.get(analyzerModel.provider_id)
      : null;

    // Pre-allocate the roundtable id so the analyzer cost_record can FK to it.
    // We insert the actual roundtable row only after analyzer settles so the
    // initial status reflects reality (ready / failed).
    const pendingId = `rt_${Math.random().toString(36).slice(2, 14)}`;

    let analyzerOutput: AnalyzerOutput | null = null;
    let analyzerFailed = false;

    if (analyzerModel && analyzerProvider) {
      const analyzerResult = await runAnalyzer(
        { keystore: deps.keystore, log: req.log },
        {
          topic: body.topic,
          requestedMode,
          candidateModels,
          analyzerModel,
          analyzerProvider,
        },
        pendingId,
        conv.id,
      );
      if (analyzerResult.costInsert) {
        costsRepo.insert(analyzerResult.costInsert);
      }
      if (analyzerResult.ok) {
        analyzerOutput = analyzerResult.output;
      } else {
        analyzerFailed = true;
        req.log.warn(
          { reason: analyzerResult.reason, message: analyzerResult.message },
          'roundtable.analyzer.failed',
        );
      }
    } else {
      analyzerFailed = true;
      req.log.info(
        'roundtable.analyzer.skipped — no analyzer model / provider key',
      );
    }

    if (!analyzerOutput) {
      const fallbackModels = pickFallbackParticipantModels(modelsRepo, 3);
      analyzerOutput = buildFallbackOutput({
        participantModels: fallbackModels,
        summarizerModelId: fallbackModels[0]!.id,
        requestedMode,
      });
    }

    const participantModels = analyzerOutput.participants
      .map((p) => modelsRepo.get(p.model_id))
      .filter((m): m is NonNullable<typeof m> => m !== null);
    const summarizerModel = modelsRepo.get(analyzerOutput.summarizer_model_id);
    if (!summarizerModel) {
      throw new TaoriError({
        code: 'internal',
        message: 'summarizer model resolved to null after analyzer',
      });
    }

    const estimate = estimateRoundtableCostRange({
      mode: analyzerOutput.suggested_mode,
      analyzerModel,
      participantModels,
      summarizerModel,
      topicLength: body.topic.length,
    });

    const inserted = rtRepo.insert({
      id: pendingId,
      conversation_id: conv.id,
      topic: body.topic,
      mode: analyzerOutput.suggested_mode,
      participants: analyzerOutput.participants,
      summarizer_model_id: analyzerOutput.summarizer_model_id,
      analyzer_fallback: analyzerFailed,
      status: 'ready',
      current_round: 0,
      estimated_cost_usd_low: estimate.low,
      estimated_cost_usd_high: estimate.high,
    });

    return reply.code(201).send({
      id: inserted.id,
      conversation_id: inserted.conversation_id,
      topic: inserted.topic,
      mode: inserted.mode,
      participants: inserted.participants,
      summarizer_model_id: inserted.summarizer_model_id,
      analyzer_fallback: inserted.analyzer_fallback,
      status: inserted.status,
      current_round: inserted.current_round,
      estimated_cost_usd_low: inserted.estimated_cost_usd_low,
      estimated_cost_usd_high: inserted.estimated_cost_usd_high,
      created_at: inserted.created_at,
    });
  });

  app.get<{ Params: { id: string } }>('/v1/roundtable/:id', async (req) => {
    const rt = rtRepo.get(req.params.id);
    if (!rt) {
      throw new TaoriError({
        code: 'not_found',
        message: `Roundtable ${req.params.id} not found`,
      });
    }
    const messages = rtMsgRepo.listByRoundtable(rt.id);
    return { roundtable: rt, messages };
  });

  // M3.A.1 placeholder so future pieces have a stable shape — quiet TS unused-var.
  void z;
}
