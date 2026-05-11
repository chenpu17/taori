import { generateText } from 'ai';
import { z } from 'zod';
import type { Model, Provider } from '@taori/shared';
import type { KeyStore } from '../keystore.js';
import type {
  MemoriesRepo,
  ModelsRepo,
  ProvidersRepo,
  RunEventsRepo,
  StructuredMemoriesRepo,
  StructuredMemoryType,
} from '../db/repos/index.js';
import { createChatModel } from '../providers/chat-model.js';

const AutoMemorySchema = z.array(z.object({
  type: z.enum(['preference', 'project_fact', 'profile', 'other']),
  content: z.string().min(6).max(500),
})).max(5);
export const MEMORY_LOCAL_ONLY_KEY = 'memory_local_only_enabled';

export type AutoMemoryCandidate = z.infer<typeof AutoMemorySchema>[number];

export interface ScheduleMemoryExtractionInput {
  conversationId: string;
  sourceUserMessageId: string | null;
  assistantMessageId: string;
  userText: string;
  assistantText: string;
  memoriesRepo: MemoriesRepo;
  structuredMemoriesRepo: StructuredMemoriesRepo;
  modelsRepo: ModelsRepo;
  providersRepo: ProvidersRepo;
  runEventsRepo: RunEventsRepo;
  keystore: KeyStore;
  log: { warn: (...a: unknown[]) => void; info: (...a: unknown[]) => void };
  runId: string;
}

function tryParseJson(raw: string): unknown {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '');
  try {
    return JSON.parse(stripped);
  } catch {
    const match = /\[[\s\S]*\]/.exec(stripped);
    if (!match) return undefined;
    try {
      return JSON.parse(match[0]);
    } catch {
      return undefined;
    }
  }
}

export function parseAutoMemoryCandidates(raw: string): AutoMemoryCandidate[] {
  const parsed = AutoMemorySchema.safeParse(tryParseJson(raw));
  if (!parsed.success) return [];
  const seen = new Set<string>();
  const out: AutoMemoryCandidate[] = [];
  for (const item of parsed.data) {
    const content = item.content.trim().replace(/\s+/g, ' ');
    const key = `${item.type}:${content}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type: item.type, content });
  }
  return out;
}

function buildExtractionPrompt(input: {
  userText: string;
  assistantText: string;
}): string {
  return `你是 Taori 的本地记忆抽取器。只提取对后续对话长期有用、且用户会希望助手记住的信息。

规则：
- 只提取用户偏好、稳定身份/工作方式、项目事实、长期上下文。
- 不要记录一次性问题、临时任务、敏感凭据、API Key、密码、token、身份证、银行卡、住址、手机号。
- 不要记录助手自己编造或推测的信息。
- 如果没有值得记住的信息，输出 []。
- 严格输出 JSON 数组，不要 markdown。

类型：
- preference: 用户偏好，例如“用户喜欢简短回答”
- project_fact: 项目/代码库事实，例如“当前项目使用 Tauri + React”
- profile: 用户长期身份/角色，例如“用户是前端工程师”
- other: 其他稳定且有用的信息

用户消息：
${input.userText.slice(0, 3000)}

助手回复：
${input.assistantText.slice(0, 3000)}

输出格式：
[
  { "type": "preference", "content": "用户偏好..." }
]`;
}

function isEligibleExtractionModel(model: Model | null): model is Model {
  return Boolean(
    model &&
    model.enabled &&
    model.capability === 'chat' &&
    model.provider_id,
  );
}

function modelPrice(model: Model): number {
  return model.price_per_call ?? model.price_input_per_1m ?? Number.POSITIVE_INFINITY;
}

function providerForModel(input: ScheduleMemoryExtractionInput, model: Model): Provider | null {
  return model.provider_id ? input.providersRepo.get(model.provider_id) : null;
}

function isLocalModel(input: ScheduleMemoryExtractionInput, model: Model): boolean {
  return providerForModel(input, model)?.type === 'ollama';
}

export function isLocalOnlyMemoryMode(input: Pick<ScheduleMemoryExtractionInput, 'conversationId' | 'memoriesRepo'>): boolean {
  return input.memoriesRepo.getEffective(input.conversationId, MEMORY_LOCAL_ONLY_KEY) === 'true';
}

export function pickExtractionModel(input: ScheduleMemoryExtractionInput): Model | null {
  const localOnly = isLocalOnlyMemoryMode(input);
  const configuredId = input.memoriesRepo.getEffective(
    input.conversationId,
    'memory_extraction_model_id',
  );
  const configured = configuredId ? input.modelsRepo.get(configuredId) : null;
  if (isEligibleExtractionModel(configured) && (!localOnly || isLocalModel(input, configured))) {
    return configured;
  }
  if (localOnly) {
    return input.modelsRepo
      .list()
      .filter((model) => isEligibleExtractionModel(model) && isLocalModel(input, model))
      .sort((a, b) => modelPrice(a) - modelPrice(b) || a.fallback_order - b.fallback_order)[0] ?? null;
  }
  return input.modelsRepo.pickCheapestActive('chat', '__none__');
}

function isReservedInvalidBaseUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase().endsWith('.invalid');
  } catch {
    return false;
  }
}

export function scheduleMemoryExtraction(input: ScheduleMemoryExtractionInput): void {
  setImmediate(() => {
    void runMemoryExtraction(input).catch((err) => {
      input.log.warn({ err, conversationId: input.conversationId }, 'memory.extract_failed');
    });
  });
}

async function runMemoryExtraction(input: ScheduleMemoryExtractionInput): Promise<void> {
  if (input.memoriesRepo.getEffective(input.conversationId, 'memory_auto_extract_enabled') !== 'true') {
    return;
  }
  if (input.userText.trim().length < 6 || input.assistantText.trim().length < 6) return;

  const model = pickExtractionModel(input);
  if (!model?.provider_id) {
    if (isLocalOnlyMemoryMode(input)) {
      input.runEventsRepo.append({
        run_id: input.runId,
        conversation_id: input.conversationId,
        message_id: input.assistantMessageId,
        kind: 'memory.extracted',
        status: 'failed',
        label: '记忆抽取',
        summary: '本地优先记忆模式已开启，但没有可用的本地聊天模型',
        payload: {
          local_only: true,
          reason: 'no_local_chat_model',
        },
      });
    }
    return;
  }
  const provider = input.providersRepo.get(model.provider_id);
  if (!provider || isReservedInvalidBaseUrl(provider.base_url)) return;
  if (isLocalOnlyMemoryMode(input) && provider.type !== 'ollama') {
    input.log.warn({ modelId: model.id, providerId: provider.id }, 'memory.extract_remote_provider_blocked');
    return;
  }

  let apiKey: string | null = null;
  if (provider.type === 'ollama') {
    apiKey = 'ollama-local';
  } else if (provider.api_key_ref) {
    try {
      apiKey = await input.keystore.read(provider.api_key_ref);
    } catch (err) {
      input.log.warn({ err, providerId: provider.id }, 'memory.extract_keystore_read_failed');
    }
  }
  if (!apiKey) return;

  const { model: chatModel } = createChatModel({
    provider,
    model,
    apiKey,
    memoriesRepo: input.memoriesRepo,
    conversationId: input.conversationId,
  });
  const result = await generateText({
    model: chatModel,
    prompt: buildExtractionPrompt({
      userText: input.userText,
      assistantText: input.assistantText,
    }),
    temperature: 0,
  });
  const candidates = parseAutoMemoryCandidates(result.text);
  if (candidates.length === 0) return;

  const existing = new Set(
    input.structuredMemoriesRepo
      .list({ includeDisabled: true, limit: 200 })
      .map((memory) => `${memory.type}:${memory.content}`),
  );
  const inserted = [];
  for (const candidate of candidates) {
    const key = `${candidate.type}:${candidate.content}`;
    if (existing.has(key)) continue;
    existing.add(key);
    inserted.push(input.structuredMemoriesRepo.insert({
      scope: 'global',
      type: candidate.type as StructuredMemoryType,
      content: candidate.content,
      source_conversation_id: input.conversationId,
      source_message_id: input.sourceUserMessageId ?? input.assistantMessageId,
      enabled: true,
    }));
  }
  if (inserted.length === 0) return;
  input.runEventsRepo.append({
    run_id: input.runId,
    conversation_id: input.conversationId,
    message_id: input.assistantMessageId,
    kind: 'memory.extracted',
    status: 'completed',
    label: '记忆抽取',
    summary: `新增 ${inserted.length} 条记忆`,
      payload: {
        model_id: model.id,
        memory_ids: inserted.map((item) => item.id),
        source_user_message_id: input.sourceUserMessageId,
        local_only: isLocalOnlyMemoryMode(input),
      },
    });
  }
