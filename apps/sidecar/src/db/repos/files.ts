import { eq, asc, sql } from 'drizzle-orm';
import { type Db } from '../index.js';
import { files } from '../schema.js';
import { makeId } from '@taori/shared';

export interface FileInsert {
  conversation_id: string | null;
  message_id: string | null;
  original_path: string | null;
  mime_type: string;
  size_bytes: number;
  extracted_text?: string | null;
  preview_data?: string | null;
}

export interface FileRow {
  id: string;
  conversation_id: string | null;
  message_id: string | null;
  original_path: string | null;
  mime_type: string;
  size_bytes: number;
  extracted_text: string | null;
  preview_data: string | null;
  created_at: number;
}

export class FilesRepo {
  constructor(private db: Db) {}

  insert(input: FileInsert): FileRow {
    const id = makeId('file');
    const row = this.db
      .insert(files)
      .values({
        id,
        conversation_id: input.conversation_id,
        message_id: input.message_id,
        original_path: input.original_path,
        mime_type: input.mime_type,
        size_bytes: input.size_bytes,
        extracted_text: input.extracted_text ?? null,
        preview_data: input.preview_data ?? null,
        created_at: Date.now(),
      })
      .returning()
      .get();
    return row as FileRow;
  }

  get(id: string): FileRow | null {
    const row = this.db.select().from(files).where(eq(files.id, id)).get();
    return (row as FileRow | undefined) ?? null;
  }

  listByConversation(conversationId: string): FileRow[] {
    return this.db
      .select()
      .from(files)
      .where(eq(files.conversation_id, conversationId))
      .orderBy(asc(files.created_at))
      .all() as FileRow[];
  }

  setExtractedText(id: string, text: string): void {
    this.db
      .update(files)
      .set({ extracted_text: text })
      .where(eq(files.id, id))
      .run();
  }

  delete(id: string): boolean {
    this.db.run(sql`DELETE FROM file_chunk_fts WHERE file_id = ${id}`);
    const res = this.db.delete(files).where(eq(files.id, id)).run();
    return res.changes > 0;
  }
}
