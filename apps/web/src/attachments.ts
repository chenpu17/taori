export type PendingAttachmentKind = 'image' | 'text' | 'pdf';

export interface PendingAttachment {
  id: string;
  name: string;
  mime: string;
  kind: PendingAttachmentKind;
  data_b64: string;
}

const TEXT_FILE_EXTENSIONS = new Set([
  'c', 'cc', 'cpp', 'css', 'csv', 'go', 'h', 'hpp', 'html', 'java', 'js',
  'json', 'jsx', 'md', 'mjs', 'py', 'rb', 'rs', 'sh', 'sql', 'svg', 'toml',
  'ts', 'tsx', 'txt', 'xml', 'yaml', 'yml',
]);

function inferAttachmentKind(file: File): { kind: PendingAttachmentKind; mime: string } | null {
  const mime = file.type || 'application/octet-stream';
  if (mime.startsWith('image/')) return { kind: 'image', mime };
  if (mime === 'application/pdf') return { kind: 'pdf', mime };
  if (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml') {
    return { kind: 'text', mime };
  }
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (TEXT_FILE_EXTENSIONS.has(ext)) {
    return { kind: 'text', mime: mime === 'application/octet-stream' ? 'text/plain' : mime };
  }
  return null;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error(`读取文件失败: ${file.name}`));
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.readAsDataURL(file);
  });
}

export async function toPendingAttachment(file: File): Promise<PendingAttachment | null> {
  const meta = inferAttachmentKind(file);
  if (!meta) return null;
  const dataUrl = await readFileAsDataUrl(file);
  const comma = dataUrl.indexOf(',');
  return {
    id: crypto.randomUUID(),
    name: file.name,
    mime: meta.mime,
    kind: meta.kind,
    data_b64: comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl,
  };
}
