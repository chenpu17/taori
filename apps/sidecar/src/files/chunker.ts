import crypto from 'node:crypto';
import { countInputTokens } from '@taori/shared';
import type { FileChunkInsert } from '../db/repos/index.js';

export interface BuildFileChunksInput {
  file_id: string;
  conversation_id: string | null;
  message_id: string | null;
  text: string;
  targetTokens?: number;
  overlapTokens?: number;
  maxTokens?: number;
}

interface TextSegment {
  content: string;
  char_start: number;
  char_end: number;
  token_count: number;
}

function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function splitOversizedSegment(segment: TextSegment, maxTokens: number): TextSegment[] {
  if (segment.token_count <= maxTokens) return [segment];
  const charsPerToken = Math.max(1, Math.floor(segment.content.length / segment.token_count));
  const maxChars = Math.max(400, maxTokens * charsPerToken);
  const out: TextSegment[] = [];
  for (let offset = 0; offset < segment.content.length; offset += maxChars) {
    const content = segment.content.slice(offset, offset + maxChars).trim();
    if (!content) continue;
    out.push({
      content,
      char_start: segment.char_start + offset,
      char_end: segment.char_start + offset + content.length,
      token_count: countInputTokens(content),
    });
  }
  return out;
}

function textSegments(text: string, maxTokens: number): TextSegment[] {
  const normalized = text.replace(/\r\n/g, '\n');
  const matches = [...normalized.matchAll(/\S[\s\S]*?(?=\n{2,}|$)/g)];
  const base = matches.map((match) => {
    const raw = match[0] ?? '';
    const leading = raw.length - raw.trimStart().length;
    const content = raw.trim();
    const char_start = (match.index ?? 0) + leading;
    return {
      content,
      char_start,
      char_end: char_start + content.length,
      token_count: countInputTokens(content),
    };
  }).filter((segment) => segment.content.length > 0);
  return base.flatMap((segment) => splitOversizedSegment(segment, maxTokens));
}

function trailingOverlap(segments: TextSegment[], overlapTokens: number): TextSegment[] {
  if (overlapTokens <= 0) return [];
  const out: TextSegment[] = [];
  let total = 0;
  for (const segment of [...segments].reverse()) {
    if (total >= overlapTokens) break;
    out.unshift(segment);
    total += segment.token_count;
  }
  return out;
}

export function buildFileChunks(input: BuildFileChunksInput): FileChunkInsert[] {
  const targetTokens = input.targetTokens ?? 800;
  const overlapTokens = input.overlapTokens ?? 120;
  const maxTokens = input.maxTokens ?? 1_200;
  const segments = textSegments(input.text, maxTokens);
  const chunks: FileChunkInsert[] = [];
  let current: TextSegment[] = [];
  let currentTokens = 0;

  const flush = (): void => {
    if (current.length === 0) return;
    const content = current.map((segment) => segment.content).join('\n\n').trim();
    if (!content) return;
    chunks.push({
      file_id: input.file_id,
      conversation_id: input.conversation_id,
      message_id: input.message_id,
      chunk_index: chunks.length,
      content,
      token_count: countInputTokens(content),
      char_start: current[0]!.char_start,
      char_end: current[current.length - 1]!.char_end,
      content_hash: hashContent(content),
    });
    current = trailingOverlap(current, overlapTokens);
    currentTokens = current.reduce((sum, segment) => sum + segment.token_count, 0);
  };

  for (const segment of segments) {
    if (current.length > 0 && currentTokens + segment.token_count > targetTokens) {
      flush();
    }
    current.push(segment);
    currentTokens += segment.token_count;
    if (currentTokens >= maxTokens) flush();
  }
  flush();
  return chunks;
}
