import { createOpenAI } from '@ai-sdk/openai';
import { isChatCapable, type Model, type Provider } from '@taori/shared';
import type { MemoriesRepo } from '../db/repos/index.js';
import { normalizeOllamaOpenAiBaseUrl } from './ollama.js';

export type ThinkingSource = 'model' | 'global' | 'default';
type ThinkingStrategy = 'none' | 'deepseek' | 'openrouter' | 'openai-reasoning-effort';

export interface ThinkingConfig {
  enabled: boolean;
  source: ThinkingSource;
  strategy: ThinkingStrategy;
}

export interface CreateChatModelArgs {
  provider: Provider;
  model: Model;
  apiKey: string;
  memoriesRepo?: MemoriesRepo | null;
  conversationId?: string | null;
}

export interface CreateChatModelResult {
  provider: ReturnType<typeof createOpenAI>;
  model: ReturnType<ReturnType<typeof createOpenAI>['chat']>;
  thinking: ThinkingConfig;
}

type FetchLike = (
  input: Parameters<typeof globalThis.fetch>[0],
  init?: Parameters<typeof globalThis.fetch>[1],
) => ReturnType<typeof globalThis.fetch>;

function normalizeBaseUrl(provider: Provider): string {
  return provider.type === 'ollama'
    ? normalizeOllamaOpenAiBaseUrl(provider.base_url)
    : provider.base_url.replace(/\/$/, '');
}

function isOpenAIReasoningModelName(modelName: string): boolean {
  return /^(?:o1(?:-mini|-preview)?|o3(?:-mini)?|o4(?:-mini)?|gpt-5)(?:[./_-]|$)/i.test(
    modelName.trim(),
  );
}

export function resolveThinkingConfig(args: {
  model: Pick<Model, 'capability' | 'model_name' | 'thinking_enabled'>;
  provider: Pick<Provider, 'type'>;
  memoriesRepo?: MemoriesRepo | null;
  conversationId?: string | null;
}): ThinkingConfig {
  if (!isChatCapable(args.model.capability)) {
    return { enabled: false, source: 'default', strategy: 'none' };
  }

  let enabled = false;
  let source: ThinkingSource = 'default';
  if (args.model.thinking_enabled != null) {
    enabled = args.model.thinking_enabled;
    source = 'model';
  } else {
    const raw = args.memoriesRepo?.getEffective(args.conversationId ?? null, 'thinking_enabled') ?? null;
    if (raw != null) {
      enabled = raw === 'true';
      source = 'global';
    }
  }

  let strategy: ThinkingStrategy = 'none';
  if (args.provider.type === 'deepseek') {
    strategy = enabled || source !== 'default' ? 'deepseek' : 'none';
  } else if (args.provider.type === 'openrouter') {
    strategy = enabled || source !== 'default' ? 'openrouter' : 'none';
  } else if (
    (args.provider.type === 'openai' || args.provider.type === 'custom')
    && isOpenAIReasoningModelName(args.model.model_name)
  ) {
    strategy = enabled || source !== 'default' ? 'openai-reasoning-effort' : 'none';
  }

  return { enabled, source, strategy };
}

function withPatchedJsonBody(
  fetchImpl: FetchLike,
  patch: (body: Record<string, unknown>) => void,
): FetchLike {
  return async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ) => {
    if (!init || typeof init.body !== 'string') {
      return fetchImpl(input, init);
    }
    try {
      const parsed = JSON.parse(init.body) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return fetchImpl(input, init);
      }
      const body = { ...(parsed as Record<string, unknown>) };
      patch(body);
      return fetchImpl(input, { ...init, body: JSON.stringify(body) });
    } catch {
      return fetchImpl(input, init);
    }
  };
}

function buildFetchTransform(thinking: ThinkingConfig): FetchLike | undefined {
  if (thinking.strategy === 'openrouter') {
    return withPatchedJsonBody(globalThis.fetch, (body) => {
      delete body.reasoning_effort;
      body.reasoning = thinking.enabled
        ? { enabled: true, effort: 'medium', exclude: true }
        : { enabled: false, exclude: true };
    });
  }
  if (thinking.strategy === 'deepseek') {
    return withPatchedJsonBody(globalThis.fetch, (body) => {
      delete body.reasoning_effort;
      body.thinking = { type: thinking.enabled ? 'enabled' : 'disabled' };
    });
  }
  return undefined;
}

export function createChatModel(args: CreateChatModelArgs): CreateChatModelResult {
  const thinking = resolveThinkingConfig({
    model: args.model,
    provider: args.provider,
    memoriesRepo: args.memoriesRepo,
    conversationId: args.conversationId,
  });
  const provider = createOpenAI({
    baseURL: normalizeBaseUrl(args.provider),
    apiKey: args.apiKey,
    fetch: buildFetchTransform(thinking),
  });
  const model = thinking.strategy === 'openai-reasoning-effort'
    ? provider.chat(args.model.model_name, {
      reasoningEffort: thinking.enabled ? 'medium' : 'low',
    })
    : provider.chat(args.model.model_name);

  return { provider, model, thinking };
}
