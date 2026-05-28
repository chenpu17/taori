import type { FastifyInstance } from 'fastify';
import { FileSearchRequestSchema, TaoriError } from '@taori/shared';
import type { BuildServerArgs } from '../server.js';
import { type FileRow } from '../db/repos/index.js';
import { ensureFileIndexed } from '../files/indexer.js';

export function registerFilesRoute(app: FastifyInstance, deps: BuildServerArgs): void {
  const filesRepo = deps.repos.files;
  const chunksRepo = deps.repos.fileChunks;

  app.post('/v1/files/search', async (req) => {
    const parsed = FileSearchRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new TaoriError({
        code: 'validation_error',
        message: parsed.error.errors.map((e) => e.message).join('; '),
      });
    }
    const body = parsed.data;
    const candidates = body.file_ids?.length
      ? body.file_ids.map((id) => {
          const row = filesRepo.get(id);
          if (!row) {
            throw new TaoriError({
              code: 'not_found',
              message: `File ${id} not found`,
            });
          }
          return row;
        })
      : body.conversation_id
        ? filesRepo.listByConversation(body.conversation_id)
        : [];
    for (const file of candidates) {
      await ensureFileIndexed(file, { filesRepo, chunksRepo });
    }
    return {
      ok: true,
      data: {
        results: chunksRepo.search(body),
      },
    };
  });
}
