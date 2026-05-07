import { countTokens } from 'gpt-tokenizer';

export type TokenCountContent =
  | string
  | Array<{
      type?: string;
      text?: string;
      [key: string]: unknown;
    }>
  | null
  | undefined;

export interface TokenCountMessage {
  role?: string;
  content?: TokenCountContent;
}

const DEFAULT_IMAGE_TOKEN_ESTIMATE = 1024;

function heuristicTokenCount(text: string): number {
  let weighted = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    const isCjkLike =
      (cp >= 0x3040 && cp <= 0x9fff) ||
      (cp >= 0xac00 && cp <= 0xd7af) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0x20000 && cp <= 0x2ffff);
    weighted += isCjkLike ? 2 : 1;
  }
  return Math.max(1, Math.ceil(weighted / 4));
}

export function countInputTokens(text: string): number {
  if (!text) return 0;
  try {
    return Math.max(
      1,
      countTokens(text, {
        disallowedSpecial: new Set<string>(),
      }),
    );
  } catch {
    return heuristicTokenCount(text);
  }
}

export function textForTokenCount(content: TokenCountContent): {
  text: string;
  imageCount: number;
} {
  if (typeof content === 'string') return { text: content, imageCount: 0 };
  if (!Array.isArray(content)) return { text: '', imageCount: 0 };
  let imageCount = 0;
  const text = content
    .map((part) => {
      if (typeof part?.text === 'string') return part.text;
      if (part?.type === 'image') {
        imageCount += 1;
        return '[image]';
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
  return { text, imageCount };
}

export function countMessageTokens(
  message: TokenCountMessage,
  opts: { imageTokenEstimate?: number } = {},
): number {
  const { text, imageCount } = textForTokenCount(message.content);
  const imageTokens = imageCount * (opts.imageTokenEstimate ?? DEFAULT_IMAGE_TOKEN_ESTIMATE);
  return Math.max(4, countInputTokens(text) + imageTokens + 4);
}

export function countMessagesTokens(
  messages: TokenCountMessage[],
  opts: { imageTokenEstimate?: number } = {},
): number {
  return messages.reduce((sum, message) => sum + countMessageTokens(message, opts), 0);
}
