/**
 * SiliconFlow provider adapter.
 *
 * SiliconFlow exposes OpenAI-compatible /chat/completions and /models, while
 * image generation uses /images/generations with `image_size` and usually
 * returns provider-hosted image URLs.
 */

import {
  DEFAULT_SILICONFLOW_BASE_URL,
  type DiscoveredModel,
  type ErrorClassification,
} from '@taori/shared';

export const SILICONFLOW_DEFAULT_BASE_URL = DEFAULT_SILICONFLOW_BASE_URL;

const REQUEST_TIMEOUT_MS = 10_000;

interface SiliconFlowTestResult {
  ok: boolean;
  sample_count?: number;
  classification?: ErrorClassification;
  message?: string;
}

interface SiliconFlowModelListItem {
  id: string;
  name?: string;
  object?: string;
  owned_by?: string;
  context_length?: number;
  max_context_length?: number;
  type?: string;
  task?: string;
  modality?: string;
  modalities?: string[];
  input_modalities?: string[];
  output_modalities?: string[];
  capabilities?: Record<string, unknown> | string[];
  supports_tools?: boolean;
  support_tools?: boolean;
  tool_calls?: boolean;
  function_call?: boolean;
  pricing?: { prompt?: string; completion?: string; image?: string };
}

const SILICONFLOW_FALLBACK_MODELS: DiscoveredModel[] = [
  {
    model_name: 'deepseek-ai/DeepSeek-V3',
    display_name: 'DeepSeek V3 · SiliconFlow',
    capability: 'chat',
    price_input_per_1m: null,
    price_output_per_1m: null,
    price_per_image: null,
    price_per_video_second: null,
    modalities: ['text'],
    context_length: null,
    supports_vision: false,
    supports_tools: true,
  },
  {
    model_name: 'Qwen/Qwen2.5-VL-72B-Instruct',
    display_name: 'Qwen2.5 VL 72B · SiliconFlow',
    capability: 'multimodal',
    price_input_per_1m: null,
    price_output_per_1m: null,
    price_per_image: null,
    price_per_video_second: null,
    modalities: ['text', 'image'],
    context_length: null,
    supports_vision: true,
    supports_tools: false,
  },
  {
    model_name: 'black-forest-labs/FLUX.1-schnell',
    display_name: 'FLUX.1 schnell · SiliconFlow',
    capability: 'image',
    price_input_per_1m: null,
    price_output_per_1m: null,
    price_per_image: null,
    price_per_video_second: null,
    pricing_meta: {
      version: 1,
      unit: 'image',
      tiers: [],
      notes: 'SiliconFlow image pricing varies by model; edit in Model Center if needed.',
      source_url: 'https://docs.siliconflow.cn/',
    },
    modalities: ['image'],
    context_length: null,
    supports_vision: false,
    supports_tools: false,
  },
];

async function timedFetch(url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function classifyStatus(status: number): SiliconFlowTestResult {
  if (status === 401 || status === 403) {
    return { ok: false, classification: 'auth', message: 'SiliconFlow API Key 无权限或无效' };
  }
  if (status === 402) {
    return { ok: false, classification: 'quota', message: 'SiliconFlow 余额或配额不足' };
  }
  if (status === 429) {
    return { ok: false, classification: 'rate_limit', message: 'SiliconFlow 限流' };
  }
  if (status >= 500) {
    return { ok: false, classification: 'network', message: `SiliconFlow 返回 ${status}` };
  }
  return { ok: false, classification: 'config_error', message: `SiliconFlow 返回 ${status}` };
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

function hasTruthyCapability(item: SiliconFlowModelListItem, names: string[]): boolean {
  const caps = item.capabilities;
  if (!caps || Array.isArray(caps)) return false;
  return names.some((name) => caps[name] === true);
}

function inferSiliconFlowModel(item: SiliconFlowModelListItem): DiscoveredModel {
  const id = item.id;
  const displayName = item.name ?? item.id;
  const capabilityText = [
    item.type,
    item.task,
    item.modality,
    item.object,
    displayName,
    id,
    ...(item.modalities ?? []),
    ...(item.input_modalities ?? []),
    ...(item.output_modalities ?? []),
    ...(Array.isArray(item.capabilities) ? item.capabilities.map(String) : []),
  ]
    .filter((v): v is string => typeof v === 'string')
    .join(' ')
    .toLowerCase();
  const inputModalities = [
    ...(item.input_modalities ?? []),
    ...(item.modalities ?? []),
  ].map((m) => m.toLowerCase());
  const outputModalities = (item.output_modalities ?? []).map((m) => m.toLowerCase());
  const isImage =
    outputModalities.includes('image') ||
    hasTruthyCapability(item, ['image_generation', 'image', 'images']) ||
    /\b(?:flux|kolors|sdxl|stable[-_ ]?diffusion|imagen|image[-_ ]?(?:generation|edit)|text[-_ ]?to[-_ ]?image|txt2img|t2i)\b/i.test(capabilityText);
  const isVideo =
    outputModalities.includes('video') ||
    /\b(?:video|text[-_ ]?to[-_ ]?video|image[-_ ]?to[-_ ]?video|t2v|i2v|wan)\b/i.test(capabilityText);
  const isEmbedding = /\b(?:embedding|embed|bge|gte)\b/i.test(capabilityText);
  const supportsVision =
    inputModalities.includes('image') ||
    /(?:vision|multimodal|vl|qwen2\.5-vl|qwen-vl|llava|internvl)\b/i.test(capabilityText);
  const capability: DiscoveredModel['capability'] = isVideo
    ? 'video'
    : isImage
      ? 'image'
      : isEmbedding
        ? 'embedding'
        : supportsVision
          ? 'multimodal'
          : 'chat';
  const modalities: DiscoveredModel['modalities'] =
    capability === 'video'
      ? inputModalities.includes('image')
        ? ['text', 'image', 'video']
        : ['text', 'video']
      : capability === 'image'
        ? inputModalities.includes('image') || /edit|i2i|image[-_ ]?edit/i.test(capabilityText)
          ? ['text', 'image']
          : ['image']
        : supportsVision
          ? ['text', 'image']
          : ['text'];
  const supportsTools =
    item.supports_tools === true ||
    item.support_tools === true ||
    item.tool_calls === true ||
    item.function_call === true ||
    hasTruthyCapability(item, ['tools', 'tool_calls', 'function_call']) ||
    /deepseek|qwen|glm|kimi|yi|internlm|llama|mistral/i.test(id);

  return {
    model_name: id,
    display_name: displayName,
    capability,
    price_input_per_1m: priceToPer1m(item.pricing?.prompt),
    price_output_per_1m: priceToPer1m(item.pricing?.completion),
    price_per_image: priceToUnit(item.pricing?.image),
    price_per_video_second: null,
    modalities,
    context_length: item.context_length ?? item.max_context_length ?? null,
    supports_vision: supportsVision,
    supports_tools: capability === 'chat' || capability === 'multimodal' ? supportsTools : false,
  };
}

export async function testSiliconFlow(
  baseUrl: string,
  apiKey: string,
): Promise<SiliconFlowTestResult> {
  const base = baseUrl.replace(/\/+$/, '');
  try {
    const res = await timedFetch(`${base}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (res.ok) {
      const body = (await res.json().catch(() => ({}))) as { data?: unknown[] };
      return { ok: true, sample_count: body.data?.length ?? 0 };
    }
    return classifyStatus(res.status);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, classification: 'network', message: `SiliconFlow 网络错误：${msg}` };
  }
}

export async function listSiliconFlowModels(
  baseUrl: string,
  apiKey: string,
): Promise<DiscoveredModel[]> {
  const base = baseUrl.replace(/\/+$/, '');
  const res = await timedFetch(`${base}/models`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    if (res.status === 404 || res.status === 405) return SILICONFLOW_FALLBACK_MODELS;
    const classified = classifyStatus(res.status);
    throw new Error(classified.message);
  }
  const body = (await res.json()) as { data?: SiliconFlowModelListItem[] };
  const models = (body.data ?? []).map(inferSiliconFlowModel);
  return models.length > 0 ? models : SILICONFLOW_FALLBACK_MODELS;
}
