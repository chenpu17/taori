/**
 * /v1/memories — three-tier scoped key/value store for renderer-driven
 * preferences and lightweight session state (M2 §1.4 + §3.x).
 *
 * Scopes:
 *  - global   → no scope_id (per-installation default)
 *  - session  → scope_id = conversation_id (overrides global for that conv)
 *  - message  → scope_id = message_id (rare; not used by M2.1)
 *
 * Effective resolution order: message > session > global.
 *
 * The `value` field is opaque text — callers stringify JSON themselves.
 * We keep it that way to avoid double-encoding for plain string flags.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { BuildServerArgs } from '../server.js';
import { LocalKvMemoryProvider } from '../memory/provider.js';

const SCOPES = ['global', 'session', 'user'] as const;

const GetQuery = z.object({
  scope: z.enum(SCOPES),
  scope_id: z.string().optional(),
  key: z.string().min(1).max(128),
});

const PutBody = z.object({
  scope: z.enum(SCOPES),
  scope_id: z.string().optional().nullable(),
  key: z.string().min(1).max(128),
  value: z.string().max(64 * 1024),
});

const DelQuery = z.object({
  scope: z.enum(SCOPES),
  scope_id: z.string().optional(),
  key: z.string().min(1).max(128),
});

const EffectiveQuery = z.object({
  conversation_id: z.string().optional(),
  key: z.string().min(1).max(128),
});

const StructuredListQuery = z.object({
  include_disabled: z.coerce.boolean().optional(),
  include_deleted: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const StructuredPatchBody = z.object({
  enabled: z.boolean(),
});

export function registerMemoriesRoute(app: FastifyInstance, deps: BuildServerArgs): void {
  const provider = deps.memoryProvider ?? new LocalKvMemoryProvider(deps.repos.memories);
  const structuredRepo = deps.repos.structuredMemories;

  app.get('/v1/memories', async (req, reply) => {
    const parsed = GetQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: { code: 'invalid_query' } });
    }
    const { scope, scope_id, key } = parsed.data;
    if (scope !== 'global' && !scope_id) {
      return reply.code(400).send({ ok: false, error: { code: 'scope_id_required' } });
    }
    const value = await provider.get({
      scope,
      scopeId: scope === 'global' ? null : scope_id ?? null,
      key,
    });
    return { ok: true, data: { scope, scope_id: scope_id ?? null, key, value } };
  });

  app.get('/v1/memories/effective', async (req, reply) => {
    const parsed = EffectiveQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: { code: 'invalid_query' } });
    }
    const { conversation_id, key } = parsed.data;
    const value = await provider.getEffective(conversation_id ?? null, key);
    return { ok: true, data: { key, value } };
  });

  app.put('/v1/memories', async (req, reply) => {
    const parsed = PutBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: { code: 'invalid_body' } });
    }
    const { scope, scope_id, key, value } = parsed.data;
    if (scope !== 'global' && !scope_id) {
      return reply.code(400).send({ ok: false, error: { code: 'scope_id_required' } });
    }
    await provider.set({
      scope,
      scopeId: scope === 'global' ? null : scope_id ?? null,
      key,
      value,
    });
    return { ok: true, data: { scope, scope_id: scope_id ?? null, key, value } };
  });

  app.delete('/v1/memories', async (req, reply) => {
    const parsed = DelQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: { code: 'invalid_query' } });
    }
    const { scope, scope_id, key } = parsed.data;
    if (scope !== 'global' && !scope_id) {
      return reply.code(400).send({ ok: false, error: { code: 'scope_id_required' } });
    }
    await provider.delete({
      scope,
      scopeId: scope === 'global' ? null : scope_id ?? null,
      key,
    });
    return { ok: true };
  });

  app.get('/v1/structured-memories', async (req, reply) => {
    const parsed = StructuredListQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: { code: 'invalid_query' } });
    }
    return {
      ok: true,
      data: {
        memories: structuredRepo.list({
          includeDisabled: parsed.data.include_disabled,
          includeDeleted: parsed.data.include_deleted,
          limit: parsed.data.limit ?? 100,
        }),
      },
    };
  });

  app.patch<{ Params: { id: string } }>('/v1/structured-memories/:id', async (req, reply) => {
    const parsed = StructuredPatchBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: { code: 'invalid_body' } });
    }
    const row = structuredRepo.setEnabled(req.params.id, parsed.data.enabled);
    if (!row) return reply.code(404).send({ ok: false, error: { code: 'not_found' } });
    return { ok: true, data: row };
  });

  app.delete<{ Params: { id: string } }>('/v1/structured-memories/:id', async (req, reply) => {
    const row = structuredRepo.softDelete(req.params.id);
    if (!row) return reply.code(404).send({ ok: false, error: { code: 'not_found' } });
    return { ok: true };
  });
}
