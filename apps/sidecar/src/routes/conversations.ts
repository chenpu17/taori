/**
 * /v1/conversations — sidebar conversation management (M1 §3.1, CHAT-4/5).
 *
 *   GET    /v1/conversations                    → ConversationSummary[]
 *   GET    /v1/conversations/:id/messages       → Message[]
 *   PATCH  /v1/conversations/:id                → ConversationSummary  (rename)
 *   DELETE /v1/conversations/:id                → 204
 *
 * Conversations are auto-created by /v1/chat (idempotent ensure). This route
 * only exposes read + rename + delete so the renderer can drive the sidebar
 * without leaking persistence details.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { TaoriError } from '@taori/shared';
import { ConversationsRepo, MessagesRepo } from '../db/repos/index.js';
import type { BuildServerArgs } from '../server.js';

const RenameSchema = z.object({
  title: z.string().min(1).max(120).nullable(),
});

export function registerConversationsRoute(
  app: FastifyInstance,
  deps: BuildServerArgs,
): void {
  const convRepo = new ConversationsRepo(deps.db);
  const msgRepo = new MessagesRepo(deps.db);

  app.get('/v1/conversations', async () => {
    return { conversations: convRepo.list() };
  });

  app.get<{ Params: { id: string } }>(
    '/v1/conversations/:id/messages',
    async (req) => {
      const conv = convRepo.get(req.params.id);
      if (!conv) {
        throw new TaoriError({
          code: 'not_found',
          message: `Conversation ${req.params.id} not found`,
        });
      }
      const rows = msgRepo.listByConversation(req.params.id);
      // Strip attachment payloads from the wire — they can be many MBs of
      // base64 each. Renderer only needs presence/count today.
      const messages = rows.map((r) => ({
        id: r.id,
        conversation_id: r.conversation_id,
        role: r.role,
        content: r.content,
        model_id: r.model_id,
        status: r.status,
        error: r.error,
        created_at: r.created_at,
        attachments_count: r.attachments
          ? (() => {
              try {
                return (JSON.parse(r.attachments) as unknown[]).length;
              } catch {
                return 0;
              }
            })()
          : 0,
      }));
      return { conversation: conv, messages };
    },
  );

  app.patch<{ Params: { id: string } }>(
    '/v1/conversations/:id',
    async (req) => {
      const parsed = RenameSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new TaoriError({
          code: 'validation_error',
          message: parsed.error.errors.map((e) => e.message).join('; '),
        });
      }
      const updated = convRepo.rename(req.params.id, parsed.data.title);
      if (!updated) {
        throw new TaoriError({
          code: 'not_found',
          message: `Conversation ${req.params.id} not found`,
        });
      }
      return updated;
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/v1/conversations/:id',
    async (req, reply) => {
      const ok = convRepo.delete(req.params.id);
      if (!ok) {
        throw new TaoriError({
          code: 'not_found',
          message: `Conversation ${req.params.id} not found`,
        });
      }
      reply.code(204).send();
    },
  );
}
