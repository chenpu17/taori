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
import { ConversationExportQuerySchema, TaoriError } from '@taori/shared';
import {
  ConversationsRepo,
  MessagesRepo,
  FilesRepo,
  CostsRepo,
  ModelsRepo,
  MemoriesRepo,
  PersonasRepo,
  RunEventsRepo,
} from '../db/repos/index.js';
import type { BuildServerArgs } from '../server.js';
import fs from 'node:fs/promises';
import { readSessionToolEnabled } from './tools.js';
import {
  renderConversationMarkdown,
  safeConversationExportFilename,
} from '../conversations/export.js';

const PatchSchema = z
  .object({
    title: z.string().min(1).max(120).nullable().optional(),
    archived: z.boolean().optional(),
    pinned: z.boolean().optional(),
    tags: z.array(z.string().min(1).max(24)).max(3).optional(),
  })
  .refine(
    (d) =>
      d.title !== undefined ||
      d.archived !== undefined ||
      d.pinned !== undefined ||
      d.tags !== undefined,
    {
      message: 'must provide title, archived, pinned, or tags',
    },
  );

export function registerConversationsRoute(
  app: FastifyInstance,
  deps: BuildServerArgs,
): void {
  const convRepo = new ConversationsRepo(deps.db);
  const msgRepo = new MessagesRepo(deps.db);
  const filesRepo = new FilesRepo(deps.db);
  const costsRepo = new CostsRepo(deps.db);
  const modelsRepo = new ModelsRepo(deps.db);
  const memoriesRepo = new MemoriesRepo(deps.db);
  const personasRepo = new PersonasRepo(deps.db);
  const runEventsRepo = new RunEventsRepo(deps.db);

  app.get<{ Querystring: { q?: string } }>('/v1/conversations', async (req) => {
    return { conversations: convRepo.list({ q: req.query.q }) };
  });

  app.get<{ Params: { id: string } }>(
    '/v1/conversations/:id/profile',
    async (req) => {
      const conv = convRepo.get(req.params.id);
      if (!conv) {
        throw new TaoriError({
          code: 'not_found',
          message: `Conversation ${req.params.id} not found`,
        });
      }
      const rows = msgRepo.listByConversation(req.params.id);
      const lastAssistant = [...rows].reverse().find((m) => m.role === 'assistant' && m.model_id);
      const activeModel = lastAssistant?.model_id ? modelsRepo.get(lastAssistant.model_id) : null;
      const personaId = memoriesRepo.get('session', req.params.id, 'active_persona_id');
      const persona = personaId ? personasRepo.get(personaId) : null;
      const effectiveTools = (deps.bus?.list() ?? []).map((tool) => {
        const sessionEnabled = readSessionToolEnabled(memoriesRepo, req.params.id, tool.name);
        return {
          ...tool,
          session_enabled: sessionEnabled,
          effective_enabled: tool.enabled && sessionEnabled !== false,
        };
      });
      const attachmentCount = rows.reduce((sum, row) => {
        if (!row.attachments) return sum;
        try {
          const parsed = JSON.parse(row.attachments);
          return sum + (Array.isArray(parsed) ? parsed.length : 0);
        } catch {
          return sum;
        }
      }, 0);
      const enabledToolCount = effectiveTools.filter((tool) => tool.effective_enabled).length;
      const cost = costsRepo.realtime(req.params.id);
      return {
        ok: true,
        data: {
          conversation_id: conv.id,
          title: conv.title,
          active_model_id: activeModel?.id ?? null,
          active_model_label: activeModel?.display_name ?? activeModel?.model_name ?? null,
          active_persona_id: persona?.id ?? null,
          active_persona_name: persona?.name ?? null,
          effective_tools: effectiveTools,
          context_sources: [
            {
              type: 'model',
              label: activeModel?.display_name ?? activeModel?.model_name ?? '由当前选择决定',
              scope: activeModel ? 'session' : 'request',
              active: Boolean(activeModel),
            },
            {
              type: 'persona',
              label: persona?.name ?? '未绑定 Persona',
              scope: persona ? 'session' : 'default',
              active: Boolean(persona),
            },
            {
              type: 'tool_policy',
              label: `${enabledToolCount}/${effectiveTools.length} 个工具可用`,
              scope: 'session',
              active: enabledToolCount > 0,
            },
            {
              type: 'attachment',
              label: attachmentCount > 0 ? `${attachmentCount} 个历史附件` : '无历史附件',
              scope: 'session',
              active: attachmentCount > 0,
            },
          ],
          cost: {
            current_conversation_usd: cost.current_conversation_usd,
            current_conversation_calls: cost.current_conversation_calls,
          },
        },
      };
    },
  );

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
      // Strip raw base64 payloads but expose image attachment metadata
      // (file_id, mime, width, height) so the renderer can lazy-fetch images.
      const messages = rows.map((r) => {
        type AttachmentItem = { kind?: string; file_id?: string; mime?: string; width?: number; height?: number; data_b64?: string };
        let parsedAttachments: AttachmentItem[] = [];
        if (r.attachments) {
          try { parsedAttachments = JSON.parse(r.attachments) as AttachmentItem[]; } catch { /* ignore */ }
        }
        const imageAttachments = parsedAttachments
          .filter((a) => a.kind === 'image' && a.file_id)
          .map(({ file_id, mime, width, height }) => ({ file_id, mime, width, height }));
        return {
          id: r.id,
          conversation_id: r.conversation_id,
          role: r.role,
          content: r.content,
          model_id: r.model_id,
          status: r.status,
          error: r.error,
          created_at: r.created_at,
          attachments_count: parsedAttachments.length,
          image_attachments: imageAttachments,
        };
      });
      return { conversation: conv, messages };
    },
  );

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/v1/conversations/:id/run-events',
    async (req) => {
      const conv = convRepo.get(req.params.id);
      if (!conv) {
        throw new TaoriError({
          code: 'not_found',
          message: `Conversation ${req.params.id} not found`,
        });
      }
      const rawLimit = Number(req.query.limit ?? 120);
      const limit = Number.isFinite(rawLimit) ? rawLimit : 120;
      return {
        ok: true,
        data: {
          conversation_id: req.params.id,
          events: runEventsRepo.listByConversation(req.params.id, limit),
        },
      };
    },
  );

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/v1/conversations/:id/runs',
    async (req) => {
      const conv = convRepo.get(req.params.id);
      if (!conv) {
        throw new TaoriError({
          code: 'not_found',
          message: `Conversation ${req.params.id} not found`,
        });
      }
      const rawLimit = Number(req.query.limit ?? 20);
      const limit = Number.isFinite(rawLimit) ? rawLimit : 20;
      return {
        ok: true,
        data: {
          conversation_id: req.params.id,
          runs: runEventsRepo.listRunsByConversation(req.params.id, limit),
        },
      };
    },
  );

  app.get<{
    Params: { id: string };
    Querystring: { format?: string; include_timeline?: string };
  }>(
    '/v1/conversations/:id/export',
    async (req, reply) => {
      const parsed = ConversationExportQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw new TaoriError({
          code: 'validation_error',
          message: parsed.error.errors.map((e) => e.message).join('; '),
        });
      }
      const conv = convRepo.get(req.params.id);
      if (!conv) {
        throw new TaoriError({
          code: 'not_found',
          message: `Conversation ${req.params.id} not found`,
        });
      }
      const messages = msgRepo.listByConversation(req.params.id);
      const runEvents = parsed.data.include_timeline === 'summary'
        ? runEventsRepo.listByConversation(req.params.id, 200)
        : [];
      const costs = costsRepo.listByConversation(req.params.id);
      const modelLabels = new Map<string, string>();
      for (const message of messages) {
        if (!message.model_id || modelLabels.has(message.model_id)) continue;
        const model = modelsRepo.get(message.model_id);
        modelLabels.set(
          message.model_id,
          model?.display_name ?? model?.model_name ?? message.model_id,
        );
      }
      const markdown = renderConversationMarkdown({
        conversation: conv,
        messages,
        runEvents,
        costs,
        modelLabels,
        includeTimeline: parsed.data.include_timeline,
      });
      reply.header('Content-Type', 'text/markdown; charset=utf-8');
      reply.header(
        'Content-Disposition',
        `attachment; filename="${safeConversationExportFilename(conv)}"`,
      );
      return markdown;
    },
  );

  app.patch<{ Params: { id: string } }>(
    '/v1/conversations/:id',
    async (req) => {
      const parsed = PatchSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new TaoriError({
          code: 'validation_error',
          message: parsed.error.errors.map((e) => e.message).join('; '),
        });
      }
      let updated = convRepo.get(req.params.id);
      if (!updated) {
        throw new TaoriError({
          code: 'not_found',
          message: `Conversation ${req.params.id} not found`,
        });
      }
      if (parsed.data.title !== undefined) {
        updated = convRepo.rename(req.params.id, parsed.data.title) ?? updated;
      }
      if (parsed.data.archived !== undefined) {
        updated = convRepo.setArchived(req.params.id, parsed.data.archived) ?? updated;
      }
      if (parsed.data.pinned !== undefined) {
        updated = convRepo.setPinned(req.params.id, parsed.data.pinned) ?? updated;
      }
      if (parsed.data.tags !== undefined) {
        updated = convRepo.setTags(req.params.id, parsed.data.tags) ?? updated;
      }
      return updated;
    },
  );

  // POST /v1/conversations/:id/messages — append a non-streaming message
  // (system/note). Used by renderer to persist auto-fallback notices etc
  // (spec 09-m2-spec §1.4: 系统提示需在持久化历史中可见). Limited to
  // role='system' to prevent abuse — assistant content goes through /v1/chat.
  const PostMsgSchema = z.object({
    role: z.literal('system'),
    content: z.string().min(1).max(2000),
  });
  app.post<{ Params: { id: string } }>(
    '/v1/conversations/:id/messages',
    async (req, reply) => {
      const conv = convRepo.get(req.params.id);
      if (!conv) {
        throw new TaoriError({
          code: 'not_found',
          message: `Conversation ${req.params.id} not found`,
        });
      }
      const parsed = PostMsgSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new TaoriError({
          code: 'validation_error',
          message: parsed.error.errors.map((e) => e.message).join('; '),
        });
      }
      const row = msgRepo.insert({
        conversation_id: req.params.id,
        role: parsed.data.role,
        content: parsed.data.content,
        model_id: null,
        status: 'complete',
      });
      reply.code(201);
      return { message: { id: row.id, role: row.role, content: row.content, created_at: row.created_at } };
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

  // C1 — edit a user message and discard everything that came after it.
  // Only role='user' is editable; assistant text comes from the model and
  // mutating it would silently corrupt history. The renderer is expected to
  // call this immediately before re-running /v1/chat to regenerate the
  // response.
  const PatchMsgSchema = z.object({ content: z.string().min(1).max(20000) });
  app.patch<{ Params: { id: string; msgId: string } }>(
    '/v1/conversations/:id/messages/:msgId',
    async (req) => {
      const conv = convRepo.get(req.params.id);
      if (!conv) {
        throw new TaoriError({ code: 'not_found', message: `Conversation ${req.params.id} not found` });
      }
      const target = msgRepo.getById(req.params.msgId);
      if (!target || target.conversation_id !== req.params.id) {
        throw new TaoriError({ code: 'not_found', message: `Message ${req.params.msgId} not found` });
      }
      if (target.role !== 'user') {
        throw new TaoriError({ code: 'validation_error', message: 'Only user messages can be edited' });
      }
      const parsed = PatchMsgSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new TaoriError({ code: 'validation_error', message: parsed.error.errors.map((e) => e.message).join('; ') });
      }
      const updated = msgRepo.editAndTruncate(req.params.msgId, parsed.data.content);
      if (!updated) {
        throw new TaoriError({ code: 'not_found', message: `Message ${req.params.msgId} not found` });
      }
      convRepo.touch(req.params.id);
      return { message: { id: updated.id, role: updated.role, content: updated.content, created_at: updated.created_at } };
    },
  );

  // C1 — branch a conversation from a specific message. The new chat
  // conversation gets a deep copy of every message up to and including the
  // pivot, so the user can fork without disturbing the original thread.
  const BranchSchema = z.object({ title: z.string().min(1).max(120).optional() }).optional();
  app.post<{ Params: { id: string; msgId: string } }>(
    '/v1/conversations/:id/messages/:msgId/branch',
    async (req, reply) => {
      const conv = convRepo.get(req.params.id);
      if (!conv) {
        throw new TaoriError({ code: 'not_found', message: `Conversation ${req.params.id} not found` });
      }
      const target = msgRepo.getById(req.params.msgId);
      if (!target || target.conversation_id !== req.params.id) {
        throw new TaoriError({ code: 'not_found', message: `Message ${req.params.msgId} not found` });
      }
      const parsed = BranchSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new TaoriError({ code: 'validation_error', message: parsed.error.errors.map((e) => e.message).join('; ') });
      }
      const baseTitle = parsed.data?.title ?? (conv.title ? `${conv.title} · 分支` : '分支对话');
      const created = convRepo.create({ type: 'chat', title: baseTitle.slice(0, 120) });
      const copied = msgRepo.cloneUpTo(req.params.msgId, created.id);
      reply.code(201);
      return { conversation: created, copied_messages: copied };
    },
  );

  // GET /v1/files/:id/data — return file bytes as base64 for inline rendering.
  // Used by the renderer to lazy-load generated images stored on disk.
  app.get<{ Params: { id: string } }>(
    '/v1/files/:id/data',
    async (req) => {
      const row = filesRepo.get(req.params.id);
      if (!row) {
        throw new TaoriError({ code: 'not_found', message: `File ${req.params.id} not found` });
      }
      if (!row.original_path) {
        throw new TaoriError({ code: 'not_found', message: `File ${req.params.id} has no path` });
      }
      const buf = await fs.readFile(row.original_path);
      return {
        ok: true,
        file_id: row.id,
        content_type: row.mime_type,
        data_b64: buf.toString('base64'),
        size_bytes: row.size_bytes,
      };
    },
  );
}
