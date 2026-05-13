import type {
  ResearchBudgetMode,
  ResearchConstraints,
  ResearchOutputKind,
  ResearchPlan,
  ResearchSession,
} from '@taori/shared';
import type { ResearchTaskSeed } from '../db/repos/index.js';

function sectionHeadings(outputKind: ResearchOutputKind): string[] {
  if (outputKind === 'brief') return ['摘要', '关键事实', '风险', '下一步'];
  if (outputKind === 'comparison') return ['结论', '对比维度', '方案分析', '风险', '建议'];
  if (outputKind === 'decision') return ['结论', '判断依据', '可选路径', '风险与前提', '执行建议'];
  return ['结论', '证据', '风险', '建议', '待补充问题'];
}

function summarizeObjective(objective: string): string {
  const first = objective.trim().replace(/\s+/g, ' ').split(/[。.!?！？]/)[0]?.trim() ?? '';
  if (!first) return '围绕目标完成范围澄清、问题拆解与证据搜集。';
  return first.length > 80 ? `${first.slice(0, 80)}…` : first;
}

function describeScope(constraints: ResearchConstraints): string[] {
  const bits: string[] = [];
  if (constraints.time_range?.trim()) bits.push(`时间范围：${constraints.time_range.trim()}`);
  if (constraints.region?.trim()) bits.push(`区域：${constraints.region.trim()}`);
  if (constraints.language?.trim()) bits.push(`语言：${constraints.language.trim()}`);
  if (constraints.must_cover.length > 0) bits.push(`必须覆盖：${constraints.must_cover.join('、')}`);
  return bits;
}

type FocusKind = 'scope' | 'price' | 'speed' | 'availability' | 'quality' | 'ecosystem' | 'risk';

function extractSubject(title: string, objective: string): string {
  const source = title.trim() || objective.trim();
  const stripped = source
    .replace(/^(分析|对比|梳理|总结|研究|评估|比较|盘点|了解|拆解|调研)/, '')
    .replace(/的(价格|速度|可用性|稳定性|SLA|风险|生态|能力|定位|差异|优劣|格局).*/g, '')
    .replace(/[。.!?！？].*$/g, '')
    .trim();
  if (stripped.length >= 4) return stripped;
  return summarizeObjective(source).replace(/^(分析|对比|梳理|总结|研究|评估|比较)/, '').trim() || '研究对象';
}

function extractFocusKinds(input: {
  title: string;
  objective: string;
  outputKind: ResearchOutputKind;
  constraints: ResearchConstraints;
}): FocusKind[] {
  const hay = `${input.title} ${input.objective} ${(input.constraints.must_cover ?? []).join(' ')}`;
  const found: FocusKind[] = [];
  const push = (kind: FocusKind) => {
    if (!found.includes(kind)) found.push(kind);
  };
  push('scope');
  if (/(价格|成本|计费|免费额度|优惠)/.test(hay)) push('price');
  if (/(速度|延迟|吞吐|响应)/.test(hay)) push('speed');
  if (/(可用性|稳定性|SLA|限流|可用|地域覆盖|availability)/i.test(hay)) push('availability');
  if (/(能力|效果|质量|推理|准确性|模型能力)/.test(hay)) push('quality');
  if (/(文档|SDK|社区|生态|接入)/.test(hay)) push('ecosystem');
  if (/(风险|争议|合规|安全|锁定|依赖)/.test(hay)) push('risk');
  if (input.outputKind === 'comparison') {
    for (const kind of ['price', 'speed', 'availability', 'risk'] as const) push(kind);
  } else if (input.outputKind === 'decision') {
    for (const kind of ['availability', 'risk', 'price'] as const) push(kind);
  } else if (input.outputKind === 'brief') {
    for (const kind of ['scope', 'quality', 'risk'] as const) push(kind);
  } else {
    for (const kind of ['scope', 'quality', 'risk'] as const) push(kind);
  }
  return found.slice(0, 4);
}

function focusLabel(kind: FocusKind): string {
  return {
    scope: '纳入范围',
    price: '价格口径',
    speed: '速度表现',
    availability: '可用性',
    quality: '能力差异',
    ecosystem: '接入生态',
    risk: '风险约束',
  }[kind];
}

function buildQuestionForFocus(subject: string, kind: FocusKind): { label: string; prompt: string } {
  switch (kind) {
    case 'scope':
      return {
        label: '对比对象',
        prompt: `本次研究应纳入哪些${subject}作为对比对象，它们各自的产品边界与接口范围是什么？`,
      };
    case 'price':
      return {
        label: '价格口径',
        prompt: `${subject} 的官方定价、免费额度与计费口径分别是什么？`,
      };
    case 'speed':
      return {
        label: '速度表现',
        prompt: `在可比条件下，${subject} 的响应速度、首 token 延迟或吞吐差异如何？`,
      };
    case 'availability':
      return {
        label: '可用性',
        prompt: `${subject} 的可用性、SLA、限流策略和地域覆盖分别如何？`,
      };
    case 'quality':
      return {
        label: '能力差异',
        prompt: `${subject} 在模型能力、效果表现和适用场景上有哪些关键差异？`,
      };
    case 'ecosystem':
      return {
        label: '接入生态',
        prompt: `${subject} 的文档、SDK、社区支持和接入成本差异如何？`,
      };
    case 'risk':
      return {
        label: '风险约束',
        prompt: `${subject} 在合规、数据安全、服务连续性或厂商锁定上有哪些关键风险？`,
      };
  }
}

function recommendationQuestion(subject: string, outputKind: ResearchOutputKind): { label: string; prompt: string } | null {
  if (outputKind === 'brief') return null;
  if (outputKind === 'decision') {
    return {
      label: '决策建议',
      prompt: `基于上述差异与约束，${subject} 当前最值得优先采用的方案或推进路径是什么？`,
    };
  }
  if (outputKind === 'comparison') {
    return {
      label: '选型建议',
      prompt: `基于关键维度差异，${subject} 分别适合哪些使用场景、团队阶段或采购策略？`,
    };
  }
  return {
    label: '结论归纳',
    prompt: `综合以上发现，关于${subject} 最值得输出给决策者的结论与建议是什么？`,
  };
}

function buildPlanQuestions(input: {
  title: string;
  objective: string;
  outputKind: ResearchOutputKind;
  constraints: ResearchConstraints;
}): Array<{ label: string; prompt: string }> {
  const subject = extractSubject(input.title, input.objective);
  const questions = extractFocusKinds(input).map((kind) => buildQuestionForFocus(subject, kind));
  const recommendation = recommendationQuestion(subject, input.outputKind);
  if (recommendation) questions.push(recommendation);
  return questions
    .filter((item, index, arr) => arr.findIndex((other) => other.label === item.label) === index)
    .slice(0, input.outputKind === 'brief' ? 4 : 5);
}

function buildPlanSummary(input: {
  title: string;
  objective: string;
  outputKind: ResearchOutputKind;
  constraints: ResearchConstraints;
  planningNotes?: string[];
}): string {
  const subject = extractSubject(input.title, input.objective);
  const scope = describeScope(input.constraints);
  const note = (input.planningNotes ?? []).map((item) => item.trim()).filter(Boolean).at(-1) ?? null;
  const focus = extractFocusKinds(input)
    .filter((kind) => kind !== 'scope')
    .map((kind) => focusLabel(kind))
    .slice(0, 3);
  return [
    `这项研究会先锁定纳入范围内的${subject}清单，再围绕${focus.join('、') || '关键差异'}收集官方口径与第三方验证材料。`,
    `最终交付会输出一份${input.outputKind === 'brief' ? '简报' : input.outputKind === 'comparison' ? '结构化对比结论' : input.outputKind === 'decision' ? '决策建议' : '研究报告'}，帮助你快速判断结论与适用场景。`,
    scope.length > 0 ? `当前约束：${scope.join('；')}。` : null,
    note ? `补充要求：${note.slice(0, 160)}。` : null,
  ].filter(Boolean).join(' ');
}

function buildPlanStopConditions(input: {
  title: string;
  objective: string;
  outputKind: ResearchOutputKind;
  budgetMode: ResearchBudgetMode;
  constraints: ResearchConstraints;
}): string[] {
  const focus = extractFocusKinds({
    title: input.title,
    objective: input.objective,
    outputKind: input.outputKind,
    constraints: input.constraints,
  })
    .filter((kind) => kind !== 'scope')
    .map((kind) => focusLabel(kind))
    .slice(0, 3);
  const items = [
    `已为纳入范围内的研究对象收集到覆盖${focus.join('、') || '关键维度'}的可回溯证据。`,
    '关键维度至少具备官方口径与第三方补充来源，可做交叉验证。',
  ];
  if (input.budgetMode === 'deep') {
    items.push('如果关键结论仍存在明显冲突，再追加一轮定向检索；否则停止。');
  }
  if (input.constraints.min_citations != null && input.constraints.min_citations > 0) {
    items.push(`关键结论至少补齐 ${input.constraints.min_citations} 条可回溯引用。`);
  }
  return items;
}

export function buildResearchPlan(input: {
  title: string;
  objective: string;
  outputKind: ResearchOutputKind;
  budgetMode: ResearchBudgetMode;
  constraints: ResearchConstraints;
  planningNotes?: string[];
}): ResearchPlan {
  const questions = buildPlanQuestions(input);
  return {
    summary: buildPlanSummary(input),
    output_kind: input.outputKind,
    budget_mode: input.budgetMode,
    key_questions: questions.map((item, index) => ({
      id: `q${index + 1}`,
      question: item.prompt,
      reason: item.label,
    })),
    stages: [
      {
        id: 'scoping',
        title: '选题澄清',
        objective: '明确研究边界、输出目标与必须覆盖的问题。',
        deliverable: '范围说明与研究目标',
      },
      {
        id: 'planning',
        title: '研究计划',
        objective: '确认关键问题、检索顺序与停止条件。',
        deliverable: '研究计划与任务清单',
      },
      {
        id: 'searching',
        title: '检索抓取',
        objective: '分批搜索网页、抓取资料并记录候选来源。',
        deliverable: '候选来源列表',
      },
      {
        id: 'synthesizing',
        title: '证据整理',
        objective: '归纳事实、标记冲突并组织章节结构。',
        deliverable: '证据卡片与主张草稿',
      },
      {
        id: 'verifying',
        title: '引用校验',
        objective: '检查关键主张是否有来源支撑、是否仍需补证。',
        deliverable: '风险/待确认项',
      },
    ],
    stop_conditions: buildPlanStopConditions({
      title: input.title,
      objective: input.objective,
      outputKind: input.outputKind,
      budgetMode: input.budgetMode,
      constraints: input.constraints,
    }),
  };
}

function buildSearchQuery(parts: string[]): string {
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    const normalized = normalizeSearchChunk(part);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(part.trim());
  }
  return deduped
    .join(' ')
    .replace(/[：:；;，,。！？!?（）()\[\]【】"']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

function constraintSearchHints(constraints?: ResearchConstraints): string[] {
  if (!constraints) return [];
  const hints: string[] = [];
  if (constraints.time_range?.trim()) hints.push(constraints.time_range.trim());
  if (constraints.region?.trim()) hints.push(constraints.region.trim());
  if (constraints.language?.trim()) hints.push(constraints.language.trim());
  if ((constraints.must_cover ?? []).length > 0) hints.push(constraints.must_cover.join(' '));
  return hints;
}

function normalizeSearchChunk(value: string): string {
  return value
    .toLowerCase()
    .replace(/[：:；;，,。！？!?（）()\[\]【】"'`\s]/g, '')
    .trim();
}

function searchReasonHints(reason: string): string[] {
  if (reason === '对比对象') return ['对象 清单 产品边界 版本'];
  if (reason === '价格口径') return ['官方定价 免费额度 计费'];
  if (reason === '速度表现') return ['延迟 吞吐 响应速度 benchmark'];
  if (reason === '可用性') return ['SLA 稳定性 限流 地域 覆盖'];
  if (reason === '能力差异') return ['效果 能力 质量 适用场景'];
  if (reason === '接入生态') return ['文档 SDK 社区 示例'];
  if (reason === '风险约束') return ['合规 数据安全 服务连续性 厂商锁定'];
  if (reason === '选型建议' || reason === '决策建议' || reason === '结论归纳') return ['适用场景 采购建议 选择'];
  if (reason === '问题拆解') return ['子问题 研究框架 市场格局 主要玩家'];
  if (reason === '现状判断') return ['现状 市场规模 竞争格局 主要玩家'];
  if (reason === '关键变量') return ['关键变量 驱动因素 成本 模型能力'];
  if (reason === '风险争议') return ['风险 争议 合规 安全 版权'];
  if (reason === '评估维度') return ['评估维度 比较指标 方法'];
  if (reason === '方案差异') return ['差异 对比 价格 速度 可用性'];
  if (reason === '决策条件') return ['决策条件 前提 约束'];
  if (reason === '推荐路径') return ['推荐路径 优先级 建议'];
  if (reason === '核心事实') return ['核心事实 数据 结论'];
  return [];
}

function searchFollowupTracks(reason: string): string[][] {
  if (reason === '风险争议') {
    return [
      ['官方 文档 公告', '风险 限制 合规 安全'],
      ['媒体 分析 评测 用户反馈', '事故 争议'],
    ];
  }
  if (reason === '方案差异' || reason === '评估维度') {
    return [
      ['官方 文档 定价 API SLA'],
      ['第三方 测评 基准 用户反馈 对比'],
    ];
  }
  if (reason === '推荐路径' || reason === '决策条件') {
    return [
      ['官方 文档 案例 最佳实践'],
      ['专家 分析 用户反馈 落地经验'],
    ];
  }
  return [
    ['官方 文档 报告 数据'],
    ['第三方 分析 评测 用户反馈'],
  ];
}

export function buildSearchQueries(input: {
  title: string;
  objective: string;
  question: { question: string; reason: string };
  budgetMode: ResearchBudgetMode;
  constraints?: ResearchConstraints;
}): string[] {
  const scopeHints = constraintSearchHints(input.constraints);
  const base = buildSearchQuery([
    input.title.trim(),
    summarizeObjective(input.objective),
    input.question.reason.trim(),
    ...searchReasonHints(input.question.reason),
    ...scopeHints,
    '官网 报告 文档',
  ]);
  const followups = searchFollowupTracks(input.question.reason).map((parts) =>
    buildSearchQuery([
      input.title.trim(),
      input.question.question.trim(),
      input.question.reason.trim(),
      ...scopeHints,
      ...parts,
    ]),
  );
  const maxQueries = input.budgetMode === 'fast' ? 1 : input.budgetMode === 'balanced' ? 2 : 3;
  return [base, ...followups].filter(Boolean).filter((value, index, arr) => arr.indexOf(value) === index).slice(0, maxQueries);
}

export function buildResearchTasks(input: {
  plan: ResearchPlan;
  title: string;
  objective: string;
}): ResearchTaskSeed[] {
  const { plan, title, objective } = input;
  const tasks: ResearchTaskSeed[] = [
    {
      kind: 'outline',
      status: 'completed',
      title: '确认研究范围与输出结构',
      input: {
        stage: 'planning',
        deliverable: plan.summary,
      },
      output: {
        stage: 'planning',
        ready: true,
      },
    },
  ];
  for (const question of plan.key_questions) {
    tasks.push({
      kind: 'search',
      status: 'queued',
      title: `检索：${title} — ${question.reason}`,
        input: {
          question_id: question.id,
          question: question.question,
          reason: question.reason,
          query: buildSearchQueries({
            title,
            objective,
            question,
            budgetMode: plan.budget_mode,
          })[0] ?? '',
        },
      });
  }
  // Reflect task: LLM evaluates coverage and adds targeted follow-up searches.
  // For fast mode, it is pre-marked as skipped to keep the loop efficient.
  tasks.push({
    kind: 'reflect',
    status: plan.budget_mode === 'fast' ? 'skipped' : 'queued',
    title: '评估已有证据，识别关键信息空白',
    input: {
      questions: plan.key_questions.map((q) => ({ id: q.id, question: q.question, reason: q.reason })),
      budget_mode: plan.budget_mode,
      max_follow_ups: plan.budget_mode === 'deep' ? 3 : 2,
    },
    ...(plan.budget_mode === 'fast' ? { output: { skipped: true, reason: 'fast_mode' }, finished_at: Date.now() } : {}),
  });
  tasks.push({
    kind: 'summarize',
    status: 'queued',
    title: '整理证据并生成结构化草稿',
    input: {
      sections: sectionHeadings(plan.output_kind),
    },
  });
  tasks.push({
    kind: 'verify_citation',
    status: 'queued',
    title: '校验关键结论的引用充分性',
    input: {
      stop_conditions: plan.stop_conditions,
    },
  });
  return tasks;
}

export function buildResearchDraftSkeleton(
  session: Pick<ResearchSession, 'title' | 'objective' | 'output_kind'>,
  plan: ResearchPlan,
): string {
  const sections = sectionHeadings(session.output_kind);
  const lines = [
    `# ${session.title}`,
    '',
    '## 研究目标',
    '',
    session.objective,
    '',
    '## 计划摘要',
    '',
    plan.summary,
    '',
    '## 关键问题',
    '',
    ...plan.key_questions.map((item: ResearchPlan['key_questions'][number]) => `- ${item.question}`),
  ];
  for (const section of sections) {
    lines.push('', `## ${section}`, '', '（待补充）');
  }
  lines.push('', '## 风险与待确认项', '', '- （待补充）');
  return `${lines.join('\n').trim()}\n`;
}
