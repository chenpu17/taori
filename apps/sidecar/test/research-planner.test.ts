import { describe, expect, it } from 'vitest';
import { buildResearchPlan, buildResearchTasks, buildSearchRecoveryQueries, classifySearchFailureReason } from '../src/research/planner.js';
import { ResearchPlanSchema } from '@taori/shared';

describe('research planner search queries', () => {
  it('deduplicates repeated objective/title text and adds reason-specific hints', () => {
    const plan = buildResearchPlan({
      title: '分析 2026 年 AI Coding 市场格局与主要玩家差异',
      objective: '分析 2026 年 AI Coding 市场格局与主要玩家差异',
      outputKind: 'report',
      budgetMode: 'balanced',
      constraints: {
        time_range: null,
        region: null,
        language: null,
        must_cover: [],
        min_citations: null,
      },
    });

    const tasks = buildResearchTasks({
      plan,
      title: '分析 2026 年 AI Coding 市场格局与主要玩家差异',
      objective: '分析 2026 年 AI Coding 市场格局与主要玩家差异',
    }).filter((task) => task.kind === 'search');

    const outlineQuery = String(tasks[0]?.input?.query ?? '');
    const riskQuery = String(tasks.find((task) => String(task.input?.reason) === '风险约束')?.input?.query ?? '');

    expect(String(tasks[0]?.input?.question_id ?? '')).toBe('q1');
    expect(String(tasks[0]?.input?.reason ?? '')).toBe('对比对象');
    expect(String(tasks[0]?.input?.question ?? '')).toContain('纳入');
    expect(outlineQuery).toContain('对象 清单 产品边界 版本');
    expect(outlineQuery.match(/分析 2026 年 AI Coding 市场格局与主要玩家差异/g)?.length ?? 0).toBe(1);
    expect(riskQuery).toContain('合规 数据安全 服务连续性 厂商锁定');
    expect(outlineQuery.length).toBeLessThanOrEqual(160);
  });

  it('builds comparison fallback plans with concrete, dimension-based questions', () => {
    const plan = buildResearchPlan({
      title: '对比中国主流大模型 API 的价格、速度与可用性',
      objective: '对比中国主流大模型 API 的价格、速度与可用性',
      outputKind: 'comparison',
      budgetMode: 'balanced',
      constraints: {
        time_range: '近 12 个月',
        region: '中国',
        language: '中文 + 英文',
        must_cover: ['价格', '速度', '可用性'],
        min_citations: 6,
      },
    });

    expect(plan.summary).toContain('锁定纳入范围');
    expect(plan.summary).toContain('价格口径');
    expect(plan.key_questions[0]?.question).toContain('对比对象');
    expect(plan.key_questions.some((item) => item.reason === '价格口径')).toBe(true);
    expect(plan.key_questions.some((item) => item.reason === '速度表现')).toBe(true);
    expect(plan.key_questions.some((item) => item.reason === '可用性')).toBe(true);
    expect(plan.stop_conditions.some((item) => item.includes('交叉验证'))).toBe(true);
  });

  it('includes reflect task in task sequence for non-fast budgets, pre-skipped for fast', () => {
    for (const budgetMode of ['balanced', 'deep'] as const) {
      const plan = buildResearchPlan({
        title: '测试研究',
        objective: '测试反思步骤是否正确插入。',
        outputKind: 'report',
        budgetMode,
        constraints: { time_range: null, region: null, language: null, must_cover: [], min_citations: null },
      });
      const tasks = buildResearchTasks({ plan, title: '测试研究', objective: '测试反思步骤是否正确插入。' });
      const reflectTask = tasks.find((t) => t.kind === 'reflect');
      expect(reflectTask, `reflect task missing for ${budgetMode}`).toBeTruthy();
      expect(reflectTask!.status).toBe('queued');
      // reflect must come before summarize
      const reflectIdx = tasks.findIndex((t) => t.kind === 'reflect');
      const summarizeIdx = tasks.findIndex((t) => t.kind === 'summarize');
      expect(reflectIdx).toBeLessThan(summarizeIdx);
    }

    const fastPlan = buildResearchPlan({
      title: '快速研究',
      objective: '测试快速模式跳过反思。',
      outputKind: 'brief',
      budgetMode: 'fast',
      constraints: { time_range: null, region: null, language: null, must_cover: [], min_citations: null },
    });
    const fastTasks = buildResearchTasks({ plan: fastPlan, title: '快速研究', objective: '测试快速模式跳过反思。' });
    const fastReflect = fastTasks.find((t) => t.kind === 'reflect');
    expect(fastReflect).toBeTruthy();
    expect(fastReflect!.status).toBe('skipped');
  });

  it('builds broader and vendor-specific recovery queries for chinese model api pricing/perf gaps', () => {
    const currentYear = String(new Date().getFullYear());
    const priceRecovery = buildSearchRecoveryQueries({
      title: '对比中国主流大模型 API 的价格、速度与可用性',
      objective: '研究中国主流大模型 API 的模型清单、token 价格和速度差异。',
      question: {
        question: '中国主流大模型API官方模型清单与token价格',
        reason: '信息空白补充',
      },
      budgetMode: 'deep',
      constraints: {
        time_range: '近 12 个月',
        region: '中国',
        language: '中文 + 英文',
        must_cover: ['价格', '速度'],
        min_citations: null,
      },
      originalQueries: ['中国主流大模型API官方模型清单与token价格'],
    });

    const perfRecovery = buildSearchRecoveryQueries({
      title: '对比中国主流大模型 API 的价格、速度与可用性',
      objective: '研究中国主流大模型 API 的模型清单、token 价格和速度差异。',
      question: {
        question: '国产大模型API首token延迟、总响应时间与吞吐实测',
        reason: '信息空白补充',
      },
      budgetMode: 'balanced',
      constraints: {
        time_range: '近 12 个月',
        region: '中国',
        language: '中文 + 英文',
        must_cover: ['速度'],
        min_citations: null,
      },
      originalQueries: ['国产大模型API首token延迟、总响应时间与吞吐实测'],
    });

    expect(priceRecovery.some((query) => query.includes('pricing') || query.includes('token price'))).toBe(true);
    expect(priceRecovery.some((query) => query.includes('site:'))).toBe(true);
    expect(priceRecovery.slice(0, 4).every((query) => /site:|DeepSeek|DashScope|阿里云百炼|火山方舟|智谱|千帆|腾讯混元/.test(query))).toBe(true);
    expect(priceRecovery.some((query) => query.includes(currentYear) && query.includes('最新'))).toBe(true);
    expect(perfRecovery.some((query) => /latency|benchmark|throughput|首 token 延迟/i.test(query))).toBe(true);
    expect(perfRecovery.some((query) => /DeepSeek|DashScope|火山方舟|智谱|千帆|腾讯混元/.test(query))).toBe(true);
    expect(perfRecovery.length).toBeGreaterThan(0);
  });

  it('routes availability gaps to official domains and classifies failure reasons', () => {
    const availabilityRecovery = buildSearchRecoveryQueries({
      title: '对比中国主流大模型 API 的价格、速度与可用性',
      objective: '研究中国主流大模型 API 的模型清单、token 价格和速度差异。',
      question: {
        question: '中国主流大模型API可用性指标（SLA、并发限制等）',
        reason: '信息空白补充',
      },
      budgetMode: 'balanced',
      constraints: {
        time_range: '近 12 个月',
        region: '中国',
        language: '中文 + 英文',
        must_cover: ['可用性'],
        min_citations: null,
      },
      originalQueries: ['中国主流大模型API可用性指标（SLA、并发限制等）'],
    });

    expect(availabilityRecovery.some((query) => /site:|SLA|并发|限流|status/i.test(query))).toBe(true);
    expect(classifySearchFailureReason({
      title: '对比中国主流大模型 API 的价格、速度与可用性',
      objective: '研究中国主流大模型 API 的模型清单、token 价格和速度差异。',
      question: '中国主流大模型API可用性指标（SLA、并发限制等）',
      reason: '信息空白补充',
      attemptedRecovery: true,
    })).toBe('needs_official_sources');
    expect(classifySearchFailureReason({
      title: '对比中国主流大模型 API 的价格、速度与可用性',
      objective: '研究中国主流大模型 API 的模型清单、token 价格和速度差异。',
      question: '大模型API响应时间实测',
      reason: '信息空白补充',
      attemptedRecovery: true,
    })).toBe('needs_benchmark_sources');
  });
});

describe('deterministic planner — wide→narrow scope, outline, search strategy', () => {
  const baseConstraints = {
    time_range: '近 12 个月',
    region: '中国',
    language: '中文 + 英文',
    must_cover: ['价格', '速度'],
    min_citations: null,
  };

  it('orders key_questions wide→narrow with explicit scope tags', () => {
    const plan = buildResearchPlan({
      title: '对比中国主流大模型 API 的价格、速度与可用性',
      objective: '对比中国主流大模型 API 的价格、速度与可用性',
      outputKind: 'comparison',
      budgetMode: 'balanced',
      constraints: baseConstraints,
    });
    expect(plan.key_questions.length).toBeGreaterThanOrEqual(3);
    // First should be recon, last should be verification (recommendation step).
    expect(plan.key_questions[0].scope).toBe('recon');
    expect(plan.key_questions[plan.key_questions.length - 1].scope).toBe('verification');
    // Middle ones (if any) are deep_dive.
    if (plan.key_questions.length > 2) {
      expect(plan.key_questions[1].scope).toBe('deep_dive');
    }
  });

  it('emits expected_outline matching the output kind', () => {
    const comparisonPlan = buildResearchPlan({
      title: 't',
      objective: 'o',
      outputKind: 'comparison',
      budgetMode: 'balanced',
      constraints: baseConstraints,
    });
    expect(comparisonPlan.expected_outline).toBeTruthy();
    expect(comparisonPlan.expected_outline?.length).toBeGreaterThanOrEqual(3);
    expect(comparisonPlan.expected_outline).toContain('对比维度');

    const decisionPlan = buildResearchPlan({
      title: 't',
      objective: 'o',
      outputKind: 'decision',
      budgetMode: 'balanced',
      constraints: baseConstraints,
    });
    expect(decisionPlan.expected_outline).toContain('判断依据');
  });

  it('emits a non-empty, kind-aware search_strategy that mentions constraints', () => {
    const plan = buildResearchPlan({
      title: '对比 GPT-5 与 Claude 4.7 在编程上的差异',
      objective: '对比 GPT-5 与 Claude 4.7 在编程上的差异',
      outputKind: 'comparison',
      budgetMode: 'deep',
      constraints: baseConstraints,
    });
    expect(plan.search_strategy).toBeTruthy();
    expect(plan.search_strategy!.length).toBeGreaterThan(40);
    // Constraints should make it into the narrative.
    expect(plan.search_strategy).toMatch(/近 12 个月|中国|价格|速度/);
    // Comparison-flavored wording.
    expect(plan.search_strategy).toMatch(/对比|盘点|官方/);
  });

  it('produces a plan that still validates against the shared zod schema', () => {
    const plan = buildResearchPlan({
      title: 't',
      objective: 'o',
      outputKind: 'report',
      budgetMode: 'balanced',
      constraints: baseConstraints,
    });
    const result = ResearchPlanSchema.safeParse(plan);
    expect(result.success).toBe(true);
  });

  it('keeps key_questions optional-scope when caller mutates plan to remove scope (backwards compat)', () => {
    const plan = buildResearchPlan({
      title: 't',
      objective: 'o',
      outputKind: 'report',
      budgetMode: 'balanced',
      constraints: baseConstraints,
    });
    // Simulate an older-format plan whose questions have no scope: the schema
    // should still validate cleanly because scope is optional.
    const stripped = {
      ...plan,
      key_questions: plan.key_questions.map(({ scope: _scope, ...rest }) => rest),
    };
    const result = ResearchPlanSchema.safeParse(stripped);
    expect(result.success).toBe(true);
  });
});
