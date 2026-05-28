/**
 * Research task handler: reflect on source coverage and schedule follow-ups.
 *
 * Extracted from ResearchRunner.runReflect. Uses the synthesis model to
 * assess which research questions are still under-covered, then inserts
 * targeted follow-up search tasks.
 */

import { generateText } from 'ai';
import type { ResearchSession, ResearchSource, ResearchTask } from '@taori/shared';
import type { CapabilityBus } from '../../bus/index.js';
import type { MemoriesRepo, ModelsRepo, ProvidersRepo, ResearchRepo } from '../../db/repos/index.js';
import type { KeyStore } from '../../keystore.js';
import { createChatModel } from '../../providers/chat-model.js';
import { pickSynthesisModel } from './shared.js';
import { pickPreferredSearchToolName } from '../../search/tool-selection.js';

export interface ReflectHandlerDeps {
  repo: ResearchRepo;
  bus: CapabilityBus;
  modelsRepo?: ModelsRepo;
  providersRepo?: ProvidersRepo;
  keystore?: KeyStore;
  memories?: MemoriesRepo;
  log?: { info?: (msg: unknown, extra?: unknown) => void; warn?: (msg: unknown, extra?: unknown) => void; error?: (msg: unknown, extra?: unknown) => void };
}

// ─── Reflect result types ──────────────────────────────────────────────────

interface ReflectCoverageItem {
  question_id: string;
  level: 'good' | 'partial' | 'missing';
  what_we_know: string;
  what_is_missing: string;
}

interface ReflectFollowUp {
  topic: string;
  query: string;
}

interface ReflectResult {
  coverage: ReflectCoverageItem[];
  follow_up_searches: ReflectFollowUp[];
}

// ─── Handler ───────────────────────────────────────────────────────────────

export async function runReflect(
  deps: ReflectHandlerDeps,
  session: ResearchSession,
  task: ResearchTask,
): Promise<void> {
  if (!deps.modelsRepo || !deps.providersRepo) {
    deps.repo.updateTask(task.id, { output: { skipped: true, reason: 'no_model_deps' } });
    return;
  }
  const sources = deps.repo.listSources(session.id);
  if (sources.length === 0) {
    deps.repo.updateTask(task.id, { output: { skipped: true, reason: 'no_sources' } });
    return;
  }

  const rawQuestions = Array.isArray(task.input?.questions) ? task.input.questions as Array<{ id: string; question: string; reason: string }> : [];
  const maxFollowUps = typeof task.input?.max_follow_ups === 'number' ? task.input.max_follow_ups : 2;
  const currentRound = typeof task.input?.reflect_round === 'number' ? task.input.reflect_round : 1;
  const maxRounds = session.budget_mode === 'deep' ? 3 : 2;

  let chatModel: ReturnType<typeof createChatModel>['model'] | null = null;
  try {
    const picked = await pickSynthesisModel(
      session,
      deps.modelsRepo,
      deps.providersRepo,
      deps.keystore ?? null,
      deps.memories ?? null,
    );
    if (picked) {
      chatModel = createChatModel({ provider: picked.provider, model: picked.model, apiKey: picked.apiKey }).model;
    }
  } catch {
    // ignore model errors; just skip reflect
  }

  if (!chatModel) {
    deps.repo.updateTask(task.id, { output: { skipped: true, reason: 'no_usable_model' } });
    return;
  }

  const prompt = buildReflectPrompt(session, rawQuestions, sources);
  let reflectResult: ReflectResult | null = null;
  try {
    const { text } = await generateText({
      model: chatModel,
      prompt,
      maxTokens: 1500,
      abortSignal: AbortSignal.timeout(25_000),
    });
    reflectResult = parseReflectResponse(text);
  } catch (err) {
    deps.log?.warn?.({ err, sessionId: session.id }, 'research.reflect_failed');
  }

  if (!reflectResult || reflectResult.follow_up_searches.length === 0) {
    deps.repo.updateTask(task.id, { output: { skipped: true, reason: 'no_gaps_identified', raw: reflectResult } });
    return;
  }

  // Insert targeted follow-up search tasks before the summarize task.
  // They will be picked up by the main loop (batch-parallel) in the next tick.
  const searchToolName = pickPreferredSearchToolName(
    deps.bus,
    session.preferred_search_tool ?? deps.memories?.getEffective(session.conversation_id ?? null, 'default_search_tool'),
    deps.bus.list().map((tool) => tool.name),
  ) ?? 'builtin.web_search';

  const followUps = reflectResult.follow_up_searches.slice(0, maxFollowUps);
  const addedTasks: string[] = [];
  for (const gap of followUps) {
    if (!gap.query?.trim()) continue;
    const inserted = deps.repo.insertTask(session.id, {
      kind: 'search',
      status: 'queued',
      title: `补充检索（第${currentRound}轮）：${gap.topic ?? gap.query}`,
      input: {
        question: gap.topic ?? gap.query,
        reason: '信息空白补充',
        query: gap.query,
        is_follow_up: true,
        reflect_round: currentRound,
        search_tool: searchToolName,
      },
    });
    addedTasks.push(inserted.id);
  }

  // If there are gaps and we haven't hit the reflect round cap, schedule another reflect pass
  // after the follow-up searches complete. This creates an organic multi-round loop.
  const hasPartialOrMissing = reflectResult.coverage.some((c) => c.level !== 'good');
  if (hasPartialOrMissing && currentRound < maxRounds && followUps.length > 0) {
    deps.repo.insertTask(session.id, {
      kind: 'reflect',
      status: 'queued',
      title: `深度反思（第${currentRound + 1}轮）`,
      input: {
        questions: rawQuestions,
        max_follow_ups: maxFollowUps,
        reflect_round: currentRound + 1,
      },
    });
  }

  deps.repo.updateTask(task.id, {
    output: {
      coverage: reflectResult.coverage,
      follow_up_searches: followUps,
      added_tasks: addedTasks,
      reflect_round: currentRound,
      next_round_scheduled: hasPartialOrMissing && currentRound < maxRounds && followUps.length > 0,
    },
  });
}

// ─── Prompt builder ────────────────────────────────────────────────────────

function buildReflectPrompt(
  session: ResearchSession,
  questions: Array<{ id: string; question: string; reason: string }>,
  sources: ResearchSource[],
): string {
  const questionLines = questions
    .map((q, i) => `${i + 1}. [${q.id}] ${q.question}（${q.reason}）`)
    .join('\n');

  // Group sources by question for the prompt
  const grouped = questions.map((q) => {
    const qSources = sources.filter((s) => {
      const qid = typeof s.metadata?.question_id === 'string' ? s.metadata.question_id : null;
      const qids = Array.isArray(s.metadata?.question_ids) ? s.metadata.question_ids as string[] : [];
      return qid === q.id || qids.includes(q.id);
    });
    if (qSources.length === 0) return `[${q.id}] ${q.question}\n  → 未找到相关资料`;
    const summaries = qSources.slice(0, 5).map((s) => {
      const title = (s.title ?? s.locator).slice(0, 120);
      const snippet = (s.snippet ?? '').slice(0, 400).replace(/\s+/g, ' ');
      return `  - ${title}: ${snippet || '（无摘要）'}`;
    }).join('\n');
    return `[${q.id}] ${q.question}\n${summaries}`;
  }).join('\n\n');

  return `你是一名专业研究分析师，正在评估一项深度研究的当前信息覆盖情况。

研究主题：${session.title}
研究目标：${session.objective}

关键研究问题：
${questionLines}

当前已收集的资料摘要（按问题分组）：
${grouped}

---

请评估每个问题的信息覆盖情况，并识别最重要的信息空白，以便进行补充检索。

严格按照以下 JSON 格式输出（不要包含任何其他文字）：
{
  "coverage": [
    {
      "question_id": "q1",
      "level": "good",
      "what_we_know": "已掌握的核心内容（30字以内）",
      "what_is_missing": "仍缺少什么信息（30字以内，good级别可写'覆盖充分'）"
    }
  ],
  "follow_up_searches": [
    {
      "topic": "具体缺少的信息描述",
      "query": "用于补充检索的搜索词（英文或中文，适合搜索引擎）"
    }
  ]
}

要求：
- coverage 包含所有问题的评估，level 为 good/partial/missing 之一
- follow_up_searches 只包含 level 为 partial 或 missing 的最重要补充，最多 3 条
- 如果覆盖已经充分，follow_up_searches 可以为空数组 []
- 搜索词要具体、可操作，适合直接输入搜索引擎
- 如果问题涉及"中国主流大模型 API"这类宽表对比，优先把补搜拆成具体厂商 + 指标（如 DeepSeek 定价、豆包 首token延迟），不要继续输出笼统的总表查询`;
}

// ─── Response parser ───────────────────────────────────────────────────────

function parseReflectResponse(text: string): ReflectResult | null {
  try {
    const cleaned = text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
    const jsonStart = cleaned.indexOf('{');
    const jsonEnd = cleaned.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd === -1) return null;
    const raw = JSON.parse(cleaned.slice(jsonStart, jsonEnd + 1)) as Record<string, unknown>;

    const coverage: ReflectCoverageItem[] = [];
    if (Array.isArray(raw.coverage)) {
      for (const item of raw.coverage) {
        if (typeof item !== 'object' || item === null) continue;
        const c = item as Record<string, unknown>;
        if (typeof c.question_id !== 'string') continue;
        coverage.push({
          question_id: c.question_id,
          level: (c.level === 'good' || c.level === 'partial' || c.level === 'missing') ? c.level : 'partial',
          what_we_know: typeof c.what_we_know === 'string' ? c.what_we_know.slice(0, 200) : '',
          what_is_missing: typeof c.what_is_missing === 'string' ? c.what_is_missing.slice(0, 200) : '',
        });
      }
    }

    const followUps: ReflectFollowUp[] = [];
    if (Array.isArray(raw.follow_up_searches)) {
      for (const item of raw.follow_up_searches) {
        if (typeof item !== 'object' || item === null) continue;
        const f = item as Record<string, unknown>;
        if (typeof f.query !== 'string' || !f.query.trim()) continue;
        followUps.push({
          topic: typeof f.topic === 'string' ? f.topic.slice(0, 200) : f.query,
          query: f.query.trim().slice(0, 200),
        });
      }
    }

    return { coverage, follow_up_searches: followUps };
  } catch {
    return null;
  }
}
