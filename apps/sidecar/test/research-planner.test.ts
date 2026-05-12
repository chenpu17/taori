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
    const riskQuery = String(tasks.find((task) => String(task.input?.reason) === '风险争议')?.input?.query ?? '');

    expect(String(tasks[0]?.input?.question_id ?? '')).toBe('q1');
    expect(outlineQuery).toContain('问题拆解');
    expect(outlineQuery).toContain('子问题 研究框架 市场格局 主要玩家');
    expect(outlineQuery.match(/分析 2026 年 AI Coding 市场格局与主要玩家差异/g)?.length ?? 0).toBe(1);
    expect(riskQuery).toContain('风险 争议 合规 安全 版权');
    expect(outlineQuery.length).toBeLessThanOrEqual(160);
  });
});
