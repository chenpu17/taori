import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ResearchSession } from '@taori/shared';
import {
  buildQueryPlannerPrompt,
  generateLLMQueries,
  parseQueryPlanResponse,
} from '../src/research/query-planner.js';

function fakeSession(overrides: Partial<ResearchSession> = {}): ResearchSession {
  const now = Date.now();
  return {
    id: 'sess1',
    conversation_id: null,
    title: 'AI Coding 2026',
    objective: '梳理 2026 年 AI Coding 产品格局',
    output_kind: 'report',
    status: 'running',
    stage: 'searching',
    budget_mode: 'balanced',
    budget_limit_usd: null,
    budget_spent_usd: 0,
    constraints: { must_cover: ['价格', '速度'], time_range: '近 12 个月', region: '中国', language: '中文 + 英文', min_citations: null },
    plan: null,
    plan_origin: 'ai',
    plan_messages: null,
    draft_markdown: null,
    final_markdown: null,
    preferred_model_id: null,
    preferred_search_tool: null,
    synthesis_model_id: null,
    started_at: now,
    completed_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

describe('QueryPlanner — parseQueryPlanResponse', () => {
  it('parses well-formed JSON with strategy + queries', () => {
    const text = JSON.stringify({
      strategy: '先用宽广中文查清主要玩家，再针对前三家查官方定价',
      queries: [
        { text: '2026 AI Coding 主要玩家', intent: 'wide_recon' },
        { text: 'Cursor pricing site:cursor.com', intent: 'official_docs' },
      ],
    });
    const parsed = parseQueryPlanResponse(text);
    expect(parsed).toBeTruthy();
    expect(parsed!.strategy).toContain('宽广');
    expect(parsed!.queries).toHaveLength(2);
    expect(parsed!.queries[0].intent).toBe('wide_recon');
    expect(parsed!.queries[1].intent).toBe('official_docs');
  });

  it('handles fenced code block wrapping', () => {
    const text = '```json\n' + JSON.stringify({
      strategy: 'x',
      queries: [{ text: 'a wrapped query', intent: 'wide_recon' }],
    }) + '\n```';
    const parsed = parseQueryPlanResponse(text);
    expect(parsed).toBeTruthy();
    expect(parsed!.queries[0].text).toBe('a wrapped query');
  });

  it('accepts the alternate field name `query` instead of `text`', () => {
    const text = JSON.stringify({
      strategy: 's',
      queries: [{ query: 'alt-named', intent: 'wide_recon' }],
    });
    const parsed = parseQueryPlanResponse(text);
    expect(parsed).toBeTruthy();
    expect(parsed!.queries[0].text).toBe('alt-named');
  });

  it('returns null for empty / non-JSON / malformed input', () => {
    expect(parseQueryPlanResponse('')).toBeNull();
    expect(parseQueryPlanResponse('not json at all')).toBeNull();
    expect(parseQueryPlanResponse('{not valid}')).toBeNull();
  });

  it('returns null when queries array is empty', () => {
    const text = JSON.stringify({ strategy: 's', queries: [] });
    expect(parseQueryPlanResponse(text)).toBeNull();
  });

  it('normalizes unknown intent to narrow_specific', () => {
    const text = JSON.stringify({
      strategy: 's',
      queries: [{ text: 'x', intent: 'random_bogus_intent' }],
    });
    const parsed = parseQueryPlanResponse(text);
    expect(parsed!.queries[0].intent).toBe('narrow_specific');
  });

  it('caps queries at 8 to prevent runaway LLM output', () => {
    const queries = Array.from({ length: 20 }, (_, i) => ({ text: `q${i}`, intent: 'wide_recon' }));
    const parsed = parseQueryPlanResponse(JSON.stringify({ strategy: 's', queries }));
    expect(parsed!.queries.length).toBe(8);
  });

  it('falls back to default strategy when strategy field is missing', () => {
    const text = JSON.stringify({
      queries: [{ text: 'q', intent: 'wide_recon' }],
    });
    const parsed = parseQueryPlanResponse(text);
    expect(parsed!.strategy.length).toBeGreaterThan(0);
  });
});

describe('QueryPlanner — buildQueryPlannerPrompt', () => {
  it('includes title, objective, question, constraints', () => {
    const session = fakeSession();
    const prompt = buildQueryPlannerPrompt({
      session,
      question: { question: '主要玩家有哪些', reason: '问题拆解' },
      budgetMode: 'balanced',
    });
    expect(prompt).toContain('AI Coding 2026');
    expect(prompt).toContain('梳理 2026 年 AI Coding');
    expect(prompt).toContain('主要玩家有哪些');
    expect(prompt).toContain('问题拆解');
    expect(prompt).toContain('近 12 个月');
    expect(prompt).toContain('中国');
    expect(prompt).toContain('价格、速度');
    expect(prompt).toMatch(/wide.*narrow|wide → narrow|wide-+narrow/i);
  });

  it('switches to recovery wording when isRecovery=true', () => {
    const session = fakeSession();
    const prompt = buildQueryPlannerPrompt({
      session,
      question: { question: 'q', reason: 'r' },
      budgetMode: 'balanced',
      isRecovery: true,
      attemptedQueries: ['failed query 1', 'failed query 2'],
    });
    expect(prompt).toContain('recovery');
    expect(prompt).toContain('failed query 1');
    expect(prompt).toContain('failed query 2');
    expect(prompt).toMatch(/换角度|换思路|大幅换/);
  });

  it('omits the attempted-queries block when none provided', () => {
    const session = fakeSession();
    const prompt = buildQueryPlannerPrompt({
      session,
      question: { question: 'q', reason: 'r' },
      budgetMode: 'balanced',
    });
    expect(prompt).not.toContain('已尝试过但失败');
  });
});

describe('QueryPlanner — generateLLMQueries hermetic short-circuit', () => {
  it('returns ok=false immediately in hermetic mode (no model call)', async () => {
    const result = await generateLLMQueries(
      {
        session: fakeSession(),
        question: { question: 'q', reason: 'r' },
        budgetMode: 'balanced',
      },
      // Deps are intentionally invalid — they'd crash on use; the hermetic
      // short-circuit must happen before they're touched.
      {
        modelsRepo: null as never,
        providersRepo: null as never,
        testHooks: { hermeticAiPlanner: true },
      },
    );
    expect(result.ok).toBe(false);
    expect(result.notes).toContain('hermetic_skip');
    expect(result.queries).toHaveLength(0);
  });
});
