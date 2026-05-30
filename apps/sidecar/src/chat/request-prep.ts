import type { ChatRequest, Model } from '@taori/shared';
import { TaoriError } from '@taori/shared';
import type { Db } from '../db/index.js';
import type {
  ConversationRow,
  ConversationsRepo,
  FilesRepo,
  MemoriesRepo,
  MessageRow,
  MessagesRepo,
  PersonasRepo,
} from '../db/repos/index.js';
import { MessagesRepo as TxMessagesRepo } from '../db/repos/index.js';
import { detectImageCommand, detectImageIntent } from '../intent.js';
import type { BoundPersona } from './run-actions.js';
import { persistSearchableAttachments } from './attachment-persistence.js';
import { computeAutoTitle } from './auto-title.js';

type ChatAttachment = NonNullable<ChatRequest['attachments']>[number];
type ChatMessage = ChatRequest['messages'][number];

export interface PreparedChatRequest {
  conversation: ConversationRow;
  attachments: ChatAttachment[];
  hasImage: boolean;
  lastUserMsg: ChatMessage | undefined;
  resolvedPersona: BoundPersona | null;
  intentRoute: { prompt: string; user_message_id: string } | null;
  sourceUserMessageId: string | null;
  assistantMsg: MessageRow | null;
}

export async function prepareChatRequest(args: {
  db: Db;
  body: ChatRequest;
  model: Model | null;
  convRepo: ConversationsRepo;
  msgRepo: MessagesRepo;
  filesRepo: FilesRepo;
  filesDir: string;
  memoriesRepo: MemoriesRepo;
  personasRepo: PersonasRepo;
}): Promise<PreparedChatRequest> {
  let attachments = [...(args.body.attachments ?? [])];
  const hasImage = attachments.some((a) => a.kind === 'image');
  const lastUserMsg = [...args.body.messages].reverse().find((m) => m.role === 'user');

  validateAttachmentSizes(attachments);
  const conversation = args.convRepo.ensure(args.body.conversation_id);
  const resolvedPersona = resolvePersonaBinding({
    conversationId: conversation.id,
    personaId: args.body.persona_id,
    memoriesRepo: args.memoriesRepo,
    personasRepo: args.personasRepo,
  });
  applyAutoTitle(args.convRepo, conversation, lastUserMsg);
  validateVisionSupport({ hasImage, model: args.model });
  await parsePdfAttachments(attachments);
  if (attachments.length > 0 && !args.model) {
    throw new TaoriError({
      code: 'not_found',
      message: '未找到所选模型，无法处理附件。',
    });
  }

  const intentRoute = persistImageIntentRoute({
    db: args.db,
    body: args.body,
    conversationId: conversation.id,
    model: args.model,
    hasImage,
    lastUserMsg,
    attachments,
  });

  let sourceUserMessageId: string | null = intentRoute?.user_message_id ?? null;
  const assistantMsg = intentRoute
    ? null
    : args.db.transaction((tx) => {
        const txMsgRepo = new TxMessagesRepo(tx);
        if (lastUserMsg && !args.body.skip_user_persist) {
          const userRow = txMsgRepo.insert({
            conversation_id: conversation.id,
            role: 'user',
            content: lastUserMsg.content,
            status: 'complete',
            attachments: attachments.length > 0 ? JSON.stringify(attachments) : null,
          });
          sourceUserMessageId = userRow.id;
        } else if (lastUserMsg) {
          const existingUser = txMsgRepo
            .listByConversation(conversation.id)
            .filter((m) => m.role === 'user')
            .at(-1);
          sourceUserMessageId = existingUser?.id ?? null;
        }
        return txMsgRepo.insert({
          conversation_id: conversation.id,
          role: 'assistant',
          content: '',
          model_id: args.model?.id ?? null,
          status: 'streaming',
        });
      });

  if (sourceUserMessageId && attachments.length > 0) {
    attachments = await persistSearchableAttachments({
      conversationId: conversation.id,
      messageId: sourceUserMessageId,
      attachments,
      filesRepo: args.filesRepo,
      filesDir: args.filesDir,
    });
    args.msgRepo.updateAttachments(sourceUserMessageId, JSON.stringify(attachments));
  }

  return {
    conversation,
    attachments,
    hasImage,
    lastUserMsg,
    resolvedPersona,
    intentRoute,
    sourceUserMessageId,
    assistantMsg,
  };
}

function validateAttachmentSizes(attachments: ChatAttachment[]): void {
  const totalAttachmentBytes = attachments.reduce(
    (sum, a) => sum + a.data_b64.length,
    0,
  );
  if (totalAttachmentBytes > 20_000_000) {
    throw new TaoriError({
      code: 'validation_error',
      message: '附件总大小不能超过 20MB（base64）',
    });
  }

  const textB64Cap = 400_000;
  const oversizedText = attachments.find(
    (a) => a.kind === 'text' && a.data_b64.length > textB64Cap,
  );
  if (oversizedText) {
    throw new TaoriError({
      code: 'validation_error',
      message: `文本附件 ${oversizedText.name ?? ''} 过大（超过 ~300KB），请精简后重试。`,
    });
  }
}

function resolvePersonaBinding(args: {
  conversationId: string;
  personaId: string | undefined;
  memoriesRepo: MemoriesRepo;
  personasRepo: PersonasRepo;
}): BoundPersona | null {
  if (args.personaId) {
    const persona = args.personasRepo.get(args.personaId);
    if (!persona) {
      throw new TaoriError({
        code: 'not_found',
        message: `Persona ${args.personaId} not found`,
      });
    }
    args.memoriesRepo.set('session', args.conversationId, 'active_persona_id', persona.id);
    return { id: persona.id, name: persona.name, prompt: persona.prompt };
  }

  const boundPersonaId = args.memoriesRepo.get(
    'session',
    args.conversationId,
    'active_persona_id',
  );
  if (!boundPersonaId) return null;
  const boundPersona = args.personasRepo.get(boundPersonaId);
  if (boundPersona) {
    return {
      id: boundPersona.id,
      name: boundPersona.name,
      prompt: boundPersona.prompt,
    };
  }
  args.memoriesRepo.delete('session', args.conversationId, 'active_persona_id');
  return null;
}

function applyAutoTitle(
  convRepo: ConversationsRepo,
  conversation: ConversationRow,
  lastUserMsg: ChatMessage | undefined,
): void {
  if (conversation.title || !lastUserMsg?.content) return;
  const title = computeAutoTitle(lastUserMsg.content);
  if (title) convRepo.rename(conversation.id, title);
}

function validateVisionSupport(args: {
  hasImage: boolean;
  model: Model | null;
}): void {
  if (!args.hasImage || !args.model || args.model.supports_vision) return;
  throw new TaoriError({
    code: 'validation_error',
    message: '当前模型不支持图片输入；请切换到带 👁 的视觉模型后重新发送。',
    details: { model_id: args.model.id, supports_vision: false },
  });
}

async function parsePdfAttachments(attachments: ChatAttachment[]): Promise<void> {
  const pdfTextCap = 200_000;
  const PDF_PARSE_TIMEOUT_MS = 5_000;
  for (let i = 0; i < attachments.length; i++) {
    const attachment = attachments[i]!;
    if (attachment.kind !== 'pdf') continue;
    let parsed: string;
    try {
      const buf = Buffer.from(attachment.data_b64, 'base64');
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-expect-error -- no .d.ts for the inner path; avoids pdf-parse index debug mode.
      const mod = (await import('pdf-parse/lib/pdf-parse.js')) as unknown as {
        default: (b: Buffer) => Promise<{ text: string }>;
      };
      const parsePromise = mod.default(buf);
      const result = await Promise.race([
        parsePromise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('PDF 解析超时（超过 5 秒），文件可能过大。')), PDF_PARSE_TIMEOUT_MS),
        ),
      ]);
      parsed = (result.text ?? '').trim();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const isTimeout = msg.includes('超时') || msg.includes('timeout');
      throw new TaoriError({
        code: 'validation_error',
        message: isTimeout
          ? `PDF 解析超时：${attachment.name ?? 'document.pdf'} — 文件页数过多，请精简后重试，或将内容以文本附件方式上传。`
          : `PDF 解析失败：${attachment.name ?? 'document.pdf'} — 文件可能损坏或为扫描件。`,
        details: {
          kind: 'pdf',
          name: attachment.name ?? null,
          err: msg,
        },
      });
    }
    if (!parsed) {
      throw new TaoriError({
        code: 'validation_error',
        message: `PDF ${attachment.name ?? ''} 没有可提取的文本（可能是纯图片扫描件）。请改用图片附件 + 视觉模型。`,
        details: { kind: 'pdf', name: attachment.name ?? null },
      });
    }
    if (parsed.length > pdfTextCap) {
      parsed = parsed.slice(0, pdfTextCap) +
        `\n…（已截断，原 PDF 文本超过 ${Math.round(pdfTextCap / 1024)}KB）`;
    }
    attachments[i] = {
      ...attachment,
      mime: 'text/plain',
      data_b64: Buffer.from(parsed, 'utf-8').toString('base64'),
    };
  }
}

function persistImageIntentRoute(args: {
  db: Db;
  body: ChatRequest;
  conversationId: string;
  model: Model | null;
  hasImage: boolean;
  lastUserMsg: ChatMessage | undefined;
  attachments: ChatAttachment[];
}): { prompt: string; user_message_id: string } | null {
  if (!args.lastUserMsg?.content) return null;
  const command = detectImageCommand(args.lastUserMsg.content);
  const imageIntent =
    command.hit
      ? command
      : args.hasImage
        ? { hit: false, prompt: '' }
        : args.model?.supports_tools === true
          ? { hit: false, prompt: '' }
          : detectImageIntent(args.lastUserMsg.content);
  if (!imageIntent.hit) return null;
  const userRow = args.db.transaction((tx) => {
    const txMsgRepo = new TxMessagesRepo(tx);
    return txMsgRepo.insert({
      conversation_id: args.conversationId,
      role: 'user',
      content: args.lastUserMsg!.content,
      status: 'complete',
      attachments: args.attachments.length > 0 ? JSON.stringify(args.attachments) : null,
    });
  });
  return { prompt: imageIntent.prompt, user_message_id: userRow.id };
}
