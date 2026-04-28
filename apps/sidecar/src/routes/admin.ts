/**
 * Admin / danger-zone routes (M1 §6.2).
 *
 * `POST /v1/admin/clear-all-data` wipes every user-owned row from SQLite
 * (conversations → messages cascade; cost_records; models; providers) and
 * removes the matching Keychain entries for any provider.api_key_ref values
 * we observed before deletion. We treat keystore failures as non-fatal so a
 * partially-broken keystore can't trap a user inside an unwipeable app.
 *
 * The renderer is expected to require an explicit, two-step confirm before
 * calling this endpoint — there is no undo.
 */

import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import type { BuildServerArgs } from '../server.js';
import {
  providers,
  models,
  conversations,
  messages,
  cost_records,
} from '../db/schema.js';

export function registerAdminRoute(app: FastifyInstance, deps: BuildServerArgs): void {
  app.post('/v1/admin/clear-all-data', async () => {
    // Collect api_key_refs first so we can clean Keychain after the SQLite
    // truncation succeeds. (If the SQLite step fails, we don't want to have
    // already nuked the secrets.)
    const refs = deps.db
      .select({ ref: providers.api_key_ref })
      .from(providers)
      .all()
      .map((r) => r.ref)
      .filter((r): r is string => !!r);

    // Order matters: child rows first to avoid FK violations even with
    // ON DELETE CASCADE not declared on every relationship.
    deps.db.delete(cost_records).where(sql`1=1`).run();
    deps.db.delete(messages).where(sql`1=1`).run();
    deps.db.delete(conversations).where(sql`1=1`).run();
    deps.db.delete(models).where(sql`1=1`).run();
    deps.db.delete(providers).where(sql`1=1`).run();

    // Best-effort keystore cleanup. Failures are reported but do not throw.
    const keystoreFailures: string[] = [];
    for (const ref of refs) {
      try {
        await deps.keystore.delete(ref);
      } catch (e) {
        keystoreFailures.push(
          `${ref}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    return {
      ok: true,
      data: {
        sqlite_cleared: true,
        keystore_entries_removed: refs.length - keystoreFailures.length,
        keystore_failures: keystoreFailures,
      },
    };
  });
}
