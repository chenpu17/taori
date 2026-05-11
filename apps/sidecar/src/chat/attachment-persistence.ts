import { promises as fs } from 'node:fs';
import path from 'node:path';
import { TaoriError } from '@taori/shared';
import type { ChatRequest } from '@taori/shared';
import type { FilesRepo } from '../db/repos/index.js';

type ChatAttachment = NonNullable<ChatRequest['attachments']>[number];

function sanitizeFilenameSegment(input: string): string {
  const trimmed = input.trim();
  const normalized = trimmed.length > 0 ? trimmed : 'attachment';
  return normalized
    .replace(/[^\w.\-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'attachment';
}

function attachmentFilename(attachment: ChatAttachment): string {
  const preferred = attachment.name
    ? sanitizeFilenameSegment(path.basename(attachment.name))
    : attachment.kind === 'pdf'
      ? 'document.pdf'
      : 'attachment.txt';
  if (/\.[A-Za-z0-9]+$/.test(preferred)) return preferred;
  return `${preferred}.${attachment.kind === 'pdf' ? 'pdf' : 'txt'}`;
}

export async function persistSearchableAttachments(args: {
  conversationId: string;
  messageId: string | null;
  attachments: ChatAttachment[];
  filesRepo: FilesRepo;
  filesDir: string;
}): Promise<ChatAttachment[]> {
  if (args.attachments.length === 0) return args.attachments;
  const out: ChatAttachment[] = [];
  const dir = path.join(args.filesDir, args.conversationId);
  await fs.mkdir(dir, { recursive: true });
  for (const attachment of args.attachments) {
    if (attachment.kind === 'image' || attachment.file_id) {
      out.push(attachment);
      continue;
    }
    const bytes = Buffer.from(attachment.data_b64, 'base64');
    const filename = attachmentFilename(attachment);
    const storedName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${filename}`;
    const fullPath = path.join(dir, storedName);
    try {
      await fs.writeFile(fullPath, bytes);
      const row = args.filesRepo.insert({
        conversation_id: args.conversationId,
        message_id: args.messageId,
        original_path: fullPath,
        mime_type: attachment.mime || 'text/plain',
        size_bytes: bytes.length,
        extracted_text: Buffer.from(attachment.data_b64, 'base64').toString('utf-8'),
      });
      out.push({
        ...attachment,
        file_id: row.id,
      });
    } catch (error) {
      throw new TaoriError({
        code: 'internal',
        message: `附件 ${attachment.name ?? filename} 持久化失败`,
        details: {
          kind: attachment.kind,
          name: attachment.name ?? null,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
  return out;
}
