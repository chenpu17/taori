import type {
  ResearchBudgetMode,
  ResearchConstraints,
  ResearchOutputKind,
  ResearchPlan,
  ResearchSession,
} from '@taori/shared';
import type { ResearchTaskSeed } from '../db/repos/index.js';

function questionTemplates(outputKind: ResearchOutputKind): Array<{ label: string; prompt: string }> {
  const common = [
    { label: '现状判断', prompt: '当前现状、规模与边界是什么？' },
    { label: '关键变量', prompt: '影响判断结果的关键变量与假设有哪些？' },
    { label: '风险争议', prompt: '主要风险、争议点和不确定性在哪里？' },
  ];
  if (outputKind === 'comparison') {
    return [
      { label: '评估维度', prompt: '应该用哪些维度对候选方案做横向比较？' },
      { label: '方案差异', prompt: '候选方案在核心维度上的差异是什么？' },
      ...common,
    ];
  }
  if (outputKind === 'decision') {
    return [
      { label: '决策条件', prompt: '要做出决策，需要满足哪些硬条件和软条件？' },
      { label: '推荐路径', prompt: '在当前条件下，最值得优先推进的路径是什么？' },
      ...common,
    ];
  }
  if (outputKind === 'brief') {
    return [
      { label: '核心事实', prompt: '最值得先交付给读者的核心事实是什么？' },
      ...common,
    ];
  }
  return [
    { label: '问题拆解', prompt: '这个研究目标应拆成哪几个子问题？' },
    ...common,
  ];
}

function stopConditions(budgetMode: ResearchBudgetMode, constraints: ResearchConstraints): string[] {
  const items = ['完成关键问题的首轮证据搜集后先停一次，等待人工确认方向。'];
  if (budgetMode === 'fast') items.push('优先控制检索轮次，避免展开次级议题。');
  if (budgetMode === 'deep') items.push('只有在关键主张仍缺少证据时，才继续追加检索。');
  if (constraints.min_citations != null && constraints.min_citations > 0) {
    items.push(`关键结论至少补齐 ${constraints.min_citations} 条可回溯引用。`);
  }
  return items;
}

function sectionHeadings(outputKind: ResearchOutputKind): string[] {
  if (outputKind === 'brief') return ['摘要', '关键事实', '风险', '下一步'];
  if (outputKind === 'comparison') return ['结论', '对比维度', '方案分析', '风险', '建议'];
  if (outputKind === 'decision') return ['结论', '判断依据', '可选路径', '风险与前提', '执行建议'];
  return ['结论', '证据', '风险', '建议', '待补充问题'];
}

export function buildResearchPlan(input: {
  title: string;
  objective: string;
  outputKind: ResearchOutputKind;
  budgetMode: ResearchBudgetMode;
  constraints: ResearchConstraints;
}): ResearchPlan {
  const questions = questionTemplates(input.outputKind);
  return {
    summary: `围绕“${input.title}”先做范围澄清、问题拆解与证据搜集，再整理成 ${input.outputKind === 'brief' ? '简报' : input.outputKind === 'comparison' ? '对比结论' : input.outputKind === 'decision' ? '决策建议' : '研究报告'}。`,
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
    stop_conditions: stopConditions(input.budgetMode, input.constraints),
  };
}

export function buildResearchTasks(plan: ResearchPlan): ResearchTaskSeed[] {
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
      title: `检索：${question.question}`,
      input: {
        question: question.question,
        reason: question.reason,
      },
    });
  }
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
