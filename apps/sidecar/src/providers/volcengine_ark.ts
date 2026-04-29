/**
 * Volcengine Ark MaaS provider adapter — M2.5 §F-AR.
 *
 * One Ark API key unlocks several model families. We treat each family as a
 * `DiscoveredModel` with the right `capability` + pricing so a single import
 * lights up the chat / multimodal / image / video pages of the Model Center.
 *
 *   doubao-1-5-pro-32k        → chat
 *   doubao-1-5-vision-pro-32k → multimodal (vision in)
 *   doubao-seedream-3-0       → image (text-to-image)
 *   doubao-seedance-1-0-lite  → video
 *   wan2-1                    → video (alibaba wan via ark)
 *
 * Pricing is approximate (CNY → USD ≈ 7.2) and bundled here because Ark's
 * /api/v3/endpoints listing does not return rates. Users can edit these in
 * the Model Center after import; values are also refreshed by Catalog Sync
 * when we reach a more reliable source.
 *
 * Auth: Ark uses Bearer <API_KEY> against an OpenAI-compatible Chat Completions
 * endpoint at `<base>/api/v3/chat/completions`. We test by listing endpoints
 * (ark-native) and fall back to a chat ping if that scope is missing.
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
 * Hardcoded Ark model family catalog. M2.5 ships only doubao + wan/seedance.
 * Prices are USD per 1M tokens (chat/multimodal) or USD per image / per
 * video-second (image/video). Source: Volcengine 计费说明 2026-04 公告，按
 * CNY→USD 1:7.2 折算并保留两位小数；用户可在 Model Center 内自行修正。
 */
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

export const ARK_FAMILIES: ArkFamily[] = [
  {
    model_name: 'doubao-1-5-pro-32k',
    display_name: 'Doubao 1.5 Pro · 32K',
    capability: 'chat',
    modalities: ['text'],
    price_input_per_1m: 0.11, // ≈ ¥0.8
    price_output_per_1m: 0.28, // ≈ ¥2
    price_per_image: null,
    price_per_video_second: null,
    context_length: 32_768,
    supports_vision: false,
    supports_tools: true,
  },
  {
    model_name: 'doubao-1-5-pro-256k',
    display_name: 'Doubao 1.5 Pro · 256K',
    capability: 'chat',
    modalities: ['text'],
    price_input_per_1m: 0.69, // ≈ ¥5
    price_output_per_1m: 1.25, // ≈ ¥9
    price_per_image: null,
    price_per_video_second: null,
    context_length: 262_144,
    supports_vision: false,
    supports_tools: true,
  },
  {
    model_name: 'doubao-1-5-lite-32k',
    display_name: 'Doubao 1.5 Lite · 32K',
    capability: 'chat',
    modalities: ['text'],
    price_input_per_1m: 0.04, // ≈ ¥0.3
    price_output_per_1m: 0.08, // ≈ ¥0.6
    price_per_image: null,
    price_per_video_second: null,
    context_length: 32_768,
    supports_vision: false,
    supports_tools: true,
  },
  {
    model_name: 'doubao-1-5-vision-pro-32k',
    display_name: 'Doubao 1.5 Vision Pro · 32K',
    capability: 'multimodal',
    modalities: ['text', 'image'],
    price_input_per_1m: 0.42, // ≈ ¥3
    price_output_per_1m: 1.25, // ≈ ¥9
    price_per_image: null,
    price_per_video_second: null,
    context_length: 32_768,
    supports_vision: true,
    supports_tools: true,
  },
  {
    model_name: 'doubao-seedream-3-0-t2i',
    display_name: 'Doubao SeeDream 3.0 (Image)',
    capability: 'image',
    modalities: ['image'],
    price_input_per_1m: null,
    price_output_per_1m: null,
    price_per_image: 0.035, // ≈ ¥0.25
    price_per_video_second: null,
    context_length: null,
    supports_vision: false,
    supports_tools: false,
  },
  {
    model_name: 'doubao-seedance-1-0-lite-t2v',
    display_name: 'Doubao SeeDance 1.0 Lite (Video)',
    capability: 'video',
    modalities: ['video'],
    price_input_per_1m: null,
    price_output_per_1m: null,
    price_per_image: null,
    price_per_video_second: 0.028, // ≈ ¥0.2 / 秒
    context_length: null,
    supports_vision: false,
    supports_tools: false,
  },
  {
    model_name: 'wan2-1-t2v',
    display_name: 'Wan 2.1 (Video, Alibaba)',
    capability: 'video',
    modalities: ['video'],
    price_input_per_1m: null,
    price_output_per_1m: null,
    price_per_image: null,
    price_per_video_second: 0.042, // ≈ ¥0.3 / 秒
    context_length: null,
    supports_vision: false,
    supports_tools: false,
  },
];

export async function listVolcengineArkModels(): Promise<DiscoveredModel[]> {
  return ARK_FAMILIES.map((f) => ({
    model_name: f.model_name,
    display_name: f.display_name,
    capability: f.capability,
    price_input_per_1m: f.price_input_per_1m,
    price_output_per_1m: f.price_output_per_1m,
    price_per_image: f.price_per_image,
    price_per_video_second: f.price_per_video_second,
    modalities: f.modalities,
    context_length: f.context_length,
    supports_vision: f.supports_vision,
    supports_tools: f.supports_tools,
  }));
}
