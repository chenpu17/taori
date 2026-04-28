/**
 * builtin.file_read — M2 §4.4.
 *
 * Reads from `files` table only. The `file_id` MUST already exist; we never
 * accept arbitrary filesystem paths from the renderer (see §4.4 安全).
 *
 * Strategy:
 *   1. Lookup `files` row.
 *   2. If `extracted_text` is already set → return it.
 *   3. Else, try on-the-fly extraction:
 *        - `text/*` or empty mime → utf-8 read of original_path
 *        - `application/pdf`      → pdf-parse on original_path
 *      Persist result to `files.extracted_text`.
 *   4. Anything else → error: validation_error "unsupported mime".
 *
 * Truncation: max 200,000 chars (≈50k tokens). Beyond that, truncated=true
 * and text is sliced. The chat layer is responsible for surfacing this to
 * the user.
 */
import { promises as fs } from 'node:fs';
import { z } from 'zod';
import type { ToolDescriptor } from '../index.js';
import type { FilesRepo } from '../../db/repos/index.js';

const InputSchema = z.object({
  file_id: z.string().min(1),
});

export interface FileReadOutput {
  text: string;
  mime: string;
  filename: string | null;
  truncated: boolean;
  bytes: number;
}

const MAX_CHARS = 200_000;

export function createFileReadTool(repo: FilesRepo): ToolDescriptor<
  z.infer<typeof InputSchema>,
  FileReadOutput
> {
  return {
    name: 'builtin.file_read',
    description:
      'Read a previously-uploaded file (by file_id) and return its extracted text.',
    capability: 'file',
    source: 'builtin',
    source_id: 'builtin',
    enabled: true,
    inputSchema: InputSchema,
    async execute(input) {
      const row = repo.get(input.file_id);
      if (!row) {
        throw Object.assign(new Error(`file not found: ${input.file_id}`), {
          classification: 'validation_error',
        });
      }

      const filename = row.original_path
        ? row.original_path.split('/').pop() ?? null
        : null;

      let text = row.extracted_text ?? '';
      let truncated = false;
      if (!text) {
        const fullText = await extract(row.original_path, row.mime_type);
        // Truncate BEFORE persisting so a 50MB PDF doesn't bloat the DB.
        // The bytes column still records the original size on disk.
        if (fullText.length > MAX_CHARS) truncated = true;
        text = fullText.slice(0, MAX_CHARS);
        if (text) repo.setExtractedText(row.id, text);
      } else if (text.length > MAX_CHARS) {
        truncated = true;
        text = text.slice(0, MAX_CHARS);
      }
      return {
        output: {
          text,
          mime: row.mime_type,
          filename,
          truncated,
          bytes: row.size_bytes,
        },
      };
    },
  };
}

async function extract(path: string | null, mime: string): Promise<string> {
  if (!path) {
    throw Object.assign(new Error('file has no original_path'), {
      classification: 'validation_error',
    });
  }
  const lower = mime.toLowerCase();
  if (lower.startsWith('text/') || lower === 'application/json' || lower === '') {
    return await fs.readFile(path, 'utf8');
  }
  if (lower === 'application/pdf') {
    const buf = await fs.readFile(path);
    // @ts-expect-error -- pdf-parse has no types for its inner module path.
    const mod = (await import('pdf-parse/lib/pdf-parse.js')) as unknown as {
      default: (b: Buffer) => Promise<{ text: string }>;
    };
    const parsed = await mod.default(buf);
    return parsed.text ?? '';
  }
  throw Object.assign(new Error(`unsupported mime for file_read: ${mime}`), {
    classification: 'validation_error',
  });
}
