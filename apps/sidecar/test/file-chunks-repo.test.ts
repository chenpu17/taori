import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { openDb } from '../src/db/index.js';
import { ConversationsRepo, FileChunksRepo, FilesRepo } from '../src/db/repos/index.js';

describe('FileChunksRepo', () => {
  let dbPath: string;
  let db: ReturnType<typeof openDb>;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `taori-file-chunks-${Date.now()}-${Math.random()}.db`);
    db = openDb(dbPath);
  });

  afterEach(() => {
    fs.rmSync(dbPath, { force: true });
  });

  it('indexes chunks in FTS and searches with conversation/file filters', () => {
    const conv = new ConversationsRepo(db).create({ title: 'rag' });
    const files = new FilesRepo(db);
    const alpha = files.insert({
      conversation_id: conv.id,
      message_id: null,
      original_path: 'alpha.md',
      mime_type: 'text/markdown',
      size_bytes: 100,
      extracted_text: null,
    });
    const beta = files.insert({
      conversation_id: null,
      message_id: null,
      original_path: 'beta.md',
      mime_type: 'text/markdown',
      size_bytes: 100,
      extracted_text: null,
    });
    const chunks = new FileChunksRepo(db);

    const inserted = chunks.replaceForFile(alpha.id, [
      {
        file_id: alpha.id,
        conversation_id: conv.id,
        message_id: null,
        chunk_index: 0,
        content: 'Taori supports local file search with sqlite bm25 snippets.',
        token_count: 9,
        char_start: 0,
        char_end: 60,
        content_hash: 'h1',
      },
      {
        file_id: alpha.id,
        conversation_id: conv.id,
        message_id: null,
        chunk_index: 1,
        content: 'Budget and memory are unrelated to this retrieval chunk.',
        token_count: 8,
        char_start: 61,
        char_end: 120,
        content_hash: 'h2',
      },
    ]);
    chunks.replaceForFile(beta.id, [
      {
        file_id: beta.id,
        conversation_id: null,
        message_id: null,
        chunk_index: 0,
        content: 'sqlite bm25 can also find this global file chunk.',
        token_count: 8,
        char_start: 0,
        char_end: 50,
        content_hash: 'h3',
      },
    ]);

    expect(inserted).toHaveLength(2);
    expect(chunks.listByFile(alpha.id).map((chunk) => chunk.chunk_index)).toEqual([0, 1]);
    const results = chunks.search({
      query: 'sqlite bm25',
      conversation_id: conv.id,
      file_ids: [alpha.id],
      limit: 3,
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      chunk_id: inserted[0]?.id,
      file_id: alpha.id,
      conversation_id: conv.id,
      chunk_index: 0,
    });
    expect(results[0]?.content).toContain('sqlite bm25');
  });

  it('keeps FTS in sync when replacing or deleting file chunks', () => {
    const file = new FilesRepo(db).insert({
      conversation_id: null,
      message_id: null,
      original_path: 'notes.txt',
      mime_type: 'text/plain',
      size_bytes: 100,
      extracted_text: null,
    });
    const chunks = new FileChunksRepo(db);
    chunks.replaceForFile(file.id, [
      {
        file_id: file.id,
        conversation_id: null,
        message_id: null,
        chunk_index: 0,
        content: 'old searchable phrase',
        token_count: 3,
        char_start: 0,
        char_end: 21,
        content_hash: 'old',
      },
    ]);

    chunks.replaceForFile(file.id, [
      {
        file_id: file.id,
        conversation_id: null,
        message_id: null,
        chunk_index: 0,
        content: 'new searchable phrase',
        token_count: 3,
        char_start: 0,
        char_end: 21,
        content_hash: 'new',
      },
    ]);

    expect(chunks.search({ query: 'old', limit: 5 })).toHaveLength(0);
    expect(chunks.search({ query: 'new', limit: 5 })).toHaveLength(1);
    chunks.deleteForFile(file.id);
    expect(chunks.search({ query: 'new', limit: 5 })).toHaveLength(0);
  });
});
