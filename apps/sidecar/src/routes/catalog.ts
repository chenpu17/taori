/**
 * /v1/catalog — pricing & capability catalog sync.
 *
 *   POST /v1/catalog/sync           → trigger sync, returns CatalogSyncResponse
 *   POST /v1/catalog/sync/:provider → sync a single provider
 *
 * Used by Model Center "Sync prices" button and by the periodic background
 * task. Idempotent: repeated calls only touch `price_synced_at` if nothing
 * material changed.
 */

import type { FastifyInstance } from 'fastify';
import { CatalogSyncRequestSchema, TaoriError } from '@taori/shared';
import { ModelsRepo, ProvidersRepo } from '../db/repos/index.js';
import { syncCatalog } from '../catalog/index.js';
import type { KeyStore } from '../keystore.js';
import type { BuildServerArgs } from '../server.js';

export interface CatalogRouteDeps extends BuildServerArgs {
  keystore: KeyStore;
}

export function registerCatalogRoute(
  app: FastifyInstance,
  deps: CatalogRouteDeps,
): void {
  const providers = new ProvidersRepo(deps.db);
  const models = new ModelsRepo(deps.db);

  app.post('/v1/catalog/sync', async (req) => {
    const parsed = CatalogSyncRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new TaoriError({
        code: 'validation_error',
        message: parsed.error.errors.map((e) => e.message).join('; '),
      });
    }
    const result = await syncCatalog(
      {
        providers,
        models,
        keystore: deps.keystore,
        log: app.log,
      },
      parsed.data.provider_id,
    );
    return result;
  });
}
