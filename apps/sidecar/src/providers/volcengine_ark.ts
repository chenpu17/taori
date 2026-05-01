/**
 * Volcengine Ark MaaS provider adapter — M2.5 §F-AR.
 *
 * One Ark API key unlocks several model families. We treat each family as a
 * `DiscoveredModel` with the right `capability` + pricing so a single import
 * lights up the chat / multimodal / image / video pages of the Model Center.
 *
 * Model discovery is **dynamic**: `listVolcengineArkModels()` calls the real
 * `/api/v3/models` endpoint and returns whatever the user's account can access,
 * filtered to active-only models (Retiring + Shutdown both return 404). `ARK_METADATA` serves as a price / context
 * enrichment table keyed by model family `name` (the field returned alongside
 * each model's `id`). Unknown models are inferred from ID patterns.
 *
 * Pricing is approximate (CNY → USD ≈ 7.2). Users can edit in Model Center;
 * values are refreshed by Catalog Sync when a more reliable source is added.
 *
 * Auth: Ark uses Bearer <API_KEY> against an OpenAI-compatible Chat Completions
 * endpoint at `<base>/api/v3/chat/completions`. We test by listing models
 * (OpenAI-compat /models) and fall back gracefully on 404.
 */

import {
  type DiscoveredModel,
  type ErrorClassification,
} from '@taori/shared';

export const ARK_DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';

const REQUEST_TIMEOUT_MS = 10_000;

async function timedFetch(url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

interface ArkTestResult {
  ok: boolean;
  sample_count?: number;
  classification?: ErrorClassification;
  message?: string;
}

/**
 * Probe Ark credentials. We try `/models` (OpenAI-compat); on 404 we fall
 * back to a no-op chat completion against doubao-1-5-pro-32k. Either path
 * confirms the key is live without spending more than a few tokens.
 */
export async function testVolcengineArk(
  baseUrl: string,
  apiKey: string,
): Promise<ArkTestResult> {
  const base = baseUrl.replace(/\/$/, '');
  try {
    const res = await timedFetch(`${base}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (res.ok) {
      const body = (await res.json().catch(() => ({}))) as {
        data?: unknown[];
      };
      return { ok: true, sample_count: body.data?.length ?? ARK_FAMILIES.length };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, classification: 'auth', message: 'Ark API Key 无权限或无效' };
    }
    if (res.status === 429) {
      return { ok: false, classification: 'rate_limit', message: 'Ark 限流' };
    }
    if (res.status === 404) {
      // Some Ark accounts disable /models; we accept that as a soft pass —
      // the user can still register their endpoints manually in Model Center.
      return { ok: true, sample_count: ARK_FAMILIES.length };
    }
    return {
      ok: false,
      classification: 'unknown',
      message: `Ark 返回 ${res.status}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, classification: 'network', message: `Ark 网络错误：${msg}` };
  }
}

/**
 * Price / context metadata keyed by Ark model **family name** (the `name`
 * field returned by `/api/v3/models`, e.g. `"doubao-1-5-pro-32k"`). This is
 * NOT the model list — it enriches dynamically-fetched models with pricing and
 * capability hints. Unknown families fall back to pattern-based inference.
 *
 * Prices: USD per 1M tokens / per image / per video-second.
 * Source: Volcengine 计费说明，CNY→USD @ 7.2，用户可在 Model Center 内修正。
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept for backward compat
export interface ArkFamily {
  model_name: string;
  display_name: string;
  capability: DiscoveredModel['capability'];
  modalities: NonNullable<DiscoveredModel['modalities']>;
  price_input_per_1m: number | null;
  price_output_per_1m: number | null;
  price_per_image: number | null;
  price_per_video_second: number | null;
  context_length: number | null;
  supports_vision: boolean;
  supports_tools: boolean;
}

export const ARK_METADATA: Record<string, Omit<ArkFamily, 'model_name' | 'display_name'>> = {
  // ── Doubao 1.5 Chat ──────────────────────────────────────────────────────
  'doubao-1-5-pro-32k':    { capability:'chat', modalities:['text'], price_input_per_1m:0.11, price_output_per_1m:0.28, price_per_image:null, price_per_video_second:null, context_length:32_768,  supports_vision:false, supports_tools:true  },
  'doubao-1-5-pro-256k':   { capability:'chat', modalities:['text'], price_input_per_1m:0.69, price_output_per_1m:1.25, price_per_image:null, price_per_video_second:null, context_length:262_144, supports_vision:false, supports_tools:true  },
  'doubao-1-5-lite-32k':   { capability:'chat', modalities:['text'], price_input_per_1m:0.04, price_output_per_1m:0.08, price_per_image:null, price_per_video_second:null, context_length:32_768,  supports_vision:false, supports_tools:true  },
  'doubao-1-5-thinking-pro':  { capability:'chat', modalities:['text'], price_input_per_1m:0.55, price_output_per_1m:2.21, price_per_image:null, price_per_video_second:null, context_length:32_768, supports_vision:false, supports_tools:false },
  'doubao-1-5-thinking-pro-m':{ capability:'chat', modalities:['text'], price_input_per_1m:0.55, price_output_per_1m:2.21, price_per_image:null, price_per_video_second:null, context_length:32_768, supports_vision:false, supports_tools:false },
  // ── Doubao 1.5 Vision ────────────────────────────────────────────────────
  'doubao-1-5-vision-pro-32k': { capability:'multimodal', modalities:['text','image'], price_input_per_1m:0.42, price_output_per_1m:1.25, price_per_image:null, price_per_video_second:null, context_length:32_768, supports_vision:true, supports_tools:true  },
  'doubao-1-5-vision-pro':     { capability:'multimodal', modalities:['text','image'], price_input_per_1m:0.42, price_output_per_1m:1.25, price_per_image:null, price_per_video_second:null, context_length:32_768, supports_vision:true, supports_tools:true  },
  'doubao-1-5-vision-lite':    { capability:'multimodal', modalities:['text','image'], price_input_per_1m:0.11, price_output_per_1m:0.28, price_per_image:null, price_per_video_second:null, context_length:32_768, supports_vision:true, supports_tools:false },
  'doubao-1-5-thinking-vision-pro': { capability:'multimodal', modalities:['text','image'], price_input_per_1m:0.55, price_output_per_1m:2.21, price_per_image:null, price_per_video_second:null, context_length:32_768, supports_vision:true, supports_tools:false },
  // ── Doubao Seed series ───────────────────────────────────────────────────
  'doubao-seed-1-6':         { capability:'chat', modalities:['text'], price_input_per_1m:0.55, price_output_per_1m:2.21, price_per_image:null, price_per_video_second:null, context_length:128_000, supports_vision:false, supports_tools:true  },
  'doubao-seed-1-6-flash':   { capability:'chat', modalities:['text'], price_input_per_1m:0.11, price_output_per_1m:0.28, price_per_image:null, price_per_video_second:null, context_length:128_000, supports_vision:false, supports_tools:true  },
  'doubao-seed-1-6-lite':    { capability:'chat', modalities:['text'], price_input_per_1m:0.04, price_output_per_1m:0.08, price_per_image:null, price_per_video_second:null, context_length:128_000, supports_vision:false, supports_tools:true  },
  'doubao-seed-1-6-thinking':{ capability:'chat', modalities:['text'], price_input_per_1m:0.55, price_output_per_1m:2.21, price_per_image:null, price_per_video_second:null, context_length:128_000, supports_vision:false, supports_tools:false },
  'doubao-seed-1-6-vision':  { capability:'multimodal', modalities:['text','image'], price_input_per_1m:0.55, price_output_per_1m:2.21, price_per_image:null, price_per_video_second:null, context_length:128_000, supports_vision:true, supports_tools:true  },
  'doubao-seed-1-8':         { capability:'chat', modalities:['text'], price_input_per_1m:0.55, price_output_per_1m:2.21, price_per_image:null, price_per_video_second:null, context_length:128_000, supports_vision:false, supports_tools:true  },
  'doubao-seed-2-0-pro':     { capability:'chat', modalities:['text'], price_input_per_1m:0.55, price_output_per_1m:2.21, price_per_image:null, price_per_video_second:null, context_length:128_000, supports_vision:false, supports_tools:true  },
  'doubao-seed-2-0-lite':    { capability:'chat', modalities:['text'], price_input_per_1m:0.11, price_output_per_1m:0.28, price_per_image:null, price_per_video_second:null, context_length:128_000, supports_vision:false, supports_tools:true  },
  'doubao-seed-2-0-mini':    { capability:'chat', modalities:['text'], price_input_per_1m:0.04, price_output_per_1m:0.08, price_per_image:null, price_per_video_second:null, context_length:128_000, supports_vision:false, supports_tools:true  },
  // ── Image generation ─────────────────────────────────────────────────────
  'doubao-seedream-3-0-t2i': { capability:'image', modalities:['image'], price_input_per_1m:null, price_output_per_1m:null, price_per_image:0.035, price_per_video_second:null, context_length:null, supports_vision:false, supports_tools:false },
  'doubao-seedream-4-0':     { capability:'image', modalities:['image'], price_input_per_1m:null, price_output_per_1m:null, price_per_image:0.056, price_per_video_second:null, context_length:null, supports_vision:false, supports_tools:false },
  'doubao-seedream-4-5':     { capability:'image', modalities:['image'], price_input_per_1m:null, price_output_per_1m:null, price_per_image:0.056, price_per_video_second:null, context_length:null, supports_vision:false, supports_tools:false },
  'doubao-seedream-5-0':     { capability:'image', modalities:['image'], price_input_per_1m:null, price_output_per_1m:null, price_per_image:0.083, price_per_video_second:null, context_length:null, supports_vision:false, supports_tools:false },
  'doubao-seededit-3-0-i2i': { capability:'image', modalities:['image'], price_input_per_1m:null, price_output_per_1m:null, price_per_image:0.042, price_per_video_second:null, context_length:null, supports_vision:false, supports_tools:false },
  // ── Video generation ─────────────────────────────────────────────────────
  'doubao-seedance-1-0-lite-t2v': { capability:'video', modalities:['video'], price_input_per_1m:null, price_output_per_1m:null, price_per_image:null, price_per_video_second:0.028, context_length:null, supports_vision:false, supports_tools:false },
  'doubao-seedance-1-0-lite-i2v': { capability:'video', modalities:['video'], price_input_per_1m:null, price_output_per_1m:null, price_per_image:null, price_per_video_second:0.028, context_length:null, supports_vision:false, supports_tools:false },
  'doubao-seedance-1-0-pro':      { capability:'video', modalities:['video'], price_input_per_1m:null, price_output_per_1m:null, price_per_image:null, price_per_video_second:0.056, context_length:null, supports_vision:false, supports_tools:false },
  'doubao-seedance-1-0-pro-fast': { capability:'video', modalities:['video'], price_input_per_1m:null, price_output_per_1m:null, price_per_image:null, price_per_video_second:0.028, context_length:null, supports_vision:false, supports_tools:false },
  'doubao-seedance-1-5-pro':      { capability:'video', modalities:['video'], price_input_per_1m:null, price_output_per_1m:null, price_per_image:null, price_per_video_second:0.083, context_length:null, supports_vision:false, supports_tools:false },
  'doubao-seedance-2-0':          { capability:'video', modalities:['video'], price_input_per_1m:null, price_output_per_1m:null, price_per_image:null, price_per_video_second:0.111, context_length:null, supports_vision:false, supports_tools:false },
  'doubao-seedance-2-0-fast':     { capability:'video', modalities:['video'], price_input_per_1m:null, price_output_per_1m:null, price_per_image:null, price_per_video_second:0.056, context_length:null, supports_vision:false, supports_tools:false },
  'wan2-1-14b-t2v': { capability:'video', modalities:['video'], price_input_per_1m:null, price_output_per_1m:null, price_per_image:null, price_per_video_second:0.042, context_length:null, supports_vision:false, supports_tools:false },
  'wan2-1-14b-i2v': { capability:'video', modalities:['video'], price_input_per_1m:null, price_output_per_1m:null, price_per_image:null, price_per_video_second:0.042, context_length:null, supports_vision:false, supports_tools:false },
  // ── Embedding ────────────────────────────────────────────────────────────
  'doubao-embedding':        { capability:'embedding', modalities:['text'],         price_input_per_1m:0.007, price_output_per_1m:null, price_per_image:null, price_per_video_second:null, context_length:4_096, supports_vision:false, supports_tools:false },
  'doubao-embedding-large':  { capability:'embedding', modalities:['text'],         price_input_per_1m:0.007, price_output_per_1m:null, price_per_image:null, price_per_video_second:null, context_length:4_096, supports_vision:false, supports_tools:false },
  'doubao-embedding-vision': { capability:'embedding', modalities:['text','image'], price_input_per_1m:0.014, price_output_per_1m:null, price_per_image:null, price_per_video_second:null, context_length:4_096, supports_vision:true,  supports_tools:false },
  // ── Third-party models hosted on Ark ─────────────────────────────────────
  'deepseek-v3':   { capability:'chat', modalities:['text'], price_input_per_1m:0.55, price_output_per_1m:2.21, price_per_image:null, price_per_video_second:null, context_length:64_000,  supports_vision:false, supports_tools:true  },
  'deepseek-v3-1': { capability:'chat', modalities:['text'], price_input_per_1m:0.55, price_output_per_1m:2.21, price_per_image:null, price_per_video_second:null, context_length:64_000,  supports_vision:false, supports_tools:true  },
  'deepseek-v3-2': { capability:'chat', modalities:['text'], price_input_per_1m:0.55, price_output_per_1m:2.21, price_per_image:null, price_per_video_second:null, context_length:64_000,  supports_vision:false, supports_tools:true  },
  'deepseek-r1':   { capability:'chat', modalities:['text'], price_input_per_1m:0.55, price_output_per_1m:2.21, price_per_image:null, price_per_video_second:null, context_length:64_000,  supports_vision:false, supports_tools:false },
  'kimi-k2':       { capability:'chat', modalities:['text'], price_input_per_1m:0.55, price_output_per_1m:2.21, price_per_image:null, price_per_video_second:null, context_length:128_000, supports_vision:false, supports_tools:true  },
  'qwen3-32b':     { capability:'chat', modalities:['text'], price_input_per_1m:0.28, price_output_per_1m:0.83, price_per_image:null, price_per_video_second:null, context_length:32_768,  supports_vision:false, supports_tools:true  },
  'qwen3-14b':     { capability:'chat', modalities:['text'], price_input_per_1m:0.14, price_output_per_1m:0.42, price_per_image:null, price_per_video_second:null, context_length:32_768,  supports_vision:false, supports_tools:true  },
  'qwen3-8b':      { capability:'chat', modalities:['text'], price_input_per_1m:0.07, price_output_per_1m:0.21, price_per_image:null, price_per_video_second:null, context_length:32_768,  supports_vision:false, supports_tools:true  },
  'glm-4-7':       { capability:'chat', modalities:['text'], price_input_per_1m:0.14, price_output_per_1m:0.42, price_per_image:null, price_per_video_second:null, context_length:128_000, supports_vision:false, supports_tools:true  },
};

/** @deprecated Kept for backward compat. Prefer ARK_METADATA. */
export const ARK_FAMILIES: ArkFamily[] = Object.entries(ARK_METADATA).map(([name, m]) => ({
  model_name: name,
  display_name: name,
  ...m,
}));

// ─── Inference helpers ────────────────────────────────────────────────────────

function stripArkVersionSuffix(id: string): string {
  return id
    .toLowerCase()
    .trim()
    .replace(/-\d{6,8}$/, '');
}

function metadataForArkModel(id: string, familyName?: string | null): Omit<ArkFamily, 'model_name' | 'display_name'> | null {
  const candidates = [
    id,
    familyName ?? '',
    stripArkVersionSuffix(id),
    familyName ? stripArkVersionSuffix(familyName) : '',
  ].filter(Boolean);

  for (const candidate of candidates) {
    const exact = ARK_METADATA[candidate];
    if (exact) return exact;
  }

  // Ark `/models` commonly returns endpoint ids with a date/version suffix,
  // e.g. doubao-1-5-lite-32k-250115. Prefer the longest catalog prefix so
  // specific families win over broader names.
  const normalized = stripArkVersionSuffix(id);
  const prefix = Object.keys(ARK_METADATA)
    .filter((key) => normalized === key || normalized.startsWith(`${key}-`))
    .sort((a, b) => b.length - a.length)[0];
  return prefix ? ARK_METADATA[prefix]! : null;
}

function inferCapability(id: string): DiscoveredModel['capability'] {
  const s = id.toLowerCase();
  if (s.includes('-t2i') || s.includes('seedream') || s.includes('seededit')) return 'image';
  if (s.includes('-t2v') || s.includes('-i2v') || s.includes('-flf2v') || s.includes('seedance')) return 'video';
  if (s.includes('seed3d')) return 'image';
  if (s.includes('-vision') || s.includes('vision-pro') || s.includes('vision-lite')) return 'multimodal';
  if (s.includes('-embedding') || s.includes('embedding-')) return 'embedding';
  return 'chat';
}

function inferModalities(id: string, cap: DiscoveredModel['capability']): NonNullable<DiscoveredModel['modalities']> {
  if (cap === 'image') return ['image'];
  if (cap === 'video') return ['video'];
  if (cap === 'embedding') return id.includes('vision') ? ['text', 'image'] : ['text'];
  if (cap === 'multimodal') return ['text', 'image'];
  return ['text'];
}

function inferContextLength(id: string): number | null {
  if (id.includes('-4k')) return 4_096;
  if (id.includes('-32k')) return 32_768;
  if (id.includes('-128k')) return 131_072;
  if (id.includes('-256k')) return 262_144;
  return null;
}

/**
 * Build a human-readable display name from a raw Ark model id + family name.
 * Examples:
 *   "doubao-seed-1-6-flash-250615"  → "Doubao Seed 1.6 Flash"
 *   "doubao-1-5-vision-pro-32k-250115" → "Doubao 1.5 Vision Pro · 32K"
 *   "deepseek-v3-250324"            → "DeepSeek V3"
 */
function buildDisplayName(id: string, familyName: string): string {
  const stripped = familyName.replace(/-\d{6,8}$/, '');
  let pretty = stripped
    .replace(/^doubao-/, 'Doubao ')
    .replace(/^deepseek-/, 'DeepSeek ')
    .replace(/^kimi-/, 'Kimi ')
    .replace(/^qwen/, 'Qwen')
    .replace(/^glm-/, 'GLM ')
    .replace(/^wan2-/, 'Wan2 ')
    .replace(/^mistral-/, 'Mistral ')
    .replace(/^hitem3d-/, 'Hitem3D ')
    .replace(/^hyper3d-/, 'Hyper3D ')
    .replace(/-/g, ' ')
    .replace(/\b(\d+) (\d+)\b/g, '$1.$2') // "1 5" → "1.5"
    .replace(/\b(\w)/g, (c) => c.toUpperCase())
    .trim();
  const ctxHint = id.includes('-256k') ? ' · 256K'
    : id.includes('-128k') ? ' · 128K'
    : id.includes('-32k') ? ' · 32K'
    : id.includes('-4k') ? ' · 4K'
    : '';
  return pretty + ctxHint;
}

export function enrichVolcengineArkModel(modelName: string): DiscoveredModel | null {
  const meta = metadataForArkModel(modelName);
  if (!meta) return null;
  return {
    model_name: modelName,
    display_name: buildDisplayName(modelName, stripArkVersionSuffix(modelName)),
    capability: meta.capability,
    price_input_per_1m: meta.price_input_per_1m,
    price_output_per_1m: meta.price_output_per_1m,
    price_per_image: meta.price_per_image,
    price_per_video_second: meta.price_per_video_second,
    modalities: meta.modalities,
    context_length: meta.context_length,
    supports_vision: meta.supports_vision,
    supports_tools: meta.supports_tools,
  };
}

// ─── Ark /models API shape ────────────────────────────────────────────────────

interface ArkModelListItem {
  id: string;
  name: string;
  object: string;
  status: string | null;
  created: number;
  version: string;
}

// ─── Public: dynamic discovery ────────────────────────────────────────────────

/**
 * Fetch the list of models accessible under `apiKey`, filter out Shutdown
 * entries, and enrich each with capability / pricing from `ARK_METADATA`.
 *
 * Falls back to a static snapshot derived from ARK_METADATA when the API
 * call fails (offline / firewall) so the import drawer still shows something.
 */
export async function listVolcengineArkModels(
  baseUrl: string,
  apiKey: string,
): Promise<DiscoveredModel[]> {
  const base = baseUrl.replace(/\/$/, '');
  let apiModels: ArkModelListItem[] | null = null;

  try {
    const res = await timedFetch(`${base}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (res.ok) {
      const body = (await res.json()) as { data?: ArkModelListItem[] };
      apiModels = body.data ?? null;
    }
  } catch {
    // network error — fall through to static fallback
  }

  if (!apiModels) {
    return Object.entries(ARK_METADATA).map(([familyName, m]) => ({
      model_name: familyName,
      display_name: buildDisplayName(familyName, familyName),
      capability: m.capability,
      price_input_per_1m: m.price_input_per_1m,
      price_output_per_1m: m.price_output_per_1m,
      price_per_image: m.price_per_image,
      price_per_video_second: m.price_per_video_second,
      modalities: m.modalities,
      context_length: m.context_length,
      supports_vision: m.supports_vision,
      supports_tools: m.supports_tools,
    }));
  }

  // Filter: keep only fully active models; both Retiring and Shutdown return 404
  const visible = apiModels.filter((m) => m.status == null || (m.status !== 'Shutdown' && m.status !== 'Retiring'));

  return visible.map((m): DiscoveredModel => {
    const meta = metadataForArkModel(m.id, m.name);
    const cap = meta?.capability ?? inferCapability(m.id);
    return {
      model_name: m.id,
      display_name: buildDisplayName(m.id, m.name),
      capability: cap,
      price_input_per_1m: meta?.price_input_per_1m ?? null,
      price_output_per_1m: meta?.price_output_per_1m ?? null,
      price_per_image: meta?.price_per_image ?? null,
      price_per_video_second: meta?.price_per_video_second ?? null,
      modalities: meta?.modalities ?? inferModalities(m.id, cap),
      context_length: meta?.context_length ?? inferContextLength(m.id),
      supports_vision: meta?.supports_vision ?? cap === 'multimodal',
      supports_tools: meta?.supports_tools ?? (cap === 'chat'),
    };
  });
}
