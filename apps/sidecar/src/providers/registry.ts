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

export interface ProviderTestResult {
  ok: boolean;
  sample_count?: number;
  classification?: ErrorClassification;
  message?: string;
}

const REQUEST_TIMEOUT_MS = 10_000;

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
  if (args.err instanceof Error) {
    if (args.err.name === 'AbortError') {
      return { classification: 'network', message: 'Request timed out' };
    }
    const cause = (args.err as { cause?: { code?: string } }).cause;
    if (cause?.code) {
      return {
        classification: 'network',
        message: `Network error (${cause.code})`,
      };
    }
    // Some upstreams (Anthropic, Bedrock, MS-hosted endpoints) signal a
    // safety / content-policy block via a 4xx whose message contains
    // "content_filter" / "content_policy" / "safety" markers. Detect those
    // before falling through to status-only classification so the renderer
    // can show the dedicated "内容被安全策略拦截" banner.
    const message = args.err.message ?? '';
    if (
      /content[_\- ]?filter|content[_\- ]?policy|moderation|safety[_\- ]?block/i
        .test(message)
    ) {
      return {
        classification: 'content_filter',
        message: 'Upstream blocked the response (content policy)',
      };
    }
  }
  const status = args.status;
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
    return {
      classification: 'config_error',
      message:
        'Provider returned 400 — 模型名称或接入端 ID 有误；' +
        '火山方舟用户请确认使用正确的 endpoint ID（如 ep-xxx）或已在控制台激活该模型',
    };
  }
  if (status === 404) {
    return {
      classification: 'config_error',
      message:
        'Provider returned 404 — 接入点不存在；' +
        '火山方舟用户请到控制台「模型广场」开通该模型的使用权限，或改用 endpoint ID（ep-xxx）作为模型名称',
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
  architecture?: { modality?: string; input_modalities?: string[] };
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
  const supportsVision = inputModalities.some((m) =>
    m.toLowerCase().includes('image'),
  );
  // Most OpenRouter models are chat. We surface multimodal when input
  // accepts image, so the UI groups them under the multimodal capability
  // pool but the chat-candidate selector still considers them.
  const capability: DiscoveredModel['capability'] = supportsVision
    ? 'multimodal'
    : 'chat';
  const modalities: DiscoveredModel['modalities'] = supportsVision
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

interface OpenAIListItem { id: string }

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
  },
  {
    model_name: 'gpt-4o',
    display_name: 'GPT-4o',
    capability: 'chat',
    price_input_per_1m: 2.5,
    price_output_per_1m: 10,
    context_length: 128_000,
    supports_vision: true,
  },
];

async function listOpenAIModels(): Promise<DiscoveredModel[]> {
  return OPENAI_RECOMMENDED;
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
    'anthropic/claude-3.5-haiku',
    'google/gemini-2.0-flash-001',
    'meta-llama/llama-3.3-70b-instruct',
  ];
  const preferVision = [
    'openai/gpt-4o',
    'gpt-4o',
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
      return listOpenAIModels();
    case 'volcengine_ark':
      return listVolcengineArkModels(args.base_url, args.api_key);
    default:
      return [];
  }
}
