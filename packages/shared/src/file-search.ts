import { z } from 'zod';

export const FileChunkSchema = z.object({
  id: z.string(),
  file_id: z.string(),
  conversation_id: z.string().nullable(),
  message_id: z.string().nullable(),
  chunk_index: z.number().int().nonnegative(),
  content: z.string(),
  token_count: z.number().int().nonnegative().nullable(),
  char_start: z.number().int().nonnegative(),
  char_end: z.number().int().nonnegative(),
  content_hash: z.string(),
  created_at: z.number().int(),
});
export type FileChunk = z.infer<typeof FileChunkSchema>;

export const FileChunkIndexStatusSchema = z.enum([
  'not_indexed',
  'indexing',
  'indexed',
  'failed',
]);
export type FileChunkIndexStatus = z.infer<typeof FileChunkIndexStatusSchema>;

export const FileSearchRequestSchema = z.object({
  query: z.string().trim().min(1).max(2_000),
  conversation_id: z.string().min(1).optional(),
  file_ids: z.array(z.string().min(1)).max(50).optional(),
  limit: z.number().int().min(1).max(20).default(6),
  include_content: z.boolean().default(true),
});
export type FileSearchRequest = z.infer<typeof FileSearchRequestSchema>;

export const FileSearchResultSchema = z.object({
  chunk_id: z.string(),
  file_id: z.string(),
  conversation_id: z.string().nullable(),
  message_id: z.string().nullable(),
  chunk_index: z.number().int().nonnegative(),
  content: z.string().nullable(),
  snippet: z.string(),
  score: z.number(),
  char_start: z.number().int().nonnegative(),
  char_end: z.number().int().nonnegative(),
});
export type FileSearchResult = z.infer<typeof FileSearchResultSchema>;

export const FileSearchResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    results: z.array(FileSearchResultSchema),
  }),
});
export type FileSearchResponse = z.infer<typeof FileSearchResponseSchema>;

export const FileSearchToolInputSchema = z.object({
  query: z.string().trim().min(1).max(2_000),
  file_ids: z.array(z.string().min(1)).max(50).optional(),
  limit: z.number().int().min(1).max(20).optional(),
});
export type FileSearchToolInput = z.infer<typeof FileSearchToolInputSchema>;

export const FileSearchToolResultSchema = z.object({
  results: z.array(z.object({
    file_id: z.string(),
    chunk_id: z.string(),
    snippet: z.string(),
    chunk_index: z.number().int().nonnegative(),
    score: z.number(),
  })),
});
export type FileSearchToolResult = z.infer<typeof FileSearchToolResultSchema>;

export const FileChunkContextSourceSchema = z.object({
  type: z.literal('file_chunk'),
  label: z.string(),
  scope: z.enum(['request', 'session']),
  active: z.boolean(),
  file_id: z.string(),
  chunk_id: z.string(),
  chunk_index: z.number().int().nonnegative(),
  score: z.number().optional(),
});
export type FileChunkContextSource = z.infer<typeof FileChunkContextSourceSchema>;
