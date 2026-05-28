import { generateText } from 'ai';
import type {
  ResearchPlan,
  ResearchPlanQuestionScope,
  ResearchSession,
  PlanMessage,
} from '@taori/shared';
import { ResearchPlanSchema } from '@taori/shared';
import type { MemoriesRepo, ModelsRepo, ProvidersRepo } from '../db/repos/index.js';
import type { KeyStore } from '../keystore.js';
import { createChatModel } from '../providers/chat-model.js';
import { buildResearchPlan } from './planner.js';
import type { SidecarTestHooksConfig } from '../config.js';

export interface AIPlannerDeps {
  modelsRepo: ModelsRepo;
  providersRepo: ProvidersRepo;
  keystore: KeyStore;
  memories?: MemoriesRepo;
  testHooks?: Pick<SidecarTestHooksConfig, 'hermeticAiPlanner'>;
  log?: { error: (msg: string, ...args: unknown[]) => void };
}

export interface AIPlannerSuccess<T> {
  ok: true;
  value: T;
  attempts: number;
}

export interface AIPlannerFailure {
  ok: false;
  error: string;
  attempts: number;
}

type AIPlannerResult<T> = AIPlannerSuccess<T> | AIPlannerFailure;

const PLANNER_MAX_ATTEMPTS = 3;
const PLANNER_RETRY_DELAY_MS = 350;

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
  options?: { abortSignal?: AbortSignal },
): Promise<AIPlannerResult<ResearchPlan>> {
  const externalSignal = options?.abortSignal ?? null;
  if (deps.testHooks?.hermeticAiPlanner) {
    return {
      ok: true,
      value: buildResearchPlan({
        title: session.title,
        objective: session.objective,
        outputKind: session.output_kind,
        budgetMode: session.budget_mode,
        constraints: session.constraints,
      }),
      attempts: 1,
    };
  }
  const model = await pickPlannerModel(session, deps);
  if (!model) {
    return { ok: false, error: '没有可用的研究规划模型，或当前模型缺少可用 API Key。', attempts: 1 };
  }

  const prompt = buildPlannerPrompt(session);
  let lastError = '规划模型没有返回可解析的研究计划。';
  for (let attempt = 1; attempt <= PLANNER_MAX_ATTEMPTS; attempt += 1) {
    if (externalSignal?.aborted) return { ok: false, error: '已取消', attempts: attempt };
    try {
      const timeout = AbortSignal.timeout(15_000);
      const combined = externalSignal
        ? AbortSignal.any([timeout, externalSignal])
        : timeout;
      const { text } = await generateText({ model, prompt, maxTokens: 2000, abortSignal: combined });
      const plan = parseAIPlanResponse(text, session);
      if (plan) {
        return { ok: true, value: plan, attempts: attempt };
      }
      lastError = '规划模型返回了不可解析的计划格式。';
    } catch (err) {
      deps.log?.error('AI plan generation failed', err);
      lastError = explainPlannerError(err);
    }
    if (attempt < PLANNER_MAX_ATTEMPTS && !externalSignal?.aborted) await sleep(PLANNER_RETRY_DELAY_MS * attempt);
  }
  return { ok: false, error: lastError, attempts: PLANNER_MAX_ATTEMPTS };
}

export async function revisePlan(
  session: ResearchSession,
  feedback: string,
  deps: AIPlannerDeps,
): Promise<AIPlannerResult<{ plan: ResearchPlan; assistantMessage: string }>> {
  if (deps.testHooks?.hermeticAiPlanner) {
    const plan = buildResearchPlan({
      title: session.title,
      objective: session.objective,
      outputKind: session.output_kind,
      budgetMode: session.budget_mode,
      constraints: session.constraints,
      planningNotes: [feedback],
    });
    return {
      ok: true,
      value: { plan, assistantMessage: plan.summary },
      attempts: 1,
    };
  }
  const model = await pickPlannerModel(session, deps);
  if (!model) {
    return { ok: false, error: '没有可用的研究规划模型，或当前模型缺少可用 API Key。', attempts: 1 };
  }

  const prompt = buildRevisionPrompt(session, feedback);
  let lastError = '规划模型没有返回可解析的修订计划。';
  for (let attempt = 1; attempt <= PLANNER_MAX_ATTEMPTS; attempt += 1) {
    try {
      const abort = AbortSignal.timeout(15_000);
      const { text } = await generateText({ model, prompt, maxTokens: 2000, abortSignal: abort });
      const plan = parseAIPlanResponse(text, session);
      if (plan) {
        return { ok: true, value: { plan, assistantMessage: plan.summary }, attempts: attempt };
      }
      lastError = '规划模型返回了不可解析的修订计划格式。';
    } catch (err) {
      deps.log?.error('AI plan revision failed', err);
      lastError = explainPlannerError(err);
    }
    if (attempt < PLANNER_MAX_ATTEMPTS) await sleep(PLANNER_RETRY_DELAY_MS * attempt);
  }
  return { ok: false, error: lastError, attempts: PLANNER_MAX_ATTEMPTS };
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
  const outlineHint = outlineHintForKind(session.output_kind);

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
      "reason": "研究这个问题的原因（15-60字）",
      "scope": "recon | comparative | deep_dive | verification"
    }
  ],
  "expected_outline": [
    "最终报告的预期章节标题，按出现顺序列出（每条 ≤30 字）"
  ],
  "search_strategy": "一段话（80-300字）说明你打算如何检索：先从哪里入手（官方文档 / 第三方评测 / 学术 / 行业报告 / 论坛），按怎样的顺序覆盖，如何避免低质来源",
  "stop_conditions": [
    "清晰的研究停止条件（10-100字）"
  ]
}

要求：
- **key_questions 必须按 wide → narrow 排序**（Anthropic multi-agent research 启发式）：
  - 前 1-2 条 scope='recon'：宽广的背景/范围/玩家盘点（先把图景画清楚）
  - 中间 scope='comparative' 或 'deep_dive'：针对具体维度/对象的对比或纵深
  - 至少 1 条 scope='verification'：核实关键事实/数字/承诺，避免被旧资料误导
  - 共 3-6 条，每条能独立检索验证
- expected_outline 给出 3-8 个章节标题，对齐 ${kindLabel} 的常见结构${outlineHint}；用户看了能 5 秒判断"AI 思路对不对"
- search_strategy 必须具体，禁止说"会从多个来源检索"这类空话；要写清楚每类来源解决什么问题
- stop_conditions 包含 2-4 条具体的停止条件
- 直接输出 JSON，不要包裹在代码块中`;
}

function outlineHintForKind(kind: ResearchSession['output_kind']): string {
  if (kind === 'comparison') return '（对比分析通常含：结论 / 对比维度表 / 方案分析 / 风险 / 选型建议）';
  if (kind === 'decision') return '（决策建议通常含：推荐结论 / 判断依据 / 可选路径 / 风险与前提 / 执行建议）';
  if (kind === 'brief') return '（简报通常含：摘要 / 关键事实 / 风险 / 下一步）';
  return '（综合报告通常含：执行摘要 / 核心发现 / 详细分析 / 矛盾与争议 / 风险 / 建议与后续步骤）';
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
      "reason": "为什么要研究这个问题",
      "scope": "recon | comparative | deep_dive | verification"
    }
  ],
  "expected_outline": [
    "预期章节标题"
  ],
  "search_strategy": "一段话说明你打算如何检索",
  "stop_conditions": [
    "停止条件"
  ]
}

要求：
- key_questions 按 wide → narrow 排序（recon → comparative/deep_dive → verification），共 3-6 条
- expected_outline 给出 3-8 个章节标题
- search_strategy 80-300 字、具体可执行`;
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
      const scope = normalizePlanScope(qObj.scope);
      const base: ResearchPlan['key_questions'][number] = {
        id: `q${i + 1}`,
        question: typeof qObj.question === 'string' ? qObj.question.trim().slice(0, 240) : '',
        reason: typeof qObj.reason === 'string' ? qObj.reason.trim().slice(0, 240) : '研究需要',
      };
      // Only attach scope when the model actually returned one — older parsers
      // and downstream consumers must still see the field as optional.
      if (scope) base.scope = scope;
      return base;
    }).filter((q) => q.question.length > 0);

    if (key_questions.length === 0) return null;

    const rawOutline = Array.isArray(raw.expected_outline) ? (raw.expected_outline as unknown[]) : [];
    const expected_outline = rawOutline
      .slice(0, 12)
      .map((entry) => (typeof entry === 'string' ? entry.trim().slice(0, 160) : ''))
      .filter((entry) => entry.length > 0);

    const search_strategy = typeof raw.search_strategy === 'string' && raw.search_strategy.trim()
      ? raw.search_strategy.trim().slice(0, 800)
      : null;

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
      ...(expected_outline.length > 0 ? { expected_outline } : {}),
      ...(search_strategy ? { search_strategy } : {}),
    };

    return ResearchPlanSchema.safeParse(plan).success ? plan : null;
  } catch {
      return null;
  }
}

function normalizePlanScope(value: unknown): ResearchPlanQuestionScope | null {
  if (value === 'recon' || value === 'comparative' || value === 'deep_dive' || value === 'verification') {
    return value;
  }
  return null;
}

function buildPlanningHistory(messages: PlanMessage[] | null | undefined): string {
  const msgs = (messages ?? []).filter((item) => item?.content?.trim());
  if (msgs.length === 0) return '';
  return '\n\n对话澄清：\n' + msgs.map((m) => `${m.role === 'user' ? '用户' : '规划师'}：${m.content}`).join('\n\n');
}

function explainPlannerError(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.trim();
    if (message.length > 0) return message.slice(0, 240);
  }
  return '规划模型调用失败。';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
