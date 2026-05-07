import { describe, it, expect } from 'vitest';
import { buildFileChunks } from '../src/files/chunker.js';

describe('buildFileChunks', () => {
  it('chunks text deterministically with overlap and stable hashes', () => {
    const paragraphs = Array.from({ length: 12 }, (_, i) =>
      `Section ${i}: Taori local retrieval keeps file context focused and cites snippets.`,
    );
    const text = paragraphs.join('\n\n');

    const chunksA = buildFileChunks({
      file_id: 'file_a',
      conversation_id: 'conv_a',
      message_id: 'msg_a',
      text,
      targetTokens: 28,
      overlapTokens: 10,
      maxTokens: 60,
    });
    const chunksB = buildFileChunks({
      file_id: 'file_a',
      conversation_id: 'conv_a',
      message_id: 'msg_a',
      text,
      targetTokens: 28,
      overlapTokens: 10,
      maxTokens: 60,
    });

    expect(chunksA.length).toBeGreaterThan(1);
    expect(chunksA.map((chunk) => chunk.content_hash)).toEqual(
      chunksB.map((chunk) => chunk.content_hash),
    );
    expect(chunksA.map((chunk) => chunk.chunk_index)).toEqual(
      chunksA.map((_, index) => index),
    );
    expect(chunksA[1]?.char_start).toBeLessThan(chunksA[0]!.char_end);
    expect(Math.max(...chunksA.map((chunk) => chunk.token_count ?? 0))).toBeLessThanOrEqual(70);
  });

  it('splits oversized paragraphs under max token budget', () => {
    const text = Array.from({ length: 800 }, (_, i) => `word${i}`).join(' ');
    const chunks = buildFileChunks({
      file_id: 'file_long',
      conversation_id: null,
      message_id: null,
      text,
      targetTokens: 80,
      overlapTokens: 0,
      maxTokens: 100,
    });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.token_count ?? 0).toBeLessThanOrEqual(120);
      expect(chunk.char_end).toBeGreaterThan(chunk.char_start);
      expect(chunk.content_hash).toMatch(/^[a-f0-9]{64}$/);
    }
  });
});
