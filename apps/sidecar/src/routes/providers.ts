/**
 * /v1/providers — provider CRUD + credential probe.
 *
 * Endpoints:
 *   GET    /v1/providers                  → Provider[]
 *   POST   /v1/providers                  → Provider (api_key persisted in keystore)
 *   PATCH  /v1/providers/:id              → Provider
 *   DELETE /v1/providers/:id              → 204
 *   POST   /v1/providers/test             → ProviderTestResponse (no DB write)
 *   GET    /v1/providers/:id/discover     → ModelDiscoveryResponse
 *
 * Security: every endpoint already gated by the bearer hook in server.ts.
 * API keys never traverse outbound responses — they are written to the
 * KeyStore and only `api_key_ref` is exposed to the Renderer.
 */

import type { FastifyInstance } from 'fastify';
import {
  ProviderCreateSchema,
  ProviderUpdateSchema,
  ProviderTestRequestSchema,
  TaoriError,
  type ProviderTestResponse,
  type ModelDiscoveryResponse,
} from '@taori/shared';
import { ProvidersRepo } from '../db/repos/index.js';
import {
  testProvider,
  listProviderModels,
  pickRecommendations,
} from '../providers/registry.js';
import type { KeyStore } from '../keystore.js';
import type { BuildServerArgs } from '../server.js';

export interface ProvidersRouteDeps extends BuildServerArgs {
  keystore: KeyStore;
}

export function registerProvidersRoute(
  app: FastifyInstance,
  deps: ProvidersRouteDeps,
): void {
  const repo = new ProvidersRepo(deps.db);

  app.get('/v1/providers', async () => {
    return { providers: repo.list() };
  });

  /**
   * GET /v1/providers/key-status
   * Returns whether the keystore currently holds a key for each provider.
   * Used by Model Center to show a ⚠️ badge when keys need re-entry (e.g.
   * after a dev sidecar restart with MemoryStore).
   */
  app.get('/v1/providers/key-status', async (): Promise<{
    statuses: { provider_id: string; key_available: boolean }[];
  }> => {
    const all = repo.list();
    const statuses = await Promise.all(
      all.map(async (p) => {
        if (!p.api_key_ref) return { provider_id: p.id, key_available: false };
        try {
          const k = await deps.keystore.read(p.api_key_ref);
          return { provider_id: p.id, key_available: k !== null };
        } catch {
          return { provider_id: p.id, key_available: false };
        }
      }),
    );
    return { statuses };
  });

  app.post('/v1/providers/test', async (req): Promise<ProviderTestResponse> => {
    const parsed = ProviderTestRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new TaoriError({
        code: 'validation_error',
        message: parsed.error.errors.map((e) => e.message).join('; '),
      });
    }
    const result = await testProvider(parsed.data);
    if (result.ok) {
      return { ok: true, sample_count: result.sample_count };
    }
    return {
      ok: false,
      error: {
        classification: result.classification ?? 'unknown',
        message: result.message ?? 'Unknown error',
      },
    };
  });

  app.post('/v1/providers', async (req, reply) => {
    const parsed = ProviderCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new TaoriError({
        code: 'validation_error',
        message: parsed.error.errors.map((e) => e.message).join('; '),
      });
    }
    const created = repo.create(parsed.data);
    if (parsed.data.api_key && created.api_key_ref) {
      try {
        await deps.keystore.write(created.api_key_ref, parsed.data.api_key);
      } catch (e) {
        // Roll back the DB row so we don't have a dangling provider with no key.
        repo.delete(created.id);
        throw new TaoriError({
          code: 'keychain_error',
          message: `Failed to persist API key: ${e instanceof Error ? e.message : 'unknown'}`,
        });
      }
    }
    reply.code(201);
    return created;
  });

  app.patch<{ Params: { id: string } }>(
    '/v1/providers/:id',
    async (req) => {
      const parsed = ProviderUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new TaoriError({
          code: 'validation_error',
          message: parsed.error.errors.map((e) => e.message).join('; '),
        });
      }
      const result = repo.update(req.params.id, parsed.data);
      if (!result) {
        throw new TaoriError({
          code: 'not_found',
          message: `Provider ${req.params.id} not found`,
        });
      }
      if (parsed.data.api_key && result.provider.api_key_ref) {
        try {
          await deps.keystore.write(result.provider.api_key_ref, parsed.data.api_key);
        } catch (e) {
          throw new TaoriError({
            code: 'keychain_error',
            message: `Failed to persist API key: ${e instanceof Error ? e.message : 'unknown'}`,
          });
        }
      }
      return result.provider;
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/v1/providers/:id',
    async (req, reply) => {
      const existing = repo.get(req.params.id);
      if (!existing) {
        throw new TaoriError({
          code: 'not_found',
          message: `Provider ${req.params.id} not found`,
        });
      }
      if (existing.api_key_ref) {
        // Best-effort: ignore Keychain errors (e.g., already deleted)
        try {
          await deps.keystore.delete(existing.api_key_ref);
        } catch (e) {
          req.log.warn({ err: e }, 'provider.delete.keystore_fail');
        }
      }
      repo.delete(req.params.id);
      reply.code(204).send();
    },
  );

  /**
   * DELETE /v1/providers/:id/key
   * Revoke the API key from the keystore without deleting the provider row.
   * After this call, `key_available` for this provider becomes false, and
   * the sidecar will emit `key_missing` errors on chat requests.
   *
   * Useful for: security wipe, testing the key-missing UX flow, and forcing
   * the user to re-enter their key.
   */
  app.delete<{ Params: { id: string } }>(
    '/v1/providers/:id/key',
    async (req, reply) => {
      const existing = repo.get(req.params.id);
      if (!existing) {
        throw new TaoriError({
          code: 'not_found',
          message: `Provider ${req.params.id} not found`,
        });
      }
      if (existing.api_key_ref) {
        try {
          await deps.keystore.delete(existing.api_key_ref);
        } catch {
          // Already absent — treat as success
        }
      }
      reply.code(204).send();
    },
  );

  app.get<{ Params: { id: string } }>(
    '/v1/providers/:id/discover',
    async (req): Promise<ModelDiscoveryResponse> => {
      const provider = repo.get(req.params.id);
      if (!provider) {
        throw new TaoriError({
          code: 'not_found',
          message: `Provider ${req.params.id} not found`,
        });
      }
      if (!provider.api_key_ref) {
        throw new TaoriError({
          code: 'validation_error',
          message: 'Provider has no API key configured',
        });
      }
      const apiKey = await deps.keystore.read(provider.api_key_ref);
      if (!apiKey) {
        throw new TaoriError({
          code: 'keychain_error',
          message: 'API key not found in keystore — re-enter via PATCH /providers/:id',
        });
      }
      try {
        const models = await listProviderModels({
          type: provider.type,
          base_url: provider.base_url,
          api_key: apiKey,
        });
        return {
          provider_id: provider.id,
          models,
          recommended: pickRecommendations(models),
        };
      } catch (e) {
        throw new TaoriError({
          code: 'provider_error',
          message: e instanceof Error ? e.message : 'Discovery failed',
          can_retry: true,
        });
      }
    },
  );
}
