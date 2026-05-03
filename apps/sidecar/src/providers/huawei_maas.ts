/**
 * Huawei Cloud ModelArts MaaS provider adapter.
 *
 * Huawei exposes an OpenAI-compatible chat endpoint at /openai/v1 and a MaaS
 * model-list endpoint. We discover models dynamically from those endpoints;
 * capability flags are inferred from returned metadata and model-id patterns.
 */

import {
  type DiscoveredModel,
  type ErrorClassification,
} from '@taori/shared';

export const HUAWEI_MAAS_DEFAULT_BASE_URL =
  'https://api.modelarts-maas.com/openai/v1';

const REQUEST_TIMEOUT_MS = 10_000;
const HUAWEI_KNOWN_TOOL_CHAT_MODELS = [
  /^deepseek[-_]v3(?:[._-]\d+)?$/,
];

interface HuaweiTestResult {
  ok: boolean;
  sample_count?: number;
  classification?: ErrorClassification;
  message?: string;
}

interface HuaweiModelListItem {
  id: string;
  name?: string;
  object?: string;
  display_name?: string;
  capability?: string;
  type?: string;
  task?: string;
  owned_by?: string;
  modalities?: string[];
  input_modalities?: string[];
  output_modalities?: string[];
  capabilities?: Record<string, unknown> | string[] | null;
  supports_tools?: boolean;
  tool_calls?: boolean;
  function_call?: boolean;
  context_length?: number;
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

function classifyHttpStatus(status: number): HuaweiTestResult {
  if (status === 401 || status === 403) {
    return {
      ok: false,
      classification: 'auth',
      message: 'Huawei MaaS API Key 无权限或无效',
    };
  }
  if (status === 429) {
    return { ok: false, classification: 'rate_limit', message: 'Huawei MaaS 限流' };
  }
  if (status === 402) {
    return { ok: false, classification: 'quota', message: 'Huawei MaaS 余额或配额不足' };
  }
  if (status >= 500) {
    return { ok: false, classification: 'network', message: `Huawei MaaS 返回 ${status}` };
  }
  return {
    ok: false,
    classification: 'config_error',
    message: `Huawei MaaS 返回 ${status}`,
  };
}

function inferHuaweiModel(item: HuaweiModelListItem): DiscoveredModel {
  const id = item.id.toLowerCase();
  const metadata = [
    item.capability,
    item.type,
    item.task,
    item.object,
    item.name,
    item.display_name,
    item.id,
    ...(item.modalities ?? []),
    ...(item.input_modalities ?? []),
    ...(item.output_modalities ?? []),
    ...(Array.isArray(item.capabilities) ? item.capabilities.map(String) : []),
  ]
    .filter((v): v is string => typeof v === 'string')
    .join(' ')
    .toLowerCase();
  const capObj = item.capabilities && !Array.isArray(item.capabilities)
    ? item.capabilities
    : {};
  const allModalities = [
    ...(item.modalities ?? []),
    ...(item.input_modalities ?? []),
    ...(item.output_modalities ?? []),
  ].map((m) => m.toLowerCase());
  const outputModalities = (item.output_modalities ?? []).map((m) => m.toLowerCase());
  const isVision =
    allModalities.includes('image') ||
    /(?:^|[-_])vl(?:[-_]|$)|vision|multimodal|image[-_ ]?understanding/.test(metadata);
  const hasImageGenerationHint =
    /image[-_ ]?(generation|edit)|text[-_ ]?to[-_ ]?image|txt2img|(?:^|[-_\s])t2i(?:[-_\s]|$)|wanx/.test(metadata) ||
    (/(?:^|[-_\s])image(?:[-_\s]|$)/.test(metadata) &&
      !/image[-_ ]?understanding|vision|multimodal|(?:^|[-_])vl(?:[-_]|$)/.test(metadata));
  const isImage = outputModalities.includes('image') || hasImageGenerationHint;
  const isVideo = /video|text[-_ ]?to[-_ ]?video|image[-_ ]?to[-_ ]?video|(?:^|[-_])(?:t2v|i2v)(?:[-_]|$)|wan\d/.test(metadata);
  const explicitCapability = typeof item.capability === 'string' ? item.capability.toLowerCase() : '';
  const capability: DiscoveredModel['capability'] = explicitCapability.includes('video') || isVideo
    ? 'video'
    : explicitCapability.includes('image') || isImage
      ? 'image'
      : explicitCapability.includes('multimodal') || isVision
        ? 'multimodal'
        : 'chat';
  const modalities =
    capability === 'video'
      ? /i2v|image[-_ ]?to[-_ ]?video/.test(metadata)
        ? ['text', 'image', 'video'] as const
        : ['text', 'video'] as const
      : capability === 'image'
        ? /edit|i2i|image[-_ ]?edit/.test(metadata)
          ? ['text', 'image'] as const
          : ['image'] as const
        : isVision
          ? ['text', 'image'] as const
          : ['text'] as const;
  const toolsFromMetadata =
    item.supports_tools === true ||
    item.tool_calls === true ||
    item.function_call === true ||
    capObj.tools === true ||
    capObj.tool_calls === true ||
    capObj.function_call === true ||
    (Array.isArray(item.capabilities) &&
      item.capabilities.map(String).some((c) => /tool|function/.test(c.toLowerCase())));
  const toolsFromKnownModel =
    capability === 'chat' && HUAWEI_KNOWN_TOOL_CHAT_MODELS.some((re) => re.test(id));
  return {
    model_name: item.id,
    display_name: item.display_name ?? item.name ?? item.id,
    capability,
    price_input_per_1m: null,
    price_output_per_1m: null,
    price_per_image: null,
    price_per_video_second: null,
    modalities: [...modalities],
    context_length: typeof item.context_length === 'number' ? item.context_length : null,
    supports_vision: isVision,
    // Huawei's model-list response may not expose tool-call capability. Keep
    // unknown models conservative: if we optimistically send OpenAI `tools`
    // to an endpoint that does not support them, user web-search/image turns
    // fail with a provider 400 before the model can answer. Users can still
    // enable Tools manually in Model Center once a specific MaaS model is
    // known to support function calling.
    supports_tools: toolsFromMetadata || toolsFromKnownModel,
  };
}

function huaweiModelListUrls(baseUrl: string): string[] {
  const normalized = baseUrl.replace(/\/+$/, '');
  const urls = [`${normalized}/models`];
  const withoutOpenAiPrefix = normalized.replace(/\/openai\/v1$/i, '');
  if (withoutOpenAiPrefix !== normalized) {
    urls.push(`${withoutOpenAiPrefix}/v2/models`);
    urls.push(`${withoutOpenAiPrefix}/v1/models`);
  }
  const v1AsV2 = normalized.replace(/\/v1$/i, '/v2');
  if (v1AsV2 !== normalized) {
    urls.push(`${v1AsV2}/models`);
  }
  return [...new Set(urls)];
}

async function fetchHuaweiModels(baseUrl: string, apiKey: string): Promise<Response> {
  let softMiss: Response | null = null;
  for (const url of huaweiModelListUrls(baseUrl)) {
    const res = await timedFetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (res.ok || res.status === 401 || res.status === 403) return res;
    if (res.status === 404 || res.status === 405) {
      softMiss = res;
      continue;
    }
    return res;
  }
  return softMiss ?? timedFetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
  });
}

export async function testHuaweiMaas(
  baseUrl: string,
  apiKey: string,
): Promise<HuaweiTestResult> {
  try {
    const res = await fetchHuaweiModels(baseUrl, apiKey);
    if (res.ok) {
      const body = (await res.json().catch(() => ({}))) as {
        data?: unknown[];
      };
      return { ok: true, sample_count: body.data?.length ?? 0 };
    }
    if (res.status === 404 || res.status === 405) {
      return {
        ok: false,
        classification: 'config_error',
        message: 'Huawei MaaS 模型列表接口不可用；请确认 Base URL 或服务版本支持 /models',
      };
    }
    return classifyHttpStatus(res.status);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      classification: 'network',
      message: `Huawei MaaS 网络错误：${msg}`,
    };
  }
}

export async function listHuaweiMaasModels(
  baseUrl: string,
  apiKey: string,
): Promise<DiscoveredModel[]> {
  try {
    const res = await fetchHuaweiModels(baseUrl, apiKey);
    if (res.ok) {
      const body = (await res.json().catch(() => ({}))) as {
        data?: HuaweiModelListItem[];
      };
      const discovered = (body.data ?? []).map(inferHuaweiModel);
      if (discovered.length === 0) {
        throw new Error('Huawei MaaS 模型列表为空，未导入任何模型');
      }
      return discovered;
    }
    if (res.status === 404 || res.status === 405) {
      throw new Error('Huawei MaaS 模型列表接口不可用；请确认 Base URL 或服务版本支持 /models');
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error('Huawei MaaS API Key 无权限或无效');
    }
    throw new Error(`Huawei MaaS 返回 ${res.status}`);
  } catch (err) {
    throw err instanceof Error ? err : new Error('Huawei MaaS discovery failed');
  }
}
