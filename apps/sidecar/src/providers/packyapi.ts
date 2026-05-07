/**
 * PackyAPI / PackyCode provider adapter.
 *
 * PackyAPI exposes an OpenAI-compatible image generation endpoint. Discovery
 * prefers /models when available, but always surfaces gpt-image-2 because some
 * accounts only document the image endpoint and do not return it from /models.
 */

import {
  DEFAULT_PACKYAPI_BASE_URL,
  type DiscoveredModel,
  type ErrorClassification,
} from '@taori/shared';

export const PACKYAPI_DEFAULT_BASE_URL = DEFAULT_PACKYAPI_BASE_URL;

const REQUEST_TIMEOUT_MS = 10_000;
const GPT_IMAGE_2_MODEL: DiscoveredModel = {
  model_name: 'gpt-image-2',
  display_name: 'GPT Image 2',
  capability: 'image',
  price_input_per_1m: null,
  price_output_per_1m: null,
  price_per_image: null,
  price_per_video_second: null,
  pricing_meta: {
    version: 1,
    unit: 'image',
    tiers: [],
    notes: 'PackyAPI gpt-image-2 pricing is account/provider managed; edit in Model Center if needed.',
    source_url: 'https://www.packyapi.com/',
  },
  modalities: ['image'],
  context_length: null,
  supports_vision: false,
  supports_tools: false,
};

interface PackyModelListItem {
  id: string;
  name?: string;
  object?: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string; image?: string };
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
  input_modalities?: string[];
  output_modalities?: string[];
  modalities?: string[];
  capability?: string;
  capabilities?: Record<string, unknown>;
}

interface PackyTestResult {
  ok: boolean;
  sample_count?: number;
  classification?: ErrorClassification;
  message?: string;
}

async function timedFetch(url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function classifyPackyStatus(status: number): PackyTestResult {
  if (status === 401 || status === 403) {
    return {
      ok: false,
      classification: 'auth',
      message: 'PackyAPI Key 无权限、无效，或未开通 gpt-image-2 所需分组',
    };
  }
  if (status === 402) {
    return { ok: false, classification: 'quota', message: 'PackyAPI 余额或配额不足' };
  }
  if (status === 429) {
    return { ok: false, classification: 'rate_limit', message: 'PackyAPI 限流' };
  }
  if (status >= 500) {
    return { ok: false, classification: 'network', message: `PackyAPI 返回 ${status}` };
  }
  return { ok: false, classification: 'config_error', message: `PackyAPI 返回 ${status}` };
}

function priceToPer1m(raw: string | undefined): number | null {
  if (raw == null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return n * 1_000_000;
}

function priceToUnit(raw: string | undefined): number | null {
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function hasTruthyCapability(item: PackyModelListItem, names: string[]): boolean {
  const caps = item.capabilities;
  if (!caps) return false;
  return names.some((name) => caps[name] === true);
}

function inferPackyModel(item: PackyModelListItem): DiscoveredModel {
  const id = item.id;
  const displayName = item.name ?? item.id;
  const metadata = `${id} ${displayName} ${item.capability ?? ''}`.toLowerCase();
  const inputModalities = [
    ...(item.input_modalities ?? []),
    ...(item.architecture?.input_modalities ?? []),
    ...(item.modalities ?? []),
  ].map((m) => m.toLowerCase());
  const outputModalities = [
    ...(item.output_modalities ?? []),
    ...(item.architecture?.output_modalities ?? []),
  ].map((m) => m.toLowerCase());
  const isImage =
    item.capability?.toLowerCase() === 'image' ||
    outputModalities.includes('image') ||
    hasTruthyCapability(item, ['image_generation', 'image', 'images']) ||
    /\b(?:gpt-image|dall[-_ ]?e|imagen|flux|sdxl|stable[-_ ]?diffusion|image[-_ ]?(?:generation|edit)|text[-_ ]?to[-_ ]?image|txt2img|t2i)\b/i.test(metadata);
  const supportsVision =
    inputModalities.includes('image') ||
    /(?:vision|multimodal|gpt-4o|gpt-4\.1|omni|vl)\b/i.test(metadata);
  const capability: DiscoveredModel['capability'] = isImage
    ? 'image'
    : supportsVision
      ? 'multimodal'
      : 'chat';
  return {
    model_name: id,
    display_name: displayName,
    capability,
    price_input_per_1m: priceToPer1m(item.pricing?.prompt),
    price_output_per_1m: priceToPer1m(item.pricing?.completion),
    price_per_image: priceToUnit(item.pricing?.image),
    price_per_video_second: null,
    pricing_meta: id === 'gpt-image-2' ? GPT_IMAGE_2_MODEL.pricing_meta : null,
    modalities: capability === 'image'
      ? inputModalities.includes('image')
        ? ['text', 'image']
        : ['image']
      : supportsVision
        ? ['text', 'image']
        : ['text'],
    context_length: item.context_length ?? null,
    supports_vision: supportsVision,
    supports_tools: capability === 'chat' || capability === 'multimodal',
  };
}

function withGptImage2(models: DiscoveredModel[]): DiscoveredModel[] {
  const withoutDuplicate = models.filter((model) => model.model_name !== GPT_IMAGE_2_MODEL.model_name);
  return [GPT_IMAGE_2_MODEL, ...withoutDuplicate];
}

export async function testPackyApi(
  baseUrl: string,
  apiKey: string,
): Promise<PackyTestResult> {
  const base = baseUrl.replace(/\/+$/, '');
  try {
    const res = await timedFetch(`${base}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (res.ok) {
      const body = (await res.json().catch(() => ({}))) as { data?: unknown[] };
      return { ok: true, sample_count: Math.max(1, body.data?.length ?? 0) };
    }
    // Some PackyAPI image-only accounts may not expose a model list. Accept
    // that as a soft pass so onboarding can still import the documented model.
    if (res.status === 404 || res.status === 405) {
      return { ok: true, sample_count: 1 };
    }
    return classifyPackyStatus(res.status);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, classification: 'network', message: `PackyAPI 网络错误：${msg}` };
  }
}

export async function listPackyApiModels(
  baseUrl: string,
  apiKey: string,
): Promise<DiscoveredModel[]> {
  const base = baseUrl.replace(/\/+$/, '');
  const res = await timedFetch(`${base}/models`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (res.status === 404 || res.status === 405) return withGptImage2([]);
  if (!res.ok) {
    const classified = classifyPackyStatus(res.status);
    throw new Error(classified.message);
  }
  const body = (await res.json()) as { data?: PackyModelListItem[] };
  return withGptImage2((body.data ?? []).map(inferPackyModel));
}
