import { generateText } from 'ai';
import type { ResearchPlan, ResearchSession, PlanMessage } from '@taori/shared';
import { ResearchPlanSchema } from '@taori/shared';
import type { MemoriesRepo, ModelsRepo, ProvidersRepo } from '../db/repos/index.js';
import type { KeyStore } from '../keystore.js';
import { createChatModel } from '../providers/chat-model.js';

export interface AIPlannerDeps {
  modelsRepo: ModelsRepo;
  providersRepo: ProvidersRepo;
  keystore: KeyStore;
  memories?: MemoriesRepo;
  log?: { error: (msg: string, ...args: unknown[]) => void };
}

async function pickPlannerModel(session: ResearchSession, deps: AIPlannerDeps) {
  try {
    const preferredId =
      session.preferred_model_id
      ?? deps.memories?.getEffective(session.conversation_id ?? null, 'default_model_id')
      ?? null;
    const candidateIds = [
      preferredId,
      deps.modelsRepo.defaultFor('chat')?.id ?? null,
      deps.modelsRepo.pickCheapestActive('chat', '__none__')?.id ?? null,
    ].filter((value): value is string => typeof value === 'string' && value.length > 0);

    const orderedModels = [
      ...candidateIds
        .map((id) => deps.modelsRepo.get(id))
        .filter((model): model is NonNullable<ReturnType<ModelsRepo['get']>> => Boolean(model)),
      ...deps.modelsRepo
        .list()
        .filter((model) => model.capability === 'chat' && model.enabled && model.provider_id != null),
    ].filter((model, index, arr) => arr.findIndex((item) => item.id === model.id) === index);

    for (const model of orderedModels) {
      if (!model.provider_id) continue;
      const provider = deps.providersRepo.get(model.provider_id);
      if (!provider) continue;
      let apiKey = '';
      if (provider.api_key_ref) {
        apiKey = (await deps.keystore.read(provider.api_key_ref)) ?? '';
        if (!apiKey.trim()) continue;
      }
      const { model: chatModel } = createChatModel({ provider, model, apiKey });
      return chatModel;
    }
    return null;
  } catch {
    return null;
  }
}

export async function generateAIPlan(
  session: ResearchSession,
  deps: AIPlannerDeps,
): Promise<ResearchPlan | null> {
  const model = await pickPlannerModel(session, deps);
  if (!model) return null;

  const prompt = buildPlannerPrompt(session);
  try {
    const abort = AbortSignal.timeout(15_000);
    const { text } = await generateText({ model, prompt, maxTokens: 2000, abortSignal: abort });
    return parseAIPlanResponse(text, session);
  } catch (err) {
    deps.log?.error('AI plan generation failed', err);
    return null;
  }
}

export async function revisePlan(
  session: ResearchSession,
  feedback: string,
  deps: AIPlannerDeps,
): Promise<{ plan: ResearchPlan; assistantMessage: string } | null> {
  const model = await pickPlannerModel(session, deps);
  if (!model) return null;

  const prompt = buildRevisionPrompt(session, feedback);
  try {
    const abort = AbortSignal.timeout(15_000);
    const { text } = await generateText({ model, prompt, maxTokens: 2000, abortSignal: abort });
    const plan = parseAIPlanResponse(text, session);
    if (!plan) return null;
    const assistantMessage = plan.summary;
    return { plan, assistantMessage };
  } catch (err) {
    deps.log?.error('AI plan revision failed', err);
    return null;
  }
}

function buildPlannerPrompt(session: ResearchSession): string {
  const kindLabel = (
    { report: '研究报告', brief: '简报', comparison: '对比分析', decision: '决策建议' } as Record<string, string>
  )[session.output_kind] ?? '研究报告';
  const budgetLabel = (
    { fast: '快速（少量搜索）', balanced: '均衡（中等深度）', deep: '深入（充分研究）', custom: '自定义' } as Record<string, string>
  )[session.budget_mode] ?? '均衡';
  const constraints: string[] = [];
  if (session.constraints.time_range) constraints.push(`时间范围：${session.constraints.time_range}`);
  if (session.constraints.region) constraints.push(`区域：${session.constraints.region}`);
  if (session.constraints.language) constraints.push(`语言：${session.constraints.language}`);
  if ((session.constraints.must_cover ?? []).length > 0) constraints.push(`必须覆盖：${session.constraints.must_cover.join('、')}`);
  const constraintStr = constraints.length > 0 ? `\n约束条件：${constraints.join('；')}` : '';
  const history = buildPlanningHistory(session.plan_messages);

  return `你是一位专业的研究规划师，擅长把模糊的研究目标拆解为清晰、可执行的研究计划。

用户希望开展以下深度研究：
研究主题：${session.title}
研究目标：${session.objective}
输出形式：${kindLabel}
研究深度：${budgetLabel}${constraintStr}${history}

请生成一份详细的研究计划，以 JSON 格式输出（不要有任何额外文字）：
{
  "summary": "一段简洁的研究方向与目标说明（100-300字），清楚描述本次研究的核心问题和预期产出",
  "key_questions": [
    {
      "question": "具体、可检索的研究问题（20-100字）",
      "reason": "研究这个问题的原因（15-60字）"
    }
  ],
  "stop_conditions": [
    "清晰的研究停止条件（10-100字）"
  ]
}

要求：
- key_questions 包含 3-6 个聚焦的研究问题，每个问题应该能够独立搜索验证
- stop_conditions 包含 2-4 条具体的停止条件
- 直接输出 JSON，不要包裹在代码块中`;
}

function buildRevisionPrompt(session: ResearchSession, feedback: string): string {
  const msgs = (session.plan_messages ?? []) as PlanMessage[];
  const history = buildPlanningHistory(msgs);
  const currentQuestions = (session.plan?.key_questions ?? [])
    .map((q, i) => `${i + 1}. ${q.question}（${q.reason}）`)
    .join('\n');

  return `你是一位专业的研究规划师。用户对研究计划有调整意见，请根据反馈修订计划。

研究主题：${session.title}
研究目标：${session.objective}

当前计划摘要：${session.plan?.summary ?? '（暂无）'}

当前关键问题：
${currentQuestions || '（暂无）'}
${history}

用户最新反馈：${feedback}

请根据用户反馈修订研究计划，以 JSON 格式输出（不要有任何额外文字）：
{
  "summary": "修订后的研究方向与目标说明",
  "key_questions": [
    {
      "question": "具体的研究问题",
      "reason": "为什么要研究这个问题"
    }
  ],
  "stop_conditions": [
    "停止条件"
  ]
}`;
}

function parseAIPlanResponse(text: string, session: ResearchSession): ResearchPlan | null {
  try {
    const cleaned = text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
    const jsonStart = cleaned.indexOf('{');
    const jsonEnd = cleaned.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd === -1) return null;
    const jsonText = cleaned.slice(jsonStart, jsonEnd + 1);
    const raw = JSON.parse(jsonText) as Record<string, unknown>;

    const rawQs = Array.isArray(raw.key_questions) ? (raw.key_questions as unknown[]) : [];
    const key_questions = rawQs.slice(0, 8).map((q, i) => {
      const qObj = typeof q === 'object' && q !== null ? (q as Record<string, unknown>) : {};
      return {
        id: `q${i + 1}`,
        question: typeof qObj.question === 'string' ? qObj.question.trim().slice(0, 240) : '',
        reason: typeof qObj.reason === 'string' ? qObj.reason.trim().slice(0, 240) : '研究需要',
      };
    }).filter((q) => q.question.length > 0);

    if (key_questions.length === 0) return null;

    const rawConds = Array.isArray(raw.stop_conditions) ? (raw.stop_conditions as unknown[]) : [];
    const stop_conditions = rawConds
      .slice(0, 8)
      .map((c) => (typeof c === 'string' ? c.trim().slice(0, 240) : ''))
      .filter((c) => c.length > 0);
    if (stop_conditions.length === 0) {
      stop_conditions.push('完成关键问题的首轮证据搜集后先停一次，等待人工确认方向。');
    }

    const summary = typeof raw.summary === 'string' && raw.summary.trim() ? raw.summary.trim().slice(0, 1000) : null;
    if (!summary) return null;

    const plan: ResearchPlan = {
      summary,
      output_kind: session.output_kind,
      budget_mode: session.budget_mode,
      key_questions,
      stages: [
        { id: 'scoping', title: '选题澄清', objective: '明确研究边界、输出目标与必须覆盖的问题。', deliverable: '范围说明与研究目标' },
        { id: 'planning', title: '研究计划', objective: '确认关键问题、检索顺序与停止条件。', deliverable: '研究计划与任务清单' },
        { id: 'searching', title: '检索抓取', objective: '分批搜索网页、抓取资料并记录候选来源。', deliverable: '候选来源列表' },
        { id: 'synthesizing', title: '证据整理', objective: '归纳事实、标记冲突并组织章节结构。', deliverable: '证据卡片与主张草稿' },
        { id: 'verifying', title: '引用校验', objective: '检查关键主张是否有来源支撑、是否仍需补证。', deliverable: '风险/待确认项' },
      ],
      stop_conditions,
    };

    return ResearchPlanSchema.safeParse(plan).success ? plan : null;
  } catch {
      return null;
  }
}

function buildPlanningHistory(messages: PlanMessage[] | null | undefined): string {
  const msgs = (messages ?? []).filter((item) => item?.content?.trim());
  if (msgs.length === 0) return '';
  return '\n\n对话澄清：\n' + msgs.map((m) => `${m.role === 'user' ? '用户' : '规划师'}：${m.content}`).join('\n\n');
}
