import { describe, expect, it } from 'vitest';
import type { ResearchClaim, ResearchSource, ResearchTask } from '@taori/shared';
import { buildTaskNarrative } from '../src/research/narrative.js';

function fakeTask(overrides: Partial<ResearchTask> = {}): ResearchTask {
  return {
    id: 't1',
    research_session_id: 's1',
    parent_task_id: null,
    kind: 'search',
    status: 'completed',
    title: 'Default title',
    input: {},
    output: null,
    error: null,
    started_at: 1_700_000_000_000,
    finished_at: 1_700_000_001_000,
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_001_000,
    ...overrides,
  };
}

function fakeSource(id: string): ResearchSource {
  return {
    id,
    research_session_id: 's1',
    source_type: 'web_page',
    title: `Source ${id}`,
    locator: `https://example.com/${id}`,
    snippet: 'snippet',
    credibility_score: 0.8,
    included: true,
    metadata: {},
    created_at: Date.now(),
  };
}

function fakeClaim(overrides: Partial<ResearchClaim> = {}): ResearchClaim {
  return {
    id: 'c1',
    research_session_id: 's1',
    section_key: '结论',
    claim_text: 'something',
    claim_kind: 'fact',
    support_status: 'supported',
    citations: [],
    evidence_spans: [{ source_id: 's1', span_text: 'span', stance: 'supports' }],
    confidence: 'high',
    verified_at: Date.now(),
    created_at: Date.now(),
    updated_at: Date.now(),
    ...overrides,
  };
}

describe('narrative — search', () => {
  it('describes a successful multi-track search', () => {
    const task = fakeTask({
      kind: 'search',
      input: { question: '主流大模型 API 价格' },
      output: {
        hits: 8,
        unique_hosts: 5,
        rounds: [
          { query: 'a', search_track: 'official', phase: 'primary', hits: 3 },
          { query: 'b', search_track: 'official', phase: 'primary', hits: 2 },
          { query: 'c', search_track: 'third_party', phase: 'primary', hits: 3 },
        ],
      },
    });
    const narrative = buildTaskNarrative(task);
    expect(narrative).toContain('主流大模型 API 价格');
    expect(narrative).toContain('8 条');
    expect(narrative).toContain('5 个站点');
    expect(narrative).toContain('官方');
    expect(narrative).toContain('第三方');
  });

  it('flags successful recovery branch', () => {
    const task = fakeTask({
      kind: 'search',
      input: { question: 'q' },
      output: {
        hits: 3,
        unique_hosts: 2,
        rounds: [{ query: 'rq', search_track: 'official', phase: 'recovery', hits: 3 }],
        recovery_attempted: true,
        recovery_successful: true,
      },
    });
    const narrative = buildTaskNarrative(task);
    expect(narrative).toMatch(/改写|recovery|补回/);
  });

  it('explains zero-result outcome with classified failure reason', () => {
    const task = fakeTask({
      kind: 'search',
      input: { question: '某个偏门问题' },
      output: {
        hits: 0,
        unique_hosts: 0,
        rounds: [{}, {}, {}],
        recovery_attempted: true,
        coverage_status: 'no_usable_sources',
        failure_reason: 'needs_official_sources',
      },
    });
    const narrative = buildTaskNarrative(task);
    expect(narrative).toContain('待补证');
    expect(narrative).toContain('官方源缺失');
  });

  it('returns null when the task has no output', () => {
    const task = fakeTask({ kind: 'search', output: null });
    expect(buildTaskNarrative(task)).toBeNull();
  });
});

describe('narrative — reflect', () => {
  it('summarizes coverage + follow-up tasks', () => {
    const task = fakeTask({
      kind: 'reflect',
      output: {
        coverage: [
          { question_id: 'q1', level: 'good' },
          { question_id: 'q2', level: 'partial' },
          { question_id: 'q3', level: 'missing' },
        ],
        added_tasks: ['t1', 't2'],
        reflect_round: 1,
        next_round_scheduled: true,
      },
    });
    const narrative = buildTaskNarrative(task);
    expect(narrative).toContain('第 1 轮');
    expect(narrative).toContain('1 个问题覆盖充分');
    expect(narrative).toContain('2 个仍有空白');
    expect(narrative).toContain('已追加 2 个');
    expect(narrative).toContain('第二轮');
  });

  it('handles skipped reflect with explanatory message', () => {
    const task = fakeTask({
      kind: 'reflect',
      status: 'skipped',
      output: { skipped: true, reason: 'no_gaps_identified' },
    });
    const narrative = buildTaskNarrative(task);
    expect(narrative).toContain('覆盖');
    expect(narrative).toMatch(/没有发现|准备进入综合/);
  });
});

describe('narrative — summarize', () => {
  it('reports draft length and source count', () => {
    const task = fakeTask({ kind: 'summarize' });
    const sources = [fakeSource('a'), fakeSource('b'), fakeSource('c')];
    const narrative = buildTaskNarrative(task, { sources, draftCharCount: 3500 });
    expect(narrative).toContain('3 条来源');
    expect(narrative).toMatch(/3\.5k 字|3500/);
  });

  it('warns when draft is empty', () => {
    const task = fakeTask({ kind: 'summarize' });
    const narrative = buildTaskNarrative(task, { sources: [], draftCharCount: 0 });
    expect(narrative).toContain('草稿为空');
  });
});

describe('narrative — verify_citation', () => {
  it('groups grounded claims by confidence tier', () => {
    const task = fakeTask({ kind: 'verify_citation' });
    const claims = [
      fakeClaim({ id: 'c1', confidence: 'high' }),
      fakeClaim({ id: 'c2', confidence: 'high' }),
      fakeClaim({ id: 'c3', confidence: 'medium' }),
      fakeClaim({ id: 'c4', confidence: 'unverified', evidence_spans: [{ source_id: 'x', span_text: 'y', stance: 'supports' }] }),
    ];
    const narrative = buildTaskNarrative(task, { claims });
    expect(narrative).toContain('CitationAgent');
    expect(narrative).toContain('2 强');
    expect(narrative).toContain('1 中');
    expect(narrative).toContain('1 未验证');
  });

  it('flags template fallback when no spans bound', () => {
    const task = fakeTask({ kind: 'verify_citation' });
    const claims = [
      fakeClaim({ id: 'c1', evidence_spans: [] }),
      fakeClaim({ id: 'c2', evidence_spans: [] }),
    ];
    const narrative = buildTaskNarrative(task, { claims });
    expect(narrative).toContain('兜底');
    expect(narrative).toContain('span 级 grounding');
  });

  it('flags empty claims as failure', () => {
    const task = fakeTask({ kind: 'verify_citation' });
    const narrative = buildTaskNarrative(task, { claims: [] });
    expect(narrative).toContain('未产出');
  });
});

describe('narrative — fetch / unknown', () => {
  it('returns hostname for fetch', () => {
    const task = fakeTask({ kind: 'fetch', input: { url: 'https://docs.example.com/api/pricing' } });
    expect(buildTaskNarrative(task)).toContain('docs.example.com');
  });

  it('returns null for outline / read_file (no narrative needed)', () => {
    expect(buildTaskNarrative(fakeTask({ kind: 'outline' }))).toBeNull();
    expect(buildTaskNarrative(fakeTask({ kind: 'read_file' }))).toBeNull();
  });
});
