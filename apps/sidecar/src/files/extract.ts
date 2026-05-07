import { promises as fs } from 'node:fs';

export async function extractTextFromBuffer(buffer: Buffer, mime: string): Promise<string> {
  const lower = mime.toLowerCase();
  if (lower.startsWith('text/') || lower === 'application/json' || lower === '') {
    return buffer.toString('utf8');
  }
  if (lower === 'application/pdf') {
    // @ts-expect-error -- pdf-parse has no types for its inner module path.
    const mod = (await import('pdf-parse/lib/pdf-parse.js')) as unknown as {
      default: (b: Buffer) => Promise<{ text: string }>;
    };
    const parsed = await mod.default(buffer);
    return parsed.text ?? '';
  }
  throw Object.assign(new Error(`unsupported mime for text extraction: ${mime}`), {
    classification: 'validation_error',
  });
}

export async function extractFileText(path: string | null, mime: string): Promise<string> {
  if (!path) {
    throw Object.assign(new Error('file has no original_path'), {
      classification: 'validation_error',
    });
  }
  return extractTextFromBuffer(await fs.readFile(path), mime);
}
