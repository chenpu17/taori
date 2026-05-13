import { describe, expect, it } from 'vitest';
import { buildResearchPlan, buildResearchTasks } from '../src/research/planner.js';

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
});
