import type { FileChunksRepo, FilesRepo, FileRow } from '../db/repos/index.js';
import { buildFileChunks } from './chunker.js';
import { extractFileText } from './extract.js';

const MAX_INDEX_CHARS = 200_000;

export async function ensureFileIndexed(
  file: FileRow,
  deps: {
    filesRepo: FilesRepo;
    chunksRepo: FileChunksRepo;
  },
): Promise<void> {
  if (deps.chunksRepo.listByFile(file.id).length > 0) return;
  let text = file.extracted_text ?? '';
  if (!text) {
    text = (await extractFileText(file.original_path, file.mime_type)).slice(0, MAX_INDEX_CHARS);
    if (text) deps.filesRepo.setExtractedText(file.id, text);
  }
  if (!text.trim()) return;
  deps.chunksRepo.replaceForFile(file.id, buildFileChunks({
    file_id: file.id,
    conversation_id: file.conversation_id,
    message_id: file.message_id,
    text,
  }));
}
