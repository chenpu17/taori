/**
 * DeepSeek official provider adapter.
 *
 * DeepSeek exposes an OpenAI-compatible API. The official base URL is
 * https://api.deepseek.com; /models currently returns deepseek-v4-flash and
 * deepseek-v4-pro.
 */

import {
  DEFAULT_DEEPSEEK_BASE_URL,
  type DiscoveredModel,
  type ErrorClassification,
} from '@taori/shared';

export const DEEPSEEK_DEFAULT_BASE_URL = DEFAULT_DEEPSEEK_BASE_URL;

const REQUEST_TIMEOUT_MS = 10_000;

interface DeepSeekTestResult {
  ok: boolean;
  sample_count?: number;
  classification?: ErrorClassification;
  message?: string;
}

interface DeepSeekModelListItem {
  id: string;
  name?: string;
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

function classifyDeepSeekStatus(status: number): DeepSeekTestResult {
  if (status === 401 || status === 403) {
    return { ok: false, classification: 'auth', message: 'DeepSeek API Key 无权限或无效' };
  }
  if (status === 402) {
    return { ok: false, classification: 'quota', message: 'DeepSeek 余额或配额不足' };
  }
  if (status === 429) {
    return { ok: false, classification: 'rate_limit', message: 'DeepSeek 限流' };
  }
  if (status >= 500) {
    return { ok: false, classification: 'network', message: `DeepSeek 返回 ${status}` };
  }
  return { ok: false, classification: 'config_error', message: `DeepSeek 返回 ${status}` };
}

function deepSeekUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

function displayNameForDeepSeek(id: string, name?: string): string {
  if (name && name !== id) return name;
  if (id === 'deepseek-v4-flash') return 'DeepSeek V4 Flash';
  if (id === 'deepseek-v4-pro') return 'DeepSeek V4 Pro';
  if (id === 'deepseek-chat') return 'DeepSeek Chat';
  if (id === 'deepseek-reasoner') return 'DeepSeek Reasoner';
  return id
    .replace(/^deepseek[-_/]/i, 'DeepSeek ')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function inferDeepSeekModel(item: DeepSeekModelListItem): DiscoveredModel {
  const id = item.id;
  return {
    model_name: id,
    display_name: displayNameForDeepSeek(id, item.name),
    capability: 'chat',
    price_input_per_1m: null,
    price_output_per_1m: null,
    price_per_image: null,
    price_per_video_second: null,
    pricing_meta: {
      version: 1,
      unit: 'token',
      tiers: [],
      notes: 'DeepSeek official pricing is model/account managed; edit in Model Center if needed.',
      source_url: 'https://api-docs.deepseek.com/quick_start/pricing',
    },
    modalities: ['text'],
    context_length: item.context_length ?? null,
    supports_vision: false,
    supports_tools: true,
  };
}

export async function testDeepSeek(
  baseUrl: string,
  apiKey: string,
): Promise<DeepSeekTestResult> {
  try {
    const res = await timedFetch(deepSeekUrl(baseUrl, '/models'), {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (res.ok) {
      const body = (await res.json().catch(() => ({}))) as { data?: unknown[] };
      return { ok: true, sample_count: body.data?.length ?? 0 };
    }
    return classifyDeepSeekStatus(res.status);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, classification: 'network', message: `DeepSeek 网络错误：${msg}` };
  }
}

export async function listDeepSeekModels(
  baseUrl: string,
  apiKey: string,
): Promise<DiscoveredModel[]> {
  const res = await timedFetch(deepSeekUrl(baseUrl, '/models'), {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    const classified = classifyDeepSeekStatus(res.status);
    throw new Error(classified.message);
  }
  const body = (await res.json()) as { data?: DeepSeekModelListItem[] };
  return (body.data ?? []).map(inferDeepSeekModel);
}
