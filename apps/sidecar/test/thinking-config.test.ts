import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateText } from 'ai';
import type { Model, Provider } from '@taori/shared';
import { createChatModel, resolveThinkingConfig } from '../src/providers/chat-model.js';

function makeProvider(type: Provider['type'], baseUrl = 'https://example.com/v1'): Provider {
  return {
    id: `prov_${type}`,
    name: type,
    type,
    base_url: baseUrl,
    api_key_ref: 'key_ref',
    enabled: true,
    created_at: 0,
    updated_at: 0,
  };
}

function makeModel(
  modelName: string,
  overrides: Partial<Model> = {},
): Model {
  return {
    id: `mdl_${modelName.replace(/[^a-z0-9]+/gi, '_')}`,
    alias: null,
    provider_id: 'prov',
    model_name: modelName,
    capability: 'chat',
    display_name: modelName,
    price_input_per_1m: null,
    price_output_per_1m: null,
    price_per_call: null,
    price_per_image: null,
    price_per_video_second: null,
    price_currency: 'USD',
    pricing_meta: null,
    modalities: ['text'],
    price_synced_at: null,
    context_length: null,
    supports_vision: false,
    supports_tools: false,
    supports_json: false,
    thinking_enabled: null,
    is_default_for: null,
    enabled: true,
    fallback_order: 0,
    demoted: false,
    disabled_until: null,
    failure_count_24h: 0,
    ...overrides,
  };
}

async function captureRequestBody(args: {
  provider: Provider;
  model: Model;
  conversationId?: string | null;
  globalThinking?: string | null;
}): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> | null = null;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });

  const { model } = createChatModel({
    provider: args.provider,
    model: args.model,
    apiKey: 'test-key',
    conversationId: args.conversationId ?? null,
    memoriesRepo: {
      getEffective: () => args.globalThinking ?? null,
    } as { getEffective: (conversationId: string | null, key: string) => string | null },
  });
  await generateText({
    model,
    prompt: 'ping',
    maxTokens: 1,
    abortSignal: AbortSignal.timeout(5_000),
  });
  expect(body).toBeTruthy();
  return body!;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('thinking config resolution', () => {
  it('prefers per-model override over the global default', () => {
    const thinking = resolveThinkingConfig({
      provider: makeProvider('openrouter'),
      model: makeModel('x-ai/grok-4.3', { thinking_enabled: false }),
      conversationId: 'conv_1',
      memoriesRepo: {
        getEffective: () => 'true',
      } as { getEffective: (conversationId: string | null, key: string) => string | null },
    });

    expect(thinking).toMatchObject({
      enabled: false,
      source: 'model',
      strategy: 'openrouter',
    });
  });

  it('keeps legacy behavior when nothing is configured', () => {
    const thinking = resolveThinkingConfig({
      provider: makeProvider('deepseek'),
      model: makeModel('deepseek-v4-flash'),
      memoriesRepo: {
        getEffective: () => null,
      } as { getEffective: (conversationId: string | null, key: string) => string | null },
    });

    expect(thinking).toEqual({
      enabled: false,
      source: 'default',
      strategy: 'none',
    });
  });
});

describe('provider-specific thinking payloads', () => {
  it('sends OpenRouter reasoning payload when enabled globally', async () => {
    const body = await captureRequestBody({
      provider: makeProvider('openrouter'),
      model: makeModel('x-ai/grok-4.3'),
      globalThinking: 'true',
    });

    expect(body.reasoning).toEqual({ enabled: true, effort: 'medium', exclude: true });
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('sends OpenRouter explicit disable payload for per-model override', async () => {
    const body = await captureRequestBody({
      provider: makeProvider('openrouter'),
      model: makeModel('x-ai/grok-4.3', { thinking_enabled: false }),
      globalThinking: 'true',
    });

    expect(body.reasoning).toEqual({ enabled: false, exclude: true });
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('sends DeepSeek thinking boolean when explicitly enabled', async () => {
    const body = await captureRequestBody({
      provider: makeProvider('deepseek'),
      model: makeModel('deepseek-v4-flash'),
      globalThinking: 'true',
    });

    expect(body.thinking).toEqual({ type: 'enabled' });
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('uses reasoning_effort for GPT-5 style models and omits it by default', async () => {
    const enabledBody = await captureRequestBody({
      provider: makeProvider('custom'),
      model: makeModel('gpt-5.5-2026-04-24'),
      globalThinking: 'true',
    });
    expect(enabledBody.reasoning_effort).toBe('medium');

    const disabledBody = await captureRequestBody({
      provider: makeProvider('custom'),
      model: makeModel('gpt-5.5-2026-04-24', { thinking_enabled: false }),
    });
    expect(disabledBody.reasoning_effort).toBe('low');

    const defaultBody = await captureRequestBody({
      provider: makeProvider('custom'),
      model: makeModel('gpt-5.5-2026-04-24'),
    });
    expect(defaultBody.reasoning_effort).toBeUndefined();
  });
});
