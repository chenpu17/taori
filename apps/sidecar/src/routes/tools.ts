/**
 * GET  /v1/tools         — list registered tools
 * POST /v1/tools/invoke  — invoke a tool by name
 *
 * Auth: bearer (handled by global hook). Errors are always returned via
 * `{ ok: false, error: { classification, message } }` body, NEVER as 4xx —
 * the renderer needs the classification to decide UI fallback. Only
 * unhandled internal failures escape as 500.
 *
 * M2 §6.1 dev-only test hook: `X-Test-Force-Image-Result` header bypasses
 * the real provider for builtin.image_generate. Allowed values:
 * 'success' | 'quota' | 'content_filter' | 'billed_4xx'.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ToolInvokeRequestSchema } from '@taori/shared';
import type { CapabilityBus } from '../bus/index.js';
import type { TestForceImageResult } from '../bus/builtins/image_generate.js';
import { MemoriesRepo } from '../db/repos/index.js';

const TEST_HOOKS_ENABLED =
  process.env.NODE_ENV !== 'production' &&
  process.env.TAORI_DISABLE_TEST_HOOKS !== '1';
const FORCE_IMAGE_HEADER = 'x-test-force-image-result';
const VALID_FORCED_IMAGE_RESULTS = new Set(['success', 'quota', 'content_filter', 'billed_4xx']);

const EffectiveToolsQuery = z.object({
  conversation_id: z.string().optional().nullable(),
});

const SessionToolBody = z.object({
  conversation_id: z.string().min(1),
  enabled: z.boolean().nullable(),
});

export interface ToolsRouteDeps {
  bus: CapabilityBus;
  memories: MemoriesRepo;
}

export function registerToolsRoute(app: FastifyInstance, deps: ToolsRouteDeps): void {
  app.get('/v1/tools', async () => {
    return { ok: true, data: deps.bus.list() };
  });

  app.get('/v1/tools/effective', async (req, reply) => {
    const parsed = EffectiveToolsQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        error: { classification: 'validation_error', message: 'invalid effective tools request' },
      });
    }
    return {
      ok: true,
      data: deps.bus.list().map((tool) => {
        const sessionEnabled = parsed.data.conversation_id
          ? readSessionToolEnabled(deps.memories, parsed.data.conversation_id, tool.name)
          : null;
        return {
          ...tool,
          session_enabled: sessionEnabled,
          effective_enabled: tool.enabled && sessionEnabled !== false,
        };
      }),
    };
  });

  app.put('/v1/tools/:name/enabled', async (req, reply) => {
    const params = z.object({ name: z.string().min(1) }).safeParse(req.params);
    const body = z.object({ enabled: z.boolean() }).safeParse(req.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({
        ok: false,
        error: { classification: 'validation_error', message: 'invalid tool toggle request' },
      });
    }
    const decodedName = decodeURIComponent(params.data.name);
    const tool = deps.bus.setEnabled(decodedName, body.data.enabled);
    if (!tool) {
      return reply.code(404).send({
        ok: false,
        error: { classification: 'validation_error', message: `Unknown tool: ${decodedName}` },
      });
    }
    deps.memories.set('global', null, toolEnabledKey(decodedName), String(body.data.enabled));
    return { ok: true, data: tool };
  });

  app.put('/v1/tools/:name/session-enabled', async (req, reply) => {
    const params = z.object({ name: z.string().min(1) }).safeParse(req.params);
    const body = SessionToolBody.safeParse(req.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({
        ok: false,
        error: { classification: 'validation_error', message: 'invalid session tool request' },
      });
    }
    const decodedName = decodeURIComponent(params.data.name);
    const tool = deps.bus.get(decodedName);
    if (!tool) {
      return reply.code(404).send({
        ok: false,
        error: { classification: 'validation_error', message: `Unknown tool: ${decodedName}` },
      });
    }
    const key = toolSessionEnabledKey(decodedName);
    if (body.data.enabled === null) {
      deps.memories.delete('session', body.data.conversation_id, key);
    } else {
      deps.memories.set('session', body.data.conversation_id, key, String(body.data.enabled));
    }
    const sessionEnabled = readSessionToolEnabled(
      deps.memories,
      body.data.conversation_id,
      decodedName,
    );
    return {
      ok: true,
      data: {
        name: tool.name,
        description: tool.description,
        capability: tool.capability,
        source: tool.source,
        source_id: tool.source_id,
        enabled: tool.enabled,
        session_enabled: sessionEnabled,
        effective_enabled: tool.enabled && sessionEnabled !== false,
      },
    };
  });

  app.post('/v1/tools/invoke', async (req) => {
    const parsed = ToolInvokeRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          classification: 'validation_error',
          message: parsed.error.errors
            .map((e) => `${e.path.join('.')}: ${e.message}`)
            .join('; '),
        },
      } as const;
    }
    const { name, input, conversation_id, source_message_id } = parsed.data;
    if (conversation_id && isToolDisabledForSession(deps.memories, conversation_id, name)) {
      return {
        ok: true,
        data: {
          ok: false,
          error: {
            classification: 'permission_denied',
            message: `Tool disabled for this conversation: ${name}`,
          },
        },
      } as const;
    }
    const testForce: TestForceImageResult = TEST_HOOKS_ENABLED
      ? readForcedImageResult(req.headers[FORCE_IMAGE_HEADER])
      : null;
    const result = await deps.bus.invoke(name, input, {
      conversationId: conversation_id ?? null,
      sourceMessageId: source_message_id ?? null,
      testForce,
    });
    return { ok: result.ok, data: result } as const;
  });
}

export function toolEnabledKey(name: string): string {
  return `tool_enabled_${name.replace(/[^A-Za-z0-9_.-]/g, '_')}`;
}

export function toolSessionEnabledKey(name: string): string {
  return `tool_session_enabled_${name.replace(/[^A-Za-z0-9_.-]/g, '_')}`;
}

export function readSessionToolEnabled(
  memories: MemoriesRepo,
  conversationId: string | null | undefined,
  name: string,
): boolean | null {
  if (!conversationId) return null;
  const value = memories.get('session', conversationId, toolSessionEnabledKey(name));
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

export function isToolDisabledForSession(
  memories: MemoriesRepo,
  conversationId: string | null | undefined,
  name: string,
): boolean {
  return readSessionToolEnabled(memories, conversationId, name) === false;
}

function readForcedImageResult(raw: unknown): TestForceImageResult {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  return VALID_FORCED_IMAGE_RESULTS.has(v) ? (v as TestForceImageResult) : null;
}
