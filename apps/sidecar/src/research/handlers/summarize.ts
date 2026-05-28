/**
 * Research task handler: summarize collected sources into a draft.
 *
 * Extracted from ResearchRunner.runSummarize + streamSynthesisToDraft.
 * When model deps are available, streams an LLM synthesis into
 * `draft_markdown` with incremental flushing. Falls back to a template-based
 * draft otherwise.
 */

import { streamText } from 'ai';
import type {
  ResearchPlan,
  ResearchSession,
  ResearchSource,
} from '@taori/shared';
import type { MemoriesRepo, ModelsRepo, ProvidersRepo, ResearchRepo } from '../../db/repos/index.js';
import type { KeyStore } from '../../keystore.js';
import { createChatModel } from '../../providers/chat-model.js';
import { pickSynthesisModel, buildDraft } from './shared.js';

export interface SummarizeHandlerDeps {
  repo: ResearchRepo;
  modelsRepo?: ModelsRepo;
  providersRepo?: ProvidersRepo;
  keystore?: KeyStore;
  memories?: MemoriesRepo;
  log?: { info?: (msg: unknown, extra?: unknown) => void; warn?: (msg: unknown, extra?: unknown) => void; error?: (msg: unknown, extra?: unknown) => void };
}

export async function runSummarize(
  deps: SummarizeHandlerDeps,
  session: ResearchSession,
): Promise<void> {
  const plan = session.plan;
  if (!plan) return;
  const sources = deps.repo.listSources(session.id);

  // Attempt streaming LLM synthesis when model deps are available. Streaming
  // matters because synthesis can take 30-90s -- flushing partial markdown
  // every ~200 chars or 1s lets the UI render the draft as it lands instead
  // of staring at a blank pane.
  if (deps.modelsRepo && deps.providersRepo) {
    try {
      const picked = await pickSynthesisModel(
        session,
        deps.modelsRepo,
        deps.providersRepo,
        deps.keystore ?? null,
        deps.memories ?? null,
      );
      if (picked) {
        const { model: chatModel } = createChatModel({
          provider: picked.provider,
          model: picked.model,
          apiKey: picked.apiKey,
        });
        const prompt = buildSynthesisPrompt(session, plan, sources);
        const accumulated = await streamSynthesisToDraft(deps.repo, session.id, chatModel, prompt, deps.log);
        if (accumulated && accumulated.trim().length > 100) {
          deps.repo.update(session.id, { draft_markdown: accumulated.trim() });
          return;
        }
      }
    } catch (err) {
      deps.log?.warn?.({ err, sessionId: session.id }, 'research.llm_synthesis_failed');
    }
  }

  // Fallback: template-based draft
  const draft = buildDraft(session, plan, sources);
  deps.repo.update(session.id, { draft_markdown: draft });
}

// ─── Streaming helper ──────────────────────────────────────────────────────

/**
 * Stream synthesis output, flushing the rolling buffer to draft_markdown
 * every ~200 chars or 1 second. Returns the final accumulated text even if
 * the stream is interrupted mid-way (so partial drafts aren't lost).
 */
async function streamSynthesisToDraft(
  repo: ResearchRepo,
  sessionId: string,
  chatModel: ReturnType<typeof createChatModel>['model'],
  prompt: string,
  log?: { warn?: (msg: unknown, extra?: unknown) => void },
): Promise<string> {
  let buf = '';
  let lastFlushLen = 0;
  let lastFlushAt = Date.now();
  try {
    const { textStream } = streamText({
      model: chatModel,
      prompt,
      maxTokens: 8192,
      abortSignal: AbortSignal.timeout(120_000),
    });
    for await (const chunk of textStream) {
      buf += chunk;
      const sizeDelta = buf.length - lastFlushLen;
      const timeDelta = Date.now() - lastFlushAt;
      if (sizeDelta >= 200 || timeDelta >= 1000) {
        repo.update(sessionId, { draft_markdown: buf });
        lastFlushLen = buf.length;
        lastFlushAt = Date.now();
      }
    }
  } catch (err) {
    log?.warn?.({ err, sessionId }, 'research.synthesis_stream_interrupted');
    // Fall through -- return whatever we accumulated so the caller can
    // decide between using the partial draft and the template fallback.
  }
  if (buf.length > lastFlushLen) {
    repo.update(sessionId, { draft_markdown: buf });
  }
  return buf;
}

// ─── Synthesis prompt builder ──────────────────────────────────────────────

function buildSynthesisPrompt(
  session: ResearchSession,
  plan: ResearchPlan,
  sources: ResearchSource[],
): string {
  const kindLabel: Record<string, string> = {
    report: '综合研究报告',
    brief: '简报（摘要 + 关键事实 + 风险 + 下一步行动）',
    comparison: '对比分析（各方案横向对比 + 建议）',
    decision: '决策建议（结论 + 依据 + 可选路径 + 执行建议）',
  };
  const structureGuide: Record<string, string> = {
    report: '## 执行摘要\n\n## 核心发现\n\n## 详细分析\n\n## 矛盾与争议\n\n## 不确定性与局限\n\n## 风险\n\n## 建议与后续步骤',
    brief: '## 摘要（3-5 句话）\n\n## 关键事实\n\n## 风险\n\n## 下一步行动',
    comparison: '## 结论（哪种方案更合适，一句话）\n\n## 关键维度对比表\n\n## 各方案深度分析\n\n## 矛盾与数据分歧\n\n## 风险与注意事项\n\n## 选择建议（按场景分类）',
    decision: '## 推荐结论（直接给出答案）\n\n## 决策依据\n\n## 可选路径对比\n\n## 矛盾与数据分歧\n\n## 风险与前提条件\n\n## 执行建议',
  };
  const kind = plan.output_kind ?? 'report';
  // Prefer both credibility and recency so"当前主流/当前定价"不容易被旧资料盖过去。
  const sortedSources = [...sources].sort((a, b) => sourceSortScore(b) - sourceSortScore(a));

  // Group sources by question for better LLM comprehension
  const sourcesByQuestion = new Map<string, ResearchSource[]>();
  const unassignedSources: ResearchSource[] = [];

  for (const source of sortedSources) {
    const qid = typeof source.metadata?.question_id === 'string' ? source.metadata.question_id : null;
    const qids = Array.isArray(source.metadata?.question_ids) ? source.metadata.question_ids as string[] : [];
    const allQids = new Set([...(qid ? [qid] : []), ...qids]);
    if (allQids.size === 0) {
      unassignedSources.push(source);
    } else {
      for (const id of allQids) {
        if (!sourcesByQuestion.has(id)) sourcesByQuestion.set(id, []);
        sourcesByQuestion.get(id)!.push(source);
      }
    }
  }

  let globalIndex = 1;
  const sourceIndexMap = new Map<string, number>();

  function credibilityTag(score: number | null | undefined): string {
    const s = score ?? 0.5;
    if (s >= 0.85) return '★高可信';
    if (s >= 0.7) return '★中等';
    return '';
  }

  const questionsText = plan.key_questions.map((q) => {
    const qSources = sourcesByQuestion.get(q.id) ?? [];
    const sourceLines = qSources.map((s) => {
      if (!sourceIndexMap.has(s.id)) sourceIndexMap.set(s.id, globalIndex++);
      const idx = sourceIndexMap.get(s.id)!;
      const title = (s.title ?? s.locator).slice(0, 200);
      const snippet = (s.snippet ?? '').slice(0, 1500).replace(/\s+/g, ' ');
      const tag = credibilityTag(s.credibility_score);
      const year = inferSourceYear(s);
      return `  [${idx}]${tag ? ` ${tag}` : ''}${year ? ` [年份:${year}]` : ''} 标题：${title}\n      来源：${s.locator}\n      内容：${snippet || '（无摘要）'}`;
    }).join('\n\n');
    return `【问题 ${q.id}：${q.question}（${q.reason}）】\n${sourceLines || '  （本问题未找到对应资料）'}`;
  }).join('\n\n---\n\n');

  // Any sources not linked to a specific question
  const unassignedText = unassignedSources.length > 0
    ? '\n\n【其他相关资料】\n' + unassignedSources.map((s) => {
        if (!sourceIndexMap.has(s.id)) sourceIndexMap.set(s.id, globalIndex++);
        const idx = sourceIndexMap.get(s.id)!;
        const title = (s.title ?? s.locator).slice(0, 200);
        const snippet = (s.snippet ?? '').slice(0, 800).replace(/\s+/g, ' ');
        const tag = credibilityTag(s.credibility_score);
        const year = inferSourceYear(s);
        return `  [${idx}]${tag ? ` ${tag}` : ''}${year ? ` [年份:${year}]` : ''} 标题：${title}\n      来源：${s.locator}\n      内容：${snippet || '（无摘要）'}`;
      }).join('\n\n')
    : '';

  const totalSources = sourceIndexMap.size + unassignedSources.filter(s => !sourceIndexMap.has(s.id)).length;

  const kindSpecificInstructions = kind === 'comparison'
    ? `对比分析报告要求：
- 必须用 Markdown 表格展示关键维度对比（列 = 各方案，行 = 各维度）
- 表格后逐方案深入分析，不只是表格总结
- 明确指出哪些数据来自官方、哪些是第三方评测
- 给出按不同使用场景的选型建议（不同团队规模/预算/需求）`
    : kind === 'decision'
    ? `决策建议报告要求：
- 开头直接给出"推荐使用 X"或"不建议现在做 Y"的明确结论
- 决策树或条件式建议：列出"如果你的情况是 A，则选 X；如果是 B，则选 Y"
- 明确列出推荐的前提条件和风险假设
- 对不推荐选项说明具体原因`
    : kind === 'brief'
    ? `简报要求：
- 摘要控制在 5 句话以内，高度精炼
- 关键事实用 bullet point 列出，每条一个独立可操作的信息点
- 风险按优先级排序`
    : `综合报告要求：
- 执行摘要要能让忙碌的决策者在 30 秒内理解全文结论
- 详细分析部分按证据强度分层：强证据 -> 弱证据 -> 推断
- 对有争议的点要平衡呈现多方观点`;

  return `你是一名顶级研究分析师，具备以下专业能力：多源信息综合、证据可信度评估、矛盾识别与调和、深度洞察提炼。

【研究主题】${session.title}
【研究目标】${session.objective}
【输出类型】${kindLabel[kind] ?? kindLabel.report}
【研究计划摘要】${plan.summary}

━━━ 收集到的研究资料（共 ${totalSources} 条来源，按可信度排序）━━━

${questionsText}${unassignedText}

━━━ 分析任务 ━━━

请完成以下三步分析，然后输出最终报告：

第一步（不要输出）：对每个研究问题，梳理已知事实、识别不同来源间的矛盾或分歧。
第二步（不要输出）：评估证据质量，标注哪些结论有强支撑，哪些是推断或待验证。
第三步：基于前两步，撰写完整的 Markdown 报告。

━━━ 最终报告格式 ━━━

# ${session.title}

${structureGuide[kind] ?? structureGuide.report}

## 参考来源

━━━ 撰写要求 ━━━

${kindSpecificInstructions}

通用要求：
- 每个重要论断用 [[序号]](URL) 格式内联引用来源，例如 [[1]](https://example.com)
- 当不同来源说法存在矛盾时，必须在"矛盾与数据分歧"或正文中明确指出，分析可能原因
- 信息不足之处说明"已知：X，尚不确定：Y"，不要回避或跳过
- ★高可信 标记的来源优先引用；多个来源一致时，说明"多来源一致"以增强说服力
- 如果问题强调"当前/主流/最新/近 12 个月"，优先采用年份更新、能代表当前产品状态的来源；引用旧型号、旧价格或旧能力时，必须明确年份并说明它是否仍是当前主推。
- 参考来源部分格式：[[序号]] 标题 — URL（每条一行）
- 内容必须基于提供的资料，禁止凭空发挥；资料不足之处明确标注，不要虚构数据`;
}

// ─── Small helpers local to synthesis ──────────────────────────────────────

function inferSourceYear(source: ResearchSource): number | null {
  const hay = `${source.title ?? ''} ${source.snippet ?? ''} ${source.locator}`;
  const years = Array.from(hay.matchAll(/\b(20\d{2})\b/g))
    .map((match) => Number(match[1]))
    .filter((year) => year >= 2020 && year <= 2100);
  return years.length > 0 ? Math.max(...years) : null;
}

function freshnessScore(source: ResearchSource): number {
  const year = inferSourceYear(source);
  if (!year) return 0;
  const currentYear = new Date().getFullYear();
  if (year >= currentYear) return 14;
  if (year === currentYear - 1) return 10;
  if (year === currentYear - 2) return 5;
  return 0;
}

function sourceSortScore(source: ResearchSource): number {
  return ((source.credibility_score ?? 0.5) * 100) + freshnessScore(source);
}
