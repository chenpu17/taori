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
import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import {
  ModelCreateSchema,
  ModelUpdateSchema,
  ModelCapabilitySchema,
  ModelReorderRequestSchema,
  TaoriError,
} from '@taori/shared';
import { ProvidersRepo, ModelsRepo } from '../db/repos/index.js';
import { classifyProviderError } from '../providers/registry.js';
import type { BuildServerArgs } from '../server.js';

const z_capability = z.object({ capability: ModelCapabilitySchema });

export function registerModelsRoute(
  app: FastifyInstance,
  deps: BuildServerArgs,
): void {
  const repo = new ModelsRepo(deps.db);
  const providersRepo = new ProvidersRepo(deps.db);

  app.get('/v1/models', async () => {
    return { models: repo.list() };
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
    try {
      const model = repo.create(parsed.data);
      // If is_default_for was set on creation, promote properly so any
      // pre-existing defaults get demoted in one transaction.
      if (parsed.data.is_default_for) {
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
      const updated = repo.setDefaultFor(req.params.id, body.data.capability);
      if (!updated) {
        throw new TaoriError({
          code: 'not_found',
          message: `Model ${req.params.id} not found`,
        });
      }
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
   * binary up/down + latency. Falls back to a synthetic OK when no API key is
   * configured (so the M0/dev path keeps working without a network round-trip).
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
      if (!provider || !provider.api_key_ref) {
        return {
          ok: true,
          latency_ms: 0,
          note: 'no_api_key_configured',
        };
      }
      const apiKey = await deps.keystore.read(provider.api_key_ref).catch(() => null);
      if (!apiKey) {
        return {
          ok: false,
          error: { classification: 'unknown', message: 'API key missing in keystore' },
        };
      }
      const started = Date.now();
      try {
        const sdk = createOpenAI({
          baseURL: provider.base_url.replace(/\/$/, ''),
          apiKey,
        });
        await generateText({
          model: sdk.chat(model.model_name),
          prompt: 'ping',
          maxTokens: 1,
          abortSignal: AbortSignal.timeout(8000),
        });
        return { ok: true, latency_ms: Date.now() - started };
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
