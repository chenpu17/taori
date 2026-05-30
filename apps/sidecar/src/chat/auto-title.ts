import { generateText } from 'ai';
import type {
  ConversationsRepo,
  MemoriesRepo,
  ModelsRepo,
  ProvidersRepo,
} from '../db/repos/index.js';
import type { KeyStore } from '../keystore.js';
import { createChatModel } from '../providers/chat-model.js';
import { isProviderRunnable } from '../models/eligibility.js';

export const LLM_AUTO_TITLE_ENABLED_KEY = 'auto_title_llm_enabled';

export interface ScheduleAutoTitleInput {
  conversationId: string;
  /** First user message of the conversation (also the immediate truncation source). */
  userText: string;
  /** First assistant reply, used as extra context for a sharper title. */
  assistantText: string;
  convRepo: ConversationsRepo;
  modelsRepo: ModelsRepo;
  providersRepo: ProvidersRepo;
  memoriesRepo: MemoriesRepo;
  keystore: KeyStore;
  /** When true (hermetic e2e), keep the truncation and never call a model. */
  hermetic: boolean;
  log: { warn: (...a: unknown[]) => void };
}

/**
 * The immediate, free title applied synchronously on the first turn. Also the
 * probe used to decide whether a conversation title is still "auto" (and thus
 * safe to upgrade) — keep this the single source of truth for both.
 */
export function computeAutoTitle(text: string): string {
  const raw = text.replace(/\s+/g, ' ').trim();
  return raw.length > 30 ? raw.slice(0, 30) + '…' : raw;
}

/** Collapse to a single clean line: drop wrapping quotes / markdown / trailing
 *  punctuation / a leading「标题：」prefix, then cap length. */
export function sanitizeTitle(raw: string): string {
  let t = raw.replace(/\s+/g, ' ').trim();
  t = t.replace(/^#+\s*/, '');
  t = t.replace(/^(标题|title)\s*[:：]\s*/i, '');
  t = t.replace(/^["'「『《【(（]+/, '');
  // Strip a trailing run of quotes / brackets / punctuation, handling mixed
  // endings like 」。 in one pass.
  t = t.replace(/["'」』》】)）。.!！?？,，、;；:：]+$/, '');
  t = t.trim();
  if (t.length > 24) t = t.slice(0, 24).trim();
  return t;
}

function buildTitlePrompt(userText: string, assistantText: string): string {
  return [
    '为下面这段对话起一个简洁的中文标题，便于在历史列表里一眼辨认。',
    '要求：4 到 12 个字，名词短语，不要标点、不要引号、不要任何前缀，只输出标题本身。',
    '',
    `用户：${userText.slice(0, 500)}`,
    `助手：${assistantText.slice(0, 500)}`,
    '',
    '标题：',
  ].join('\n');
}

/** Still the auto truncation (or empty) → safe to upgrade. A manual rename or an
 *  already-upgraded AI title will not match and is left untouched. */
function titleIsStillAuto(currentTitle: string | null, userText: string): boolean {
  const current = (currentTitle ?? '').trim();
  return current === '' || current === computeAutoTitle(userText);
}

export async function runAutoTitle(input: ScheduleAutoTitleInput): Promise<void> {
  if (input.hermetic) return;
  if (input.memoriesRepo.getEffective(input.conversationId, LLM_AUTO_TITLE_ENABLED_KEY) !== 'true') return;
  if (input.userText.trim().length < 2) return;

  const conv = input.convRepo.get(input.conversationId);
  if (!conv || !titleIsStillAuto(conv.title, input.userText)) return;

  const model = input.modelsRepo.pickCheapestActive('chat', '__none__');
  if (!model?.provider_id) return;
  const provider = input.providersRepo.get(model.provider_id);
  if (!isProviderRunnable(provider)) return;

  let apiKey: string | null = null;
  if (provider.type === 'ollama') {
    apiKey = 'ollama-local';
  } else if (provider.api_key_ref) {
    try {
      apiKey = await input.keystore.read(provider.api_key_ref);
    } catch (err) {
      input.log.warn({ err, providerId: provider.id }, 'autotitle.keystore_read_failed');
      return;
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
    prompt: buildTitlePrompt(input.userText, input.assistantText),
    temperature: 0.3,
    maxTokens: 32,
  });
  const title = sanitizeTitle(result.text);
  if (title.length < 2) return;

  // Re-read before writing: a manual rename may have landed while we were waiting
  // on the model. Only overwrite if the title is still the auto truncation.
  const latest = input.convRepo.get(input.conversationId);
  if (!latest || !titleIsStillAuto(latest.title, input.userText)) return;
  input.convRepo.rename(input.conversationId, title);
}

/** Fire-and-forget, best-effort. Mirrors scheduleMemoryExtraction: a failed or
 *  skipped title generation must never affect the chat turn. */
export function scheduleAutoTitle(input: ScheduleAutoTitleInput): void {
  setImmediate(() => {
    void runAutoTitle(input).catch((err) => {
      input.log.warn({ err, conversationId: input.conversationId }, 'autotitle.failed');
    });
  });
}
