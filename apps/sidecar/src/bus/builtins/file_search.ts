import { FileSearchToolInputSchema } from '@taori/shared';
import type { FileSearchToolInput, FileSearchToolResult } from '@taori/shared';
import type { ToolDescriptor } from '../index.js';
import type { FileChunksRepo, FilesRepo, FileRow } from '../../db/repos/index.js';
import { ensureFileIndexed } from '../../files/indexer.js';

export function createFileSearchTool(deps: {
  filesRepo: FilesRepo;
  chunksRepo: FileChunksRepo;
}): ToolDescriptor<FileSearchToolInput, FileSearchToolResult> {
  return {
    name: 'builtin.file_search',
    description:
      'Search previously uploaded local files and return the most relevant snippets with file/chunk citations. Prefer this over reading whole long files.',
    capability: 'file',
    source: 'builtin',
    source_id: 'builtin',
    enabled: true,
    inputSchema: FileSearchToolInputSchema,
    async execute(input, ctx) {
      const candidates: FileRow[] = input.file_ids?.length
        ? input.file_ids.map((id) => {
            const row = deps.filesRepo.get(id);
            if (!row) {
              throw Object.assign(new Error(`file not found: ${id}`), {
                classification: 'validation_error',
              });
            }
            return row;
          })
        : ctx.conversationId
          ? deps.filesRepo.listByConversation(ctx.conversationId)
          : [];
      for (const file of candidates) {
        await ensureFileIndexed(file, deps);
      }
      const results = deps.chunksRepo.search({
        query: input.query,
        file_ids: input.file_ids,
        conversation_id: ctx.conversationId ?? null,
        limit: input.limit,
        include_content: false,
      });
      return {
        output: {
          results: results.map((result) => ({
            file_id: result.file_id,
            chunk_id: result.chunk_id,
            snippet: result.snippet,
            chunk_index: result.chunk_index,
            score: result.score,
          })),
        },
      };
    },
  };
}
