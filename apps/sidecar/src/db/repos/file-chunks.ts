import path from 'node:path';
import { eq, asc, sql } from 'drizzle-orm';
import { type Db } from '../index.js';
import { file_chunks, files } from '../schema.js';
import type { FileChunk, FileSearchResult } from '@taori/shared';
import { makeId } from '@taori/shared';

type FileChunkRow = typeof file_chunks.$inferSelect;

function toFileChunk(row: FileChunkRow): FileChunk {
  return {
    id: row.id,
    file_id: row.file_id,
    conversation_id: row.conversation_id,
    message_id: row.message_id,
    chunk_index: row.chunk_index,
    content: row.content,
    token_count: row.token_count,
    char_start: row.char_start,
    char_end: row.char_end,
    content_hash: row.content_hash,
    created_at: row.created_at,
  };
}

export interface FileChunkInsert {
  id?: string;
  file_id: string;
  conversation_id: string | null;
  message_id: string | null;
  chunk_index: number;
  content: string;
  token_count: number | null;
  char_start: number;
  char_end: number;
  content_hash: string;
}

function ftsQuery(input: string): string {
  const tokens = input.match(/[\p{L}\p{N}_]+/gu) ?? [];
  const cleaned = tokens.map((token) => token.replace(/"/g, '""')).filter(Boolean);
  if (cleaned.length === 0) return input.replace(/"/g, '""');
  return cleaned.map((token) => `"${token}"`).join(' OR ');
}

export class FileChunksRepo {
  constructor(private db: Db) {}

  listByFile(fileId: string): FileChunk[] {
    return this.db
      .select()
      .from(file_chunks)
      .where(eq(file_chunks.file_id, fileId))
      .orderBy(asc(file_chunks.chunk_index))
      .all()
      .map((row) => toFileChunk(row as FileChunkRow));
  }

  replaceForFile(fileId: string, chunks: FileChunkInsert[]): FileChunk[] {
    return this.db.transaction((tx) => {
      tx.delete(file_chunks).where(eq(file_chunks.file_id, fileId)).run();
      tx.run(sql`DELETE FROM file_chunk_fts WHERE file_id = ${fileId}`);
      if (chunks.length === 0) return [];
      const now = Date.now();
      const rows = chunks.map((chunk) => ({
        id: chunk.id ?? makeId('file_chunk'),
        file_id: fileId,
        conversation_id: chunk.conversation_id,
        message_id: chunk.message_id,
        chunk_index: chunk.chunk_index,
        content: chunk.content,
        token_count: chunk.token_count,
        char_start: chunk.char_start,
        char_end: chunk.char_end,
        content_hash: chunk.content_hash,
        created_at: now,
      }));
      const inserted = tx.insert(file_chunks).values(rows).returning().all() as FileChunkRow[];
      for (const row of inserted) {
        tx.run(sql`
          INSERT INTO file_chunk_fts (content, chunk_id, file_id, conversation_id)
          VALUES (${row.content}, ${row.id}, ${row.file_id}, ${row.conversation_id})
        `);
      }
      return inserted.map(toFileChunk);
    });
  }

  deleteForFile(fileId: string): void {
    this.db.delete(file_chunks).where(eq(file_chunks.file_id, fileId)).run();
    this.db.run(sql`DELETE FROM file_chunk_fts WHERE file_id = ${fileId}`);
  }

  search(input: {
    query: string;
    conversation_id?: string | null;
    file_ids?: string[];
    limit?: number;
    include_content?: boolean;
  }): FileSearchResult[] {
    const limit = Math.max(1, Math.min(20, input.limit ?? 6));
    const match = ftsQuery(input.query);
    const rows = this.db.all(sql`
      SELECT
        fc.id AS chunk_id,
        fc.file_id AS file_id,
        f.original_path AS original_path,
        fc.conversation_id AS conversation_id,
        fc.message_id AS message_id,
        fc.chunk_index AS chunk_index,
        fc.content AS content,
        bm25(file_chunk_fts) AS score,
        fc.char_start AS char_start,
        fc.char_end AS char_end
      FROM file_chunk_fts
      JOIN file_chunks fc ON fc.id = file_chunk_fts.chunk_id
      JOIN files f ON f.id = fc.file_id
      WHERE file_chunk_fts MATCH ${match}
      ORDER BY bm25(file_chunk_fts) ASC
      LIMIT ${Math.max(limit * 4, limit)}
    `) as Array<{
      chunk_id: string;
      file_id: string;
      original_path: string | null;
      conversation_id: string | null;
      message_id: string | null;
      chunk_index: number;
      content: string;
      score: number;
      char_start: number;
      char_end: number;
    }>;
    const fileSet = input.file_ids?.length ? new Set(input.file_ids) : null;
    const perFile = new Map<string, number>();
    const out: FileSearchResult[] = [];
    for (const row of rows) {
      if (input.conversation_id && row.conversation_id !== input.conversation_id) continue;
      if (fileSet && !fileSet.has(row.file_id)) continue;
      const usedForFile = perFile.get(row.file_id) ?? 0;
      if (usedForFile >= 2) continue;
      perFile.set(row.file_id, usedForFile + 1);
      out.push({
        chunk_id: row.chunk_id,
        file_id: row.file_id,
        file_name: row.original_path ? path.basename(row.original_path) : null,
        conversation_id: row.conversation_id,
        message_id: row.message_id,
        chunk_index: row.chunk_index,
        content: input.include_content === false ? null : row.content,
        snippet: row.content.length > 600 ? `${row.content.slice(0, 600)}…` : row.content,
        score: row.conversation_id === input.conversation_id ? row.score - 0.1 : row.score,
        char_start: row.char_start,
        char_end: row.char_end,
      });
      if (out.length >= limit) break;
    }
    return out.sort((a, b) => a.score - b.score);
  }
}
