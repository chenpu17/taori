/**
 * /v1/models — model CRUD.
 *
 * Endpoints:
 *   GET    /v1/models                  → Model[]
 *   POST   /v1/models                  → Model
 *   PATCH  /v1/models/:id              → Model
 *   DELETE /v1/models/:id              → 204
 *   POST   /v1/models/:id/default      → Model    (promote to default for capability)
 *
 * The "default" endpoint is split out so the Renderer can flip the chat /
 * vision default without having to know the implementation detail
 * (transactional clear-then-set in repos.setDefaultFor).
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { generateText, tool } from 'ai';
import {
  ModelCreateSchema,
  ModelUpdateSchema,
  ModelCapabilitySchema,
  ModelReorderRequestSchema,
  ModelRecommendationRequestSchema,
  TaoriError,
  type Model,
  type ModelHealthRow,
  type ModelRecommendation,
  type ModelRecommendationTask,
} from '@taori/shared';
import {
  classifyProviderError,
  isToolPayloadUnsupportedError,
} from '../providers/registry.js';
import type { BuildServerArgs } from '../server.js';
import { createChatModel } from '../providers/chat-model.js';

const z_capability = z.object({ capability: ModelCapabilitySchema });

function primaryModelPrice(model: Pick<Model, 'price_input_per_1m' | 'price_output_per_1m' | 'price_per_call' | 'price_per_image' | 'price_per_video_second'>): number | null {
  const values = [
    model.price_input_per_1m,
    model.price_output_per_1m,
    model.price_per_call,
    model.price_per_image,
    model.price_per_video_second,
  ].filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return values.length > 0 ? Math.min(...values) : null;
}

function canServeCapability(model: Model, capability: Model['capability']): boolean {
  if (capability === 'chat') return model.capability === 'chat' || model.capability === 'multimodal';
  return model.capability === capability;
}

function zeroHealth(modelId: string): ModelHealthRow {
  return {
    model_id: modelId,
    calls_24h: 0,
    failures_24h: 0,
    avg_first_token_ms: null,
    avg_duration_ms: null,
    last_failure_at: null,
    last_failure_classification: null,
    failure_distribution_24h: [],
    failure_trend_24h: [],
  };
}

function scoreModelRecommendation(args: {
  model: Model;
  health: ModelHealthRow;
  task: ModelRecommendationTask;
  minPrice: number | null;
  maxPrice: number | null;
  currentModelId?: string;
}): ModelRecommendation {
  const { model, health, task, minPrice, maxPrice, currentModelId } = args;
  let score = 45;
  const reasons: string[] = [];
  const tradeoffs: string[] = [];

  const price = primaryModelPrice(model);
  if (price == null || minPrice == null || maxPrice == null || maxPrice === minPrice) {
    score += 6;
    tradeoffs.push(price == null ? '价格未知，成本预测可信度较低' : '候选模型价格接近');
  } else {
    const cheapness = 1 - (price - minPrice) / (maxPrice - minPrice);
    const priceWeight = task === 'cheap' ? 28 : task === 'fast' ? 12 : 18;
    score += cheapness * priceWeight;
    if (cheapness >= 0.75) reasons.push('价格处于候选模型低位');
    if (cheapness <= 0.25) tradeoffs.push('价格高于多数候选模型');
  }

  if (health.calls_24h > 0) {
    const failureRate = health.failures_24h / health.calls_24h;
    const reliabilityWeight = failureRate === 0 ? 22 : Math.max(0, 22 * (1 - failureRate));
    score += reliabilityWeight;
    if (failureRate === 0) reasons.push('最近 24 小时调用无失败');
    else if (failureRate >= 0.5) tradeoffs.push(`最近失败率较高（${Math.round(failureRate * 100)}%）`);
  } else {
    score += 10;
    tradeoffs.push('最近 24 小时缺少调用样本');
  }

  if (health.avg_first_token_ms != null) {
    if (health.avg_first_token_ms <= 2_000) {
      score += task === 'fast' ? 24 : 14;
      reasons.push('首 token 延迟较低');
    } else if (health.avg_first_token_ms <= 6_000) {
      score += task === 'fast' ? 10 : 8;
    } else {
      tradeoffs.push('历史首 token 偏慢');
    }
  } else if (task === 'fast') {
    tradeoffs.push('缺少首 token 历史数据');
  }

  if (task === 'coding') {
    if (model.supports_tools) {
      score += 10;
      reasons.push('支持工具调用，适合代码/检索型任务');
    }
    if (model.supports_json) score += 5;
    if ((model.context_length ?? 0) >= 64_000) score += 8;
  }
  if (task === 'long_context') {
    const ctx = model.context_length ?? 0;
    score += Math.min(24, ctx / 8_000);
    if (ctx >= 64_000) reasons.push('上下文窗口较大');
    else tradeoffs.push('上下文窗口不算大');
  }
  if (task === 'vision') {
    if (model.supports_vision || model.capability === 'multimodal') {
      score += 24;
      reasons.push('支持视觉输入');
    } else {
      score -= 30;
      tradeoffs.push('不支持视觉输入');
    }
  }
  if (currentModelId && model.id === currentModelId) {
    score += 3;
    reasons.push('当前已选模型，切换成本最低');
  }
  if (model.demoted || (model.disabled_until != null && model.disabled_until > Date.now())) {
    score -= 40;
    tradeoffs.push('模型处于自动降级/冷却状态');
  }
  if (reasons.length === 0) reasons.push('综合价格、能力与近期健康度较均衡');
  const confidence = health.calls_24h >= 5 ? 'high' : health.calls_24h >= 1 ? 'medium' : 'low';
  return {
    model_id: model.id,
    score: Math.round(Math.max(0, Math.min(100, score))),
    confidence,
    reasons,
    tradeoffs,
    health,
  };
}

export function registerModelsRoute(
  app: FastifyInstance,
  deps: BuildServerArgs,
): void {
  const { repos } = deps;
  const repo = repos.models;
  const providersRepo = repos.providers;
  const costsRepo = repos.costs;
  const memoriesRepo = repos.memories;

  app.get('/v1/models', async () => {
    return { models: repo.list() };
  });

  app.get('/v1/models/health', async () => {
    const health = costsRepo.modelHealth24h();
    const rows = repo.list().map((model) => {
      const row = health.get(model.id);
      return (
        row ?? {
          model_id: model.id,
          calls_24h: 0,
          failures_24h: 0,
          avg_first_token_ms: null,
          avg_duration_ms: null,
          last_failure_at: null,
          last_failure_classification: null,
          failure_distribution_24h: [],
          failure_trend_24h: [],
        }
      );
    });
    return { rows };
  });

  app.post('/v1/models/recommendations', async (req) => {
    const parsed = ModelRecommendationRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new TaoriError({
        code: 'validation_error',
        message: parsed.error.errors.map((e) => e.message).join('; '),
      });
    }
    const body = parsed.data;
    const now = Date.now();
    const health = costsRepo.modelHealth24h();
    const candidates = repo.list().filter((model) => {
      if (!model.enabled) return false;
      if (!model.provider_id) return false;
      if (!canServeCapability(model, body.capability)) return false;
      if (body.require_tools && !model.supports_tools) return false;
      if ((body.require_vision || body.task === 'vision') && !(model.supports_vision || model.capability === 'multimodal')) return false;
      if (model.disabled_until != null && model.disabled_until > now) return false;
      return true;
    });
    const prices = candidates
      .map(primaryModelPrice)
      .filter((value): value is number => value != null && Number.isFinite(value));
    const minPrice = prices.length > 0 ? Math.min(...prices) : null;
    const maxPrice = prices.length > 0 ? Math.max(...prices) : null;
    const recommendations = candidates
      .map((model) => scoreModelRecommendation({
        model,
        health: health.get(model.id) ?? zeroHealth(model.id),
        task: body.task,
        minPrice,
        maxPrice,
        currentModelId: body.current_model_id,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, body.limit);
    return {
      task: body.task,
      recommended_model_id: recommendations[0]?.model_id ?? null,
      recommendations,
    };
  });

  app.post('/v1/models', async (req, reply) => {
    const parsed = ModelCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new TaoriError({
        code: 'validation_error',
        message: parsed.error.errors.map((e) => e.message).join('; '),
      });
    }
    if (!providersRepo.get(parsed.data.provider_id)) {
      throw new TaoriError({
        code: 'validation_error',
        message: `Provider ${parsed.data.provider_id} not found`,
      });
    }
    if (parsed.data.enabled === false && parsed.data.is_default_for) {
      throw new TaoriError({
        code: 'validation_error',
        message: 'Disabled models cannot be set as default',
      });
    }
    try {
      const model = repo.create(parsed.data);
      // If is_default_for was set on creation, promote properly so any
      // pre-existing defaults get demoted in one transaction.
      if (parsed.data.is_default_for && model.enabled) {
        repo.setDefaultFor(model.id, parsed.data.is_default_for);
      }
      reply.code(201);
      return repo.get(model.id);
    } catch (e) {
      // SQLITE_CONSTRAINT_UNIQUE → "models_provider_model_uniq"
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('UNIQUE') || msg.includes('constraint')) {
        throw new TaoriError({
          code: 'conflict',
          message: 'A model with this name already exists for this provider',
        });
      }
      throw e;
    }
  });

  app.patch<{ Params: { id: string } }>(
    '/v1/models/:id',
    async (req) => {
      const parsed = ModelUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new TaoriError({
          code: 'validation_error',
          message: parsed.error.errors.map((e) => e.message).join('; '),
        });
      }
      const updated = repo.update(req.params.id, parsed.data);
      if (!updated) {
        throw new TaoriError({
          code: 'not_found',
          message: `Model ${req.params.id} not found`,
        });
      }
      if (parsed.data.is_default_for !== undefined && parsed.data.is_default_for !== null) {
        if (!updated.enabled) {
          throw new TaoriError({
            code: 'validation_error',
            message: 'Disabled models cannot be set as default',
          });
        }
        return repo.setDefaultFor(updated.id, parsed.data.is_default_for);
      }
      return updated;
    },
  );

  app.post<{ Params: { id: string } }>(
    '/v1/models/:id/default',
    async (req) => {
      const body = z_capability.safeParse(req.body);
      if (!body.success) {
        throw new TaoriError({
          code: 'validation_error',
          message: 'Body must be { capability: ... }',
        });
      }
      const model = repo.get(req.params.id);
      if (!model) {
        throw new TaoriError({
          code: 'not_found',
          message: `Model ${req.params.id} not found`,
        });
      }
      if (!model.enabled) {
        throw new TaoriError({
          code: 'validation_error',
          message: 'Disabled models cannot be set as default',
        });
      }
      const updated = repo.setDefaultFor(model.id, body.data.capability);
      return updated;
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/v1/models/:id',
    async (req, reply) => {
      const ok = repo.delete(req.params.id);
      if (!ok) {
        throw new TaoriError({
          code: 'not_found',
          message: `Model ${req.params.id} not found`,
        });
      }
      reply.code(204).send();
    },
  );

  /**
   * POST /v1/models/reorder — MC-3 备援顺序. Body: { capability, ordered_ids }.
   * The new fallback_order is set to the array index. The route is atomic
   * (transactional) and requires the FULL set of model ids for the capability:
   * partial sets would leave gaps / duplicate fallback_order values which
   * break `nextFallback()` ordering.
   *
   * Errors:
   *   - 400 validation_error: schema fail / duplicates / wrong capability /
   *     set_mismatch (ids submitted ≠ models in this capability)
   *   - 404 not_found: at least one id does not exist
   */
  app.post('/v1/models/reorder', async (req) => {
    const parsed = ModelReorderRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new TaoriError({
        code: 'validation_error',
        message: parsed.error.errors.map((e) => e.message).join('; '),
      });
    }
    try {
      const ordered = repo.reorder(parsed.data.capability, parsed.data.ordered_ids);
      return { capability: parsed.data.capability, models: ordered };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === 'not_found') {
        throw new TaoriError({
          code: 'not_found',
          message: 'one or more model ids not found',
        });
      }
      if (msg === 'capability_mismatch') {
        throw new TaoriError({
          code: 'validation_error',
          message: 'all ids must belong to the given capability',
        });
      }
      if (msg === 'duplicate_ids') {
        throw new TaoriError({
          code: 'validation_error',
          message: 'ordered_ids contains duplicates',
        });
      }
      if (msg === 'set_mismatch') {
        throw new TaoriError({
          code: 'validation_error',
          message: 'ordered_ids must include every model in this capability',
        });
      }
      throw e;
    }
  });

  /**
   * POST /v1/models/:id/test — MC-4 availability probe.
   *
   * Sends a 1-token "ping" through the configured provider so we can report a
   * binary up/down + latency. Missing credentials are reported as a failed
   * probe so Model Center does not mark an unusable model as healthy.
   */
  app.post<{ Params: { id: string } }>(
    '/v1/models/:id/test',
    async (req) => {
      const model = repo.get(req.params.id);
      if (!model) {
        throw new TaoriError({
          code: 'not_found',
          message: `Model ${req.params.id} not found`,
        });
      }
      const provider = model.provider_id ? providersRepo.get(model.provider_id) : null;
      if (!provider || (!provider.api_key_ref && provider.type !== 'ollama')) {
        return {
          ok: false,
          latency_ms: 0,
          note: 'no_api_key_configured',
          error: { classification: 'key_missing', message: 'API key is not configured' },
        };
      }
      const apiKey = provider.type === 'ollama'
        ? 'ollama-local'
        : await deps.keystore.read(provider.api_key_ref as string).catch(() => null);
      if (!apiKey) {
        return {
          ok: false,
          error: { classification: 'unknown', message: 'API key missing in keystore' },
        };
      }
      const started = Date.now();
      try {
        const { model: chatModel } = createChatModel({
          provider,
          model,
          apiKey,
          memoriesRepo,
        });
        await generateText({
          model: chatModel,
          prompt: 'ping',
          maxTokens: 1,
          abortSignal: AbortSignal.timeout(8000),
        });
        let toolsProbe: {
          supported: boolean | null;
          updated: boolean;
          classification?: string;
          message?: string;
        } | null = null;
        if (model.capability === 'chat' || model.capability === 'multimodal') {
          try {
            await generateText({
              model: chatModel,
              prompt: 'Reply exactly: ok. Do not call any tools.',
              maxTokens: 3,
              abortSignal: AbortSignal.timeout(8000),
              tools: {
                taori_probe: tool({
                  description:
                    'No-op capability probe. The model should not call this tool.',
                  parameters: z.object({}),
                  execute: async () => ({ ok: true }),
                }),
              },
            });
            const updated = model.supports_tools !== true;
            if (updated) repo.update(model.id, { supports_tools: true });
            toolsProbe = { supported: true, updated };
          } catch (probeErr) {
            const probeStatus = (probeErr as { statusCode?: number; status?: number })?.statusCode
              ?? (probeErr as { status?: number })?.status;
            const cls = classifyProviderError({ status: probeStatus, err: probeErr });
            const unsupported = isToolPayloadUnsupportedError(probeErr);
            if (unsupported && model.supports_tools !== false) {
              repo.update(model.id, { supports_tools: false });
            }
            toolsProbe = {
              supported: unsupported ? false : null,
              updated: unsupported && model.supports_tools !== false,
              classification: cls.classification,
              message: cls.message,
            };
          }
        }
        return {
          ok: true,
          latency_ms: Date.now() - started,
          ...(toolsProbe ? { tools_probe: toolsProbe } : {}),
        };
      } catch (e) {
        const status = (e as { statusCode?: number; status?: number })?.statusCode
          ?? (e as { status?: number })?.status;
        const cls = classifyProviderError({ status, err: e });
        return {
          ok: false,
          latency_ms: Date.now() - started,
          error: { classification: cls.classification, message: cls.message },
        };
      }
    },
  );
}
