import { isChatCapable, type DiscoveredModel } from '@taori/shared';
import type { ProviderTestResult } from './registry.js';
import { classifyProviderError } from './registry.js';

const REQUEST_TIMEOUT_MS = 10_000;

interface OllamaTag {
  name?: string;
  model?: string;
}

interface OllamaTagsResponse {
  models?: OllamaTag[];
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

export function normalizeOllamaApiRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/v1$/i, '');
}

export function normalizeOllamaOpenAiBaseUrl(baseUrl: string): string {
  const root = normalizeOllamaApiRoot(baseUrl);
  return `${root}/v1`;
}

function ollamaTagsUrl(baseUrl: string): string {
  return `${normalizeOllamaApiRoot(baseUrl)}/api/tags`;
}

function inferOllamaModel(name: string): DiscoveredModel {
  const metadata = name.toLowerCase();
  const isEmbedding = /(?:^|[-_:./])(?:embed|embedding)(?:$|[-_:./])|nomic-embed|bge-m3|qwen3-embedding/i.test(metadata);
  const supportsVision = /(?:llava|vision|[-_:./]vl(?:$|[-_:./])|qwen2(?:\.5)?vl|qwen-vl|moondream|bakllava)/i.test(metadata);
  const capability: DiscoveredModel['capability'] = isEmbedding
    ? 'embedding'
    : supportsVision
      ? 'multimodal'
      : 'chat';
  return {
    model_name: name,
    display_name: name,
    capability,
    price_input_per_1m: 0,
    price_output_per_1m: 0,
    price_per_image: null,
    price_per_video_second: null,
    modalities: supportsVision ? ['text', 'image'] : ['text'],
    context_length: null,
    supports_vision: supportsVision,
    supports_tools: isChatCapable(capability),
  };
}

async function fetchOllamaTags(baseUrl: string): Promise<OllamaTag[]> {
  const res = await timedFetch(ollamaTagsUrl(baseUrl), { method: 'GET' });
  if (!res.ok) {
    const c = classifyProviderError({ status: res.status });
    throw new Error(c.message);
  }
  const body = (await res.json()) as OllamaTagsResponse;
  return Array.isArray(body.models) ? body.models : [];
}

export async function testOllama(baseUrl: string): Promise<ProviderTestResult> {
  try {
    const models = await fetchOllamaTags(baseUrl);
    return { ok: true, sample_count: models.length };
  } catch (err) {
    const classified = classifyProviderError({ err });
    return {
      ok: false,
      classification: classified.classification,
      message:
        classified.classification === 'network'
          ? `${classified.message}. 请确认已运行 ollama serve，并检查 ${normalizeOllamaApiRoot(baseUrl)} 是否可访问。`
          : classified.message,
    };
  }
}

export async function listOllamaModels(baseUrl: string): Promise<DiscoveredModel[]> {
  const tags = await fetchOllamaTags(baseUrl);
  return tags
    .map((tag) => tag.name ?? tag.model ?? '')
    .filter((name) => name.trim().length > 0)
    .map(inferOllamaModel);
}
