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
import { ToolInvokeRequestSchema } from '@taori/shared';
import type { CapabilityBus } from '../bus/index.js';
import type { TestForceImageResult } from '../bus/builtins/image_generate.js';

const TEST_HOOKS_ENABLED =
  process.env.NODE_ENV !== 'production' &&
  process.env.TAORI_DISABLE_TEST_HOOKS !== '1';
const FORCE_IMAGE_HEADER = 'x-test-force-image-result';
const VALID_FORCED_IMAGE_RESULTS = new Set(['success', 'quota', 'content_filter', 'billed_4xx']);

export interface ToolsRouteDeps {
  bus: CapabilityBus;
}

export function registerToolsRoute(app: FastifyInstance, deps: ToolsRouteDeps): void {
  app.get('/v1/tools', async () => {
    return { ok: true, data: deps.bus.list() };
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

function readForcedImageResult(raw: unknown): TestForceImageResult {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  return VALID_FORCED_IMAGE_RESULTS.has(v) ? (v as TestForceImageResult) : null;
}
