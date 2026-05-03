/**
 * Provider adapters: the minimal per-provider knowledge needed for M1.1
 *   - testProvider(): credential probe (used during onboarding)
 *   - listProviderModels(): discovery (used to seed model picker)
 *
 * M1 focuses on OpenRouter (preferred default in product spec) and OpenAI.
 * Anthropic / Ollama / custom are scaffolded but only carry generic test
 * behavior; full discovery lands in later iterations.
 *
 * Network-error → ErrorClassification mapping is centralized in
 * `classifyProviderError` so M1.4 can reuse it for runtime stream errors.
 */

import {
  type ProviderType,
  type DiscoveredModel,
  type ErrorClassification,
} from '@taori/shared';
import {
  testVolcengineArk,
  listVolcengineArkModels,
} from './volcengine_ark.js';
import {
  testHuaweiMaas,
  listHuaweiMaasModels,
} from './huawei_maas.js';

export interface ProviderTestResult {
  ok: boolean;
  sample_count?: number;
  classification?: ErrorClassification;
  message?: string;
}

const REQUEST_TIMEOUT_MS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function errorCandidates(err: unknown): unknown[] {
  const candidates = [err];
  if (!isRecord(err)) return candidates;

  const lastError = err.lastError;
  if (lastError) candidates.push(lastError);

  const errors = err.errors;
  if (Array.isArray(errors)) {
    candidates.push(...errors.slice().reverse());
  }

  return candidates;
}

function statusFromError(err: unknown): number | undefined {
  if (!isRecord(err)) return undefined;
  const status = err.statusCode ?? err.status;
  return typeof status === 'number' ? status : undefined;
}

function messageFromError(err: unknown): string | undefined {
  if (err instanceof Error) return err.message;
  if (!isRecord(err)) return undefined;
  const message = err.message;
  return typeof message === 'string' ? message : undefined;
}

function stringFromUnknown(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!isRecord(value)) return undefined;
  const error = value.error;
  if (isRecord(error)) {
    const message = error.message;
    if (typeof message === 'string') return message;
  }
  const message = value.message;
  if (typeof message === 'string') return message;
  const detail = value.detail;
  if (typeof detail === 'string') return detail;
  return undefined;
}

function responseTextCandidates(err: unknown): string[] {
  if (!isRecord(err)) return [];
  const out: string[] = [];
  const responseBody = err.responseBody;
  if (typeof responseBody === 'string') {
    out.push(responseBody);
    try {
      const parsed = JSON.parse(responseBody) as unknown;
      const nested = stringFromUnknown(parsed);
      if (nested) out.push(nested);
    } catch {
      /* non-JSON upstream body */
    }
  }
  const data = err.data;
  const dataText = stringFromUnknown(data);
  if (dataText) out.push(dataText);
  return out;
}

export function isToolPayloadUnsupportedError(err: unknown): boolean {
  const text = errorCandidates(err)
    .flatMap((candidate) => [
      messageFromError(candidate),
      ...responseTextCandidates(candidate),
    ])
    .filter((message): message is string => Boolean(message))
    .join('\n');
  if (!text) return false;
  return (
    /(?:tools?|tool_calls?|function[_\s-]?call(?:ing)?|functions?)\b[\s\S]{0,120}\b(?:unsupported|not supported|does not support|not support|invalid|unknown|unrecognized|not allowed|forbidden|extra_forbidden|extra inputs are not permitted)/i.test(text) ||
    /\b(?:unsupported|not supported|does not support|not support|invalid|unknown|unrecognized|not allowed|forbidden|extra_forbidden|extra inputs are not permitted)\b[\s\S]{0,120}\b(?:tools?|tool_calls?|function[_\s-]?call(?:ing)?|functions?)/i.test(text) ||
    /(?:不支持|未知|无效|非法|不允许)[\s\S]{0,80}(?:tools?|tool_calls?|工具|函数调用|function)/i.test(text) ||
    /(?:tools?|tool_calls?|工具|函数调用|function)[\s\S]{0,80}(?:不支持|未知|无效|非法|不允许)/i.test(text)
  );
}

async function timedFetch(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function classifyProviderError(args: {
  status?: number;
  err?: unknown;
}): { classification: ErrorClassification; message: string } {
  const candidates = errorCandidates(args.err);
  const messages = candidates
    .flatMap((candidate) => [
      messageFromError(candidate),
      ...responseTextCandidates(candidate),
    ])
    .filter((message): message is string => Boolean(message));

  for (const candidate of candidates) {
    if (candidate instanceof Error && candidate.name === 'AbortError') {
      return { classification: 'network', message: 'Request timed out' };
    }
    const cause = isRecord(candidate) ? candidate.cause : undefined;
    const code = isRecord(cause) ? cause.code : undefined;
    if (typeof code === 'string' && code.length > 0) {
      return {
        classification: 'network',
        message: `Network error (${code})`,
      };
    }
  }
  const message = messages.join('\n');
  // Some upstreams (Anthropic, Bedrock, MS-hosted endpoints) signal a
  // safety / content-policy block via a 4xx whose message contains
  // "content_filter" / "content_policy" / "safety" markers. Detect those
  // before falling through to status-only classification so the renderer
  // can show the dedicated "内容被安全策略拦截" banner.
  if (
    /content[_\- ]?filter|content[_\- ]?policy|moderation|safety[_\- ]?block/i
      .test(message)
  ) {
    return {
      classification: 'content_filter',
      message: 'Upstream blocked the response (content policy)',
    };
  }
  if (/quota|insufficient[_\- ]?quota|exceeded your current quota/i.test(message)) {
    return { classification: 'quota', message: 'Quota / billing issue' };
  }
  if (/rate[_\- ]?limit|too many requests/i.test(message)) {
    return { classification: 'rate_limit', message: 'Rate limit hit' };
  }
  const status = args.status ?? candidates.map(statusFromError).find((s) => s != null);
  if (status === 401 || status === 403) {
    return {
      classification: 'auth',
      message: 'Authentication failed (check API key)',
    };
  }
  if (status === 402 || status === 429) {
    return {
      classification: status === 402 ? 'quota' : 'rate_limit',
      message: status === 402 ? 'Quota / billing issue' : 'Rate limit hit',
    };
  }
  if (status === 400) {
    if (isToolPayloadUnsupportedError(args.err)) {
      return {
        classification: 'config_error',
        message:
          'Provider returned 400 — 当前模型不支持工具调用（web search / 图像生成等 tools 参数）。' +
          '请换用支持 tools 的聊天模型，或在模型中心关闭该模型的 Tools 能力。',
      };
    }
    return {
      classification: 'config_error',
      message:
        'Provider returned 400 — 请求被供应商拒绝；常见原因是模型名称、接入点、请求参数或该模型不支持当前能力。请检查模型配置与供应商返回详情。',
    };
  }
  if (status === 404) {
    return {
      classification: 'config_error',
      message:
        'Provider returned 404 — 模型或接入点不存在，或当前 API Key 无权访问该模型。请检查供应商、Base URL 与模型名。',
    };
  }
  if (status && status >= 500) {
    return {
      classification: 'network',
      message: `Provider returned ${status}`,
    };
  }
  return {
    classification: 'unknown',
    message: status ? `Unexpected status ${status}` : 'Unknown error',
  };
}

interface OpenRouterListItem {
  id: string;
  name?: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
  architecture?: { modality?: string; input_modalities?: string[]; output_modalities?: string[] };
}

function openRouterPriceToPer1m(raw: string | undefined): number | null {
  if (raw == null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return n * 1_000_000;
}

function openRouterToDiscovered(item: OpenRouterListItem): DiscoveredModel {
  const inputModalities =
    item.architecture?.input_modalities ??
    (item.architecture?.modality ? [item.architecture.modality] : []);
  const outputModalities = item.architecture?.output_modalities ?? [];
  const supportsVision = inputModalities.some((m) =>
    m.toLowerCase().includes('image'),
  );
  const generatesImage = outputModalities.some((m) =>
    m.toLowerCase().includes('image'),
  );
  // Most OpenRouter models are chat. We surface multimodal when input
  // accepts image, so the UI groups them under the multimodal capability
  // pool but the chat-candidate selector still considers them.
  const capability: DiscoveredModel['capability'] = generatesImage
    ? 'image'
    : supportsVision
    ? 'multimodal'
    : 'chat';
  const modalities: DiscoveredModel['modalities'] = generatesImage
    ? supportsVision
      ? ['text', 'image']
      : ['image']
    : supportsVision
    ? ['text', 'image']
    : ['text'];
  return {
    model_name: item.id,
    display_name: item.name ?? item.id,
    capability,
    price_input_per_1m: openRouterPriceToPer1m(item.pricing?.prompt),
    price_output_per_1m: openRouterPriceToPer1m(item.pricing?.completion),
    price_per_image: null,
    price_per_video_second: null,
    modalities,
    context_length: item.context_length ?? null,
    supports_vision: supportsVision,
    supports_tools: false,
  };
}

async function testOpenRouter(
  baseUrl: string,
  apiKey: string,
): Promise<ProviderTestResult> {
  try {
    const res = await timedFetch(`${baseUrl.replace(/\/$/, '')}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      return { ok: false, ...classifyProviderError({ status: res.status }) };
    }
    const body = (await res.json()) as { data?: OpenRouterListItem[] };
    return { ok: true, sample_count: body.data?.length ?? 0 };
  } catch (err) {
    return { ok: false, ...classifyProviderError({ err }) };
  }
}

async function listOpenRouterModels(
  baseUrl: string,
  apiKey: string,
): Promise<DiscoveredModel[]> {
  const res = await timedFetch(`${baseUrl.replace(/\/$/, '')}/models`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    const c = classifyProviderError({ status: res.status });
    throw new Error(c.message);
  }
  const body = (await res.json()) as { data?: OpenRouterListItem[] };
  return (body.data ?? []).map(openRouterToDiscovered);
}

interface OpenAIListItem {
  id: string;
  name?: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string; image?: string };
  architecture?: { modality?: string; input_modalities?: string[]; output_modalities?: string[] };
  input_modalities?: string[];
  output_modalities?: string[];
  modalities?: string[];
  capability?: string;
  capabilities?: Record<string, unknown>;
}

async function testOpenAI(
  baseUrl: string,
  apiKey: string,
): Promise<ProviderTestResult> {
  try {
    const res = await timedFetch(`${baseUrl.replace(/\/$/, '')}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      return { ok: false, ...classifyProviderError({ status: res.status }) };
    }
    const body = (await res.json()) as { data?: OpenAIListItem[] };
    return { ok: true, sample_count: body.data?.length ?? 0 };
  } catch (err) {
    return { ok: false, ...classifyProviderError({ err }) };
  }
}

const OPENAI_RECOMMENDED: DiscoveredModel[] = [
  {
    model_name: 'gpt-4o-mini',
    display_name: 'GPT-4o mini',
    capability: 'chat',
    price_input_per_1m: 0.15,
    price_output_per_1m: 0.6,
    context_length: 128_000,
    supports_vision: true,
    supports_tools: true,
  },
  {
    model_name: 'gpt-4o',
    display_name: 'GPT-4o',
    capability: 'chat',
    price_input_per_1m: 2.5,
    price_output_per_1m: 10,
    context_length: 128_000,
    supports_vision: true,
    supports_tools: true,
  },
];

function hasTruthyCapability(item: OpenAIListItem, names: string[]): boolean {
  const caps = item.capabilities;
  if (!caps) return false;
  return names.some((name) => caps[name] === true);
}

function inferOpenAICompatibleModel(item: OpenAIListItem): DiscoveredModel {
  const id = item.id;
  const displayName = item.name ?? item.id;
  const metadata = `${id} ${displayName} ${item.capability ?? ''}`.toLowerCase();
  const inputModalities = [
    ...(item.input_modalities ?? []),
    ...(item.architecture?.input_modalities ?? []),
    ...(item.architecture?.modality ? [item.architecture.modality] : []),
    ...(item.modalities ?? []),
  ].map((m) => m.toLowerCase());
  const outputModalities = [
    ...(item.output_modalities ?? []),
    ...(item.architecture?.output_modalities ?? []),
  ].map((m) => m.toLowerCase());
  const explicitCapability = (item.capability ?? '').toLowerCase();
  const isImageGeneration =
    explicitCapability === 'image' ||
    outputModalities.includes('image') ||
    hasTruthyCapability(item, ['image_generation', 'image', 'images']) ||
    /\b(?:gpt-image|dall[-_ ]?e|imagen|flux|sdxl|stable[-_ ]?diffusion|image[-_ ]?(?:generation|edit)|text[-_ ]?to[-_ ]?image|txt2img|t2i)\b/i.test(metadata);
  const isVideoGeneration =
    explicitCapability === 'video' ||
    outputModalities.includes('video') ||
    /\b(?:video|text[-_ ]?to[-_ ]?video|image[-_ ]?to[-_ ]?video|t2v|i2v|seedance|wan)\b/i.test(metadata);
  const supportsVision =
    inputModalities.includes('image') ||
    /(?:vision|multimodal|gpt-4o|gpt-4\.1|omni|vl)\b/i.test(metadata);
  const isEmbedding =
    explicitCapability === 'embedding' ||
    /\b(?:embedding|embed)\b/i.test(metadata);
  const capability: DiscoveredModel['capability'] = isVideoGeneration
    ? 'video'
    : isImageGeneration
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
        ? inputModalities.includes('image') || /edit|i2i|image[-_ ]?edit/i.test(metadata)
          ? ['text', 'image']
          : ['image']
        : supportsVision
          ? ['text', 'image']
          : ['text'];

  return {
    model_name: id,
    display_name: displayName,
    capability,
    price_input_per_1m: openRouterPriceToPer1m(item.pricing?.prompt),
    price_output_per_1m: openRouterPriceToPer1m(item.pricing?.completion),
    price_per_image: null,
    price_per_video_second: null,
    modalities,
    context_length: item.context_length ?? null,
    supports_vision: supportsVision,
    supports_tools: capability === 'chat' || capability === 'multimodal',
  };
}

async function listOpenAICompatibleModels(
  baseUrl: string,
  apiKey: string,
): Promise<DiscoveredModel[]> {
  const normalized = baseUrl.replace(/\/$/, '');
  const res = await timedFetch(`${normalized}/models`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    const c = classifyProviderError({ status: res.status });
    throw new Error(c.message);
  }
  const body = (await res.json()) as { data?: OpenAIListItem[] };
  const models = (body.data ?? []).map(inferOpenAICompatibleModel);
  if (models.length > 0) return models;
  if (/api\.openai\.com\/v1\/?$/i.test(normalized)) return OPENAI_RECOMMENDED;
  return [];
}

export function pickRecommendations(models: DiscoveredModel[]): {
  chat: string | null;
  vision: string | null;
} {
  // Multimodal models still answer text — include them in the chat pool so
  // a single vision-capable model imported alone gives the user a working
  // chat default out of the box.
  const candidates = models.filter(
    (m) => m.capability === 'chat' || m.capability === 'multimodal',
  );
  const preferChat = [
    'openai/gpt-4o-mini',
    'gpt-4o-mini',
    'deepseek-v3.2',
    'DeepSeek-V3',
    'Kimi-K2',
    'anthropic/claude-3.5-haiku',
    'google/gemini-2.0-flash-001',
    'meta-llama/llama-3.3-70b-instruct',
  ];
  const preferVision = [
    'openai/gpt-4o',
    'gpt-4o',
    'qwen2.5-vl-72b',
    'anthropic/claude-3.5-sonnet',
    'google/gemini-2.0-flash-001',
  ];
  const find = (preferred: string[], filter?: (m: DiscoveredModel) => boolean) => {
    const pool = filter ? candidates.filter(filter) : candidates;
    for (const want of preferred) {
      const hit = pool.find((m) => m.model_name === want);
      if (hit) return hit.model_name;
    }
    return pool[0]?.model_name ?? null;
  };
  return {
    chat: find(preferChat),
    vision: find(preferVision, (m) => m.supports_vision),
  };
}

export async function testProvider(args: {
  type: ProviderType;
  base_url: string;
  api_key: string;
}): Promise<ProviderTestResult> {
  switch (args.type) {
    case 'openrouter':
      return testOpenRouter(args.base_url, args.api_key);
    case 'openai':
      return testOpenAI(args.base_url, args.api_key);
    case 'volcengine_ark':
      return testVolcengineArk(args.base_url, args.api_key);
    case 'huawei_maas':
      return testHuaweiMaas(args.base_url, args.api_key);
    default:
      return testOpenAI(args.base_url, args.api_key);
  }
}

export async function listProviderModels(args: {
  type: ProviderType;
  base_url: string;
  api_key: string;
}): Promise<DiscoveredModel[]> {
  switch (args.type) {
    case 'openrouter':
      return listOpenRouterModels(args.base_url, args.api_key);
    case 'openai':
      return listOpenAICompatibleModels(args.base_url, args.api_key);
    case 'volcengine_ark':
      return listVolcengineArkModels(args.base_url, args.api_key);
    case 'huawei_maas':
      return listHuaweiMaasModels(args.base_url, args.api_key);
    case 'custom':
      return listOpenAICompatibleModels(args.base_url, args.api_key);
    default:
      return [];
  }
}
