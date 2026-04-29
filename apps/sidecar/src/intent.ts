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
  /已/,
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
  // Direct imperatives anchored at start.
  /^\s*画(一张|一幅|个|张|幅)/,
  /^\s*画[\s\u4e00-\u9fff]/,
  /^\s*绘制/,
  /^\s*生成(?:一)?(?:张|幅|个|副)?(?:图|画|图片|图像|海报|插画|插图|封面)/,
  // Polite-form prefixes — "帮我/给我/请你/请帮我/麻烦…画/绘/生成".
  // M2.5 fix: previously "帮我画一张机器人" was rejected because the regex
  // required "画" at start. We now allow up to ~10 chars of polite prefix.
  /(?:帮|替|给|请)(?:我|你|帮)?[\s\u4e00-\u9fff]{0,8}?(画|绘制|生成图)/,
  // Intent verbs anywhere ("生成一张图片"/"做一张海报"/"出一张图").
  /生成[一]?(?:张|幅|个)?(图片|图像|海报|插画|插图|封面|表情|图)/,
  /做(?:一张|个|张)?(?:图|海报|封面|插画)/,
  /出一张(?:图|海报|封面)/,
  /(?:画|绘制)一(?:张|幅)/,
];

const EN_IMPERATIVE_PATTERNS = [
  /^\s*draw\s+/i,
  /^\s*sketch\s+/i,
  /^\s*paint\s+/i,
  /^\s*render\s+/i,
  /^\s*plot\s+/i,
  /\bgenerate\s+(an?\s+)?(image|picture|photo|illustration|poster)\b/i,
  /\bcreate\s+(an?\s+)?(image|picture|illustration|poster|artwork)\b/i,
  /\bmake\s+(an?\s+)?(image|picture|illustration|poster)\b/i,
  /\bdraw\s+(me|us)?\s*(an?|the)?\s*\w+/i,
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
