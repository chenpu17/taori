import { describe, expect, it } from 'vitest';
import type { ResearchSession, ResearchSource } from '@taori/shared';
import {
  buildCitationPrompt,
  confidenceToSupportStatus,
  parseCitationResponse,
} from '../src/research/citation-agent.js';

function fakeSession(): ResearchSession {
  const now = Date.now();
  return {
    id: 'sess1',
    conversation_id: null,
    title: 'Test',
    objective: 'Test objective',
    output_kind: 'report',
    status: 'running',
    stage: 'verifying',
    budget_mode: 'balanced',
    budget_limit_usd: null,
    budget_spent_usd: 0,
    constraints: { must_cover: [] },
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
  };
}

function fakeSource(id: string, title: string, snippet = ''): ResearchSource {
  return {
    id,
    research_session_id: 'sess1',
    source_type: 'web_page',
    title,
    locator: `https://example.com/${id}`,
    snippet,
    credibility_score: 0.8,
    included: true,
    metadata: {},
    created_at: Date.now(),
  };
}

describe('CitationAgent — parseCitationResponse', () => {
  const validIds = new Set(['src_a', 'src_b']);

  it('parses well-formed grounded claims', () => {
    const text = JSON.stringify({
      claims: [
        {
          section_key: '结论',
          claim_text: 'GPT-5 在编程基准上超过 70%。',
          claim_kind: 'fact',
          confidence: 'high',
          evidence_spans: [
            { source_id: 'src_a', span_text: 'GPT-5 achieves 76% on benchmark', stance: 'supports' },
            { source_id: 'src_b', span_text: 'Reproduced 74% in our run', stance: 'supports' },
          ],
        },
        {
          section_key: '风险',
          claim_text: '存在评测被污染的风险。',
          claim_kind: 'inference',
          confidence: 'medium',
          evidence_spans: [
            { source_id: 'src_a', span_text: 'contamination remains a concern', stance: 'partial' },
          ],
        },
      ],
    });
    const result = parseCitationResponse(text, validIds);
    expect(result).toHaveLength(2);
    expect(result[0].confidence).toBe('high');
    expect(result[0].evidence_spans).toHaveLength(2);
    expect(result[1].evidence_spans[0].stance).toBe('partial');
  });

  it('drops spans whose source_id is not in the known pool', () => {
    const text = JSON.stringify({
      claims: [
        {
          section_key: '结论',
          claim_text: 'x',
          claim_kind: 'fact',
          confidence: 'high',
          evidence_spans: [
            { source_id: 'src_a', span_text: 'real source supports x' },
            { source_id: 'fake_id', span_text: 'this should be dropped' },
          ],
        },
      ],
    });
    const result = parseCitationResponse(text, validIds);
    expect(result).toHaveLength(1);
    expect(result[0].evidence_spans).toHaveLength(1);
    expect(result[0].evidence_spans[0].source_id).toBe('src_a');
  });

  it('downgrades confidence to unverified when no spans bind', () => {
    const text = JSON.stringify({
      claims: [
        {
          section_key: '结论',
          claim_text: 'orphan claim',
          claim_kind: 'fact',
          confidence: 'high',
          evidence_spans: [{ source_id: 'fake_id', span_text: 'fake' }],
        },
      ],
    });
    const result = parseCitationResponse(text, validIds);
    expect(result).toHaveLength(1);
    expect(result[0].confidence).toBe('unverified');
    expect(result[0].evidence_spans).toHaveLength(0);
  });

  it('handles fenced code block wrapping', () => {
    const text = '```json\n' + JSON.stringify({
      claims: [{
        section_key: 'x',
        claim_text: 'wrapped',
        claim_kind: 'fact',
        confidence: 'low',
        evidence_spans: [{ source_id: 'src_a', span_text: 'snippet' }],
      }],
    }) + '\n```';
    const result = parseCitationResponse(text, validIds);
    expect(result).toHaveLength(1);
    expect(result[0].claim_text).toBe('wrapped');
  });

  it('returns empty array for unparseable text', () => {
    expect(parseCitationResponse('not json at all', validIds)).toEqual([]);
    expect(parseCitationResponse('', validIds)).toEqual([]);
    expect(parseCitationResponse('{not valid}', validIds)).toEqual([]);
  });

  it('normalizes unknown claim_kind/confidence/stance values', () => {
    const text = JSON.stringify({
      claims: [{
        section_key: 'x',
        claim_text: 'normalize',
        claim_kind: 'comparison',
        confidence: 'extremely-high',
        evidence_spans: [{ source_id: 'src_a', span_text: 'snippet', stance: 'maybe' }],
      }],
    });
    const result = parseCitationResponse(text, validIds);
    expect(result).toHaveLength(1);
    // 'comparison' folds to 'inference' (shared schema doesn't accept comparison)
    expect(result[0].claim_kind).toBe('inference');
    // 'extremely-high' falls back to 'low'
    expect(result[0].confidence).toBe('low');
    // 'maybe' falls back to 'supports'
    expect(result[0].evidence_spans[0].stance).toBe('supports');
  });
});

describe('CitationAgent — confidenceToSupportStatus', () => {
  it('maps high+supports to supported', () => {
    const status = confidenceToSupportStatus('high', [
      { source_id: 's', span_text: 't', stance: 'supports' },
    ]);
    expect(status).toBe('supported');
  });

  it('flags conflicted when both supports and contradicts present', () => {
    const status = confidenceToSupportStatus('high', [
      { source_id: 'a', span_text: 't', stance: 'supports' },
      { source_id: 'b', span_text: 't', stance: 'contradicts' },
    ]);
    expect(status).toBe('conflicted');
  });

  it('maps unverified or empty spans to unverified', () => {
    expect(confidenceToSupportStatus('unverified', [])).toBe('unverified');
    expect(confidenceToSupportStatus('high', [])).toBe('unverified');
  });

  it('maps medium/low to weak', () => {
    expect(
      confidenceToSupportStatus('medium', [{ source_id: 'a', span_text: 't', stance: 'supports' }]),
    ).toBe('weak');
    expect(
      confidenceToSupportStatus('low', [{ source_id: 'a', span_text: 't', stance: 'supports' }]),
    ).toBe('weak');
  });
});

describe('CitationAgent — buildCitationPrompt', () => {
  it('includes draft and each source with its id and snippet', () => {
    const session = fakeSession();
    const sources = [
      fakeSource('src_a', 'Source A', 'snippet content for A'),
      fakeSource('src_b', 'Source B', 'snippet content for B'),
    ];
    const prompt = buildCitationPrompt(session, '# Draft\n\nSome claim about X.', sources);
    expect(prompt).toContain('# Draft');
    expect(prompt).toContain('Some claim about X.');
    expect(prompt).toContain('[src_a]');
    expect(prompt).toContain('Source A');
    expect(prompt).toContain('snippet content for A');
    expect(prompt).toContain('[src_b]');
    // Strict instructions about not inventing
    expect(prompt).toMatch(/不得编造|禁止改写|逐字/);
  });
});
