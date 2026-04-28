/**
 * Image-intent detection — M2 §2.2.
 *
 * Pure regex / string scanning. NO LLM. Goal: ≤ 5 ms (per §7.1).
 *
 * Triggers (any one matches):
 *   1. command-style at start: /image, /draw, /img
 *   2. zh imperative: 画一张 / 画个 / 画张 / 画 + 名词 / 生成图片 / 生成图像 / 绘制 …
 *   3. en imperative at start: draw / generate image
 *
 * Negative-context whitelist (any one defeats positive match):
 *   已经 / 已 / 上次 / 那张 / 那个 / 参考 / like the one / already
 *
 * Public API: `detectImageIntent(text)` → `{ hit: boolean, prompt: string }`.
 */

const NEGATIVE_PATTERNS = [
  /已经/,
  /上次/,
  /那张/,
  /那个/,
  /参考/,
  /like\s+the\s+one/i,
  /\balready\b/i,
];

const COMMAND_PATTERNS = [
  /^\s*\/(image|img|draw)\b/i,
];

const ZH_IMPERATIVE_PATTERNS = [
  /^\s*画(一张|个|张)/,
  /^\s*画[\s\u4e00-\u9fff]/, // "画 + Chinese char or space" at start
  /生成图片/,
  /生成图像/,
  /^\s*绘制/,
];

const EN_IMPERATIVE_PATTERNS = [
  /^\s*draw\s+/i,
  /\bgenerate\s+(an?\s+)?image\b/i,
];

export interface ImageIntent {
  hit: boolean;
  /** Cleaned prompt, with the trigger phrase preserved unless it was a slash command */
  prompt: string;
}

export function detectImageIntent(rawText: string): ImageIntent {
  const text = rawText ?? '';
  if (!text.trim()) return { hit: false, prompt: '' };

  // Negative context wins, even if a positive trigger fires.
  for (const neg of NEGATIVE_PATTERNS) {
    if (neg.test(text)) return { hit: false, prompt: '' };
  }

  let matched = false;
  let prompt = text.trim();

  for (const re of COMMAND_PATTERNS) {
    const m = re.exec(text);
    if (m) {
      matched = true;
      prompt = text.slice(m.index + m[0].length).trim();
      break;
    }
  }

  if (!matched) {
    for (const re of [...ZH_IMPERATIVE_PATTERNS, ...EN_IMPERATIVE_PATTERNS]) {
      if (re.test(text)) {
        matched = true;
        break;
      }
    }
  }

  return { hit: matched, prompt: prompt || text.trim() };
}

/**
 * Check the session-scoped escape memory `intent_route_disabled_until`.
 * Returns true if the user opted out within the past 30 min for this conv.
 *
 * Memory value stored as ms-since-epoch string (M2 §5.2 codifies session
 * scope). Anything not parseable / in the past = NOT disabled.
 */
export function isIntentDisabledUntilNow(
  rawValue: string | null | undefined,
  now: number,
): boolean {
  if (!rawValue) return false;
  const ts = Number(rawValue);
  return Number.isFinite(ts) && ts > now;
}
