/**
 * QueryPlanner — LLM-driven search query generation.
 *
 * The legacy `buildSearchQueries` in planner.ts is fully template-based:
 * it bolts together (subject + reason hints + constraints + followup tracks)
 * into dense keyword bags. That works for DuckDuckGo and a handful of
 * canned reasons, but produces same-shape queries for every research
 * question — so when the question doesn't fit a hardcoded reason bucket,
 * the queries become generic and search coverage suffers.
 *
 * This module asks an LLM to produce 2-4 queries per question following the
 * **wide → narrow** heuristic (Anthropic's multi-agent research lesson):
 *   1. A wide reconnaissance query — broad terms, no site: operators
 *   2-4. Narrower targeted queries — specific vendors, official docs,
 *        third-party benchmarks, or non-Chinese-language variants
 *
 * It also returns a one-sentence `strategy` string the UI can render so
 * users see *why* the agent is searching this way (closes the "black box"
 * loop somewhat without doing a full narrative stream).
 *
 * Safety rails:
 * - Hermetic env var short-circuits to deterministic output for tests.
 * - Any LLM failure (no model, parse error, timeout) returns `ok: false`
 *   and the caller falls back to `buildSearchQueries` so we never break
 *   the search loop.
 */

import { generateText } from 'ai';
import type { ResearchSession } from '@taori/shared';
import { createChatModel } from '../providers/chat-model.js';
import type { MemoriesRepo, ModelsRepo, ProvidersRepo } from '../db/repos/index.js';
import type { KeyStore } from '../keystore.js';

export type QueryIntent =
  | 'wide_recon'
  | 'narrow_specific'
  | 'official_docs'
  | 'third_party_review'
  | 'comparison'
  | 'recovery';

export interface PlannedQuery {
  text: string;
  intent: QueryIntent;
}

export interface QueryPlanResult {
  ok: boolean;
  /** Final query strings, deduped + length-capped, in execution order. */
  queries: string[];
  /** Annotated queries (text + intent) for richer UI display. */
  annotated: PlannedQuery[];
  /** One-sentence narrative describing the plan, shown in the task list. */
  strategy: string;
  notes?: string[];
}

export interface QueryPlannerDeps {
  modelsRepo: ModelsRepo;
  providersRepo: ProvidersRepo;
  keystore?: KeyStore | null;
  memories?: MemoriesRepo | null;
  log?: { warn?: (msg: unknown, extra?: unknown) => void; error?: (msg: unknown, extra?: unknown) => void };
}

export interface GenerateLLMQueriesArgs {
  session: ResearchSession;
  question: { question: string; reason: string };
  budgetMode: ResearchSession['budget_mode'];
  /** When provided, the planner knows these have already been tried (used for
   * recovery and to avoid generating duplicates). */
  attemptedQueries?: string[];
  /** When true, builds a recovery-flavored prompt that asks for diversification
   * (different angles, sites, languages). */
  isRecovery?: boolean;
}

const QUERY_TIMEOUT_MS = 20_000;
const QUERY_OUTPUT_MAX_TOKENS = 600;
const MAX_QUERY_LENGTH = 160;

const QUERY_LIMIT_BY_MODE: Record<string, { primary: number; recovery: number }> = {
  fast: { primary: 2, recovery: 4 },
  balanced: { primary: 3, recovery: 6 },
  deep: { primary: 4, recovery: 8 },
  custom: { primary: 3, recovery: 6 },
};

export async function generateLLMQueries(
  args: GenerateLLMQueriesArgs,
  deps: QueryPlannerDeps,
): Promise<QueryPlanResult> {
  if (process.env.TAORI_HERMETIC_AI_PLANNER === '1' || process.env.TAORI_E2E_HERMETIC_WEB === '1') {
    return { ok: false, queries: [], annotated: [], strategy: '', notes: ['hermetic_skip'] };
  }
  const picked = await pickQueryModel(args.session, deps);
  if (!picked) {
    return { ok: false, queries: [], annotated: [], strategy: '', notes: ['no_usable_model'] };
  }

  const prompt = buildQueryPlannerPrompt(args);
  const { model: chatModel } = createChatModel({
    provider: picked.provider,
    model: picked.model,
    apiKey: picked.apiKey,
  });

  let text = '';
  try {
    const result = await generateText({
      model: chatModel,
      prompt,
      maxTokens: QUERY_OUTPUT_MAX_TOKENS,
      abortSignal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
    });
    text = result.text;
  } catch (err) {
    deps.log?.warn?.({ err, sessionId: args.session.id }, 'research.query_planner_failed');
    return { ok: false, queries: [], annotated: [], strategy: '', notes: ['llm_call_failed'] };
  }

  const parsed = parseQueryPlanResponse(text);
  if (!parsed) {
    return { ok: false, queries: [], annotated: [], strategy: '', notes: ['unparseable'] };
  }

  const limit = QUERY_LIMIT_BY_MODE[args.budgetMode] ?? { primary: 3, recovery: 6 };
  const cap = args.isRecovery ? limit.recovery : limit.primary;
  const blocked = new Set((args.attemptedQueries ?? []).map((q) => q.trim()).filter(Boolean));
  const deduped: PlannedQuery[] = [];
  const seen = new Set<string>();
  for (const q of parsed.queries) {
    const trimmed = q.text.trim().slice(0, MAX_QUERY_LENGTH);
    if (!trimmed || seen.has(trimmed) || blocked.has(trimmed)) continue;
    seen.add(trimmed);
    deduped.push({ text: trimmed, intent: q.intent });
    if (deduped.length >= cap) break;
  }
  if (deduped.length === 0) {
    return { ok: false, queries: [], annotated: [], strategy: parsed.strategy, notes: ['all_queries_filtered'] };
  }
  return {
    ok: true,
    queries: deduped.map((q) => q.text),
    annotated: deduped,
    strategy: parsed.strategy,
  };
}

async function pickQueryModel(
  session: ResearchSession,
  deps: QueryPlannerDeps,
): Promise<{ model: import('@taori/shared').Model; provider: import('@taori/shared').Provider; apiKey: string } | null> {
  // Query generation is cheap & frequent — prefer the cheapest active chat
  // model rather than the synthesis model the user may have set to Opus.
  // Falls back to preferred / default chat in case the cheapest pick is
  // unconfigured.
  const candidateIds = [
    deps.memories?.getEffective(session.conversation_id ?? null, 'default_research_query_model') ?? null,
    deps.modelsRepo.pickCheapestActive('chat', '__none__')?.id ?? null,
    session.preferred_model_id,
    deps.modelsRepo.defaultFor('chat')?.id ?? null,
  ].filter((id): id is string => typeof id === 'string' && id.length > 0);

  for (const id of candidateIds) {
    const model = deps.modelsRepo.get(id);
    if (!model?.enabled || !model.provider_id) continue;
    const provider = deps.providersRepo.get(model.provider_id);
    if (!provider) continue;
    let apiKey = '';
    if (provider.api_key_ref && deps.keystore) {
      try {
        apiKey = (await deps.keystore.read(provider.api_key_ref)) ?? '';
      } catch {
        // key unavailable
      }
      if (!apiKey.trim()) continue;
    }
    return { model, provider, apiKey };
  }
  return null;
}

export function buildQueryPlannerPrompt(args: GenerateLLMQueriesArgs): string {
  const { session, question, isRecovery } = args;
  const constraints: string[] = [];
  if (session.constraints.time_range) constraints.push(`时间范围：${session.constraints.time_range}`);
  if (session.constraints.region) constraints.push(`区域：${session.constraints.region}`);
  if (session.constraints.language) constraints.push(`语言：${session.constraints.language}`);
  if ((session.constraints.must_cover ?? []).length > 0) {
    constraints.push(`必须覆盖：${session.constraints.must_cover.join('、')}`);
  }
  const constraintsBlock = constraints.length > 0 ? `\n约束：${constraints.join('；')}` : '';

  const attempted = (args.attemptedQueries ?? []).filter(Boolean).slice(0, 8);
  const attemptedBlock = attempted.length > 0
    ? `\n\n【已尝试过但失败的 query】\n${attempted.map((q, i) => `${i + 1}. ${q}`).join('\n')}\n请避开这些角度，换思路。`
    : '';

  const recoveryHint = isRecovery
    ? `当前是 recovery 阶段（首轮检索零结果或覆盖不足）。请大幅换角度：
- 换更具体的厂商名 / 产品名
- 加 site: 限定到官方/文档/状态页域名
- 写一条英文 query（许多技术内容只在英文资料里）
- 拆出对比研究里的单个对象，逐个查`
    : `请按"wide → narrow"的阶梯出 2-4 条 query：
- 第 1 条：宽广探查（broad terms，不要 site: 限定），目的是先确认这个问题里有哪些主要玩家/概念
- 第 2-N 条：根据题目特点，针对性地查官方文档、第三方评测、对比基准、具体厂商，等等`;

  return `你是研究检索策略师。你的任务是为一个研究子问题设计搜索查询，让通用搜索引擎（DuckDuckGo / Exa / 搏查 / Bing）能高质量地命中。

【研究主题】${session.title}
【研究目标】${session.objective}${constraintsBlock}

【当前子问题】${question.question}
【为什么要查这个】${question.reason}${attemptedBlock}

━━━ 设计要求 ━━━

${recoveryHint}

通用规则：
- 每条 query ≤80 字符；不要把所有关键词都堆一条里
- 善用 site:domain 限定到权威源（官方文档、status 页、统计局、benchmark 站）
- 如果约束写了"中文+英文"或"近 X 个月"，至少有一条 query 体现时间/语言限定
- 避免完全照搬子问题原文——那只是题面，不是好 query
- 不要重复已尝试过的 query

━━━ 输出 ━━━

严格输出 JSON（无任何 Markdown、注释或额外文字）：

{
  "strategy": "用一句话（≤60字）说明你打算怎么搜，比如：先用 broad 中文查清楚主要玩家，再针对前三家查官方定价",
  "queries": [
    { "text": "...", "intent": "wide_recon" }
  ]
}

intent 取值：wide_recon / narrow_specific / official_docs / third_party_review / comparison / recovery`;
}

interface ParsedPlan {
  strategy: string;
  queries: PlannedQuery[];
}

export function parseQueryPlanResponse(text: string): ParsedPlan | null {
  if (!text) return null;
  const cleaned = text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
  const jsonStart = cleaned.indexOf('{');
  const jsonEnd = cleaned.lastIndexOf('}');
  if (jsonStart === -1 || jsonEnd === -1) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(cleaned.slice(jsonStart, jsonEnd + 1));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  const strategy = typeof rec.strategy === 'string' ? rec.strategy.trim().slice(0, 200) : '';
  const queriesRaw = Array.isArray(rec.queries) ? rec.queries : [];
  const queries: PlannedQuery[] = [];
  for (const q of queriesRaw) {
    if (!q || typeof q !== 'object' || Array.isArray(q)) continue;
    const qRec = q as Record<string, unknown>;
    const queryText = typeof qRec.text === 'string'
      ? qRec.text
      : typeof qRec.query === 'string' // tolerate the alt field name
        ? qRec.query
        : '';
    if (!queryText.trim()) continue;
    queries.push({
      text: queryText.trim(),
      intent: normalizeIntent(qRec.intent),
    });
    if (queries.length >= 8) break;
  }
  if (queries.length === 0) return null;
  return { strategy: strategy || '由 LLM 规划的多轮检索', queries };
}

function normalizeIntent(value: unknown): QueryIntent {
  if (
    value === 'wide_recon'
    || value === 'narrow_specific'
    || value === 'official_docs'
    || value === 'third_party_review'
    || value === 'comparison'
    || value === 'recovery'
  ) {
    return value;
  }
  return 'narrow_specific';
}
