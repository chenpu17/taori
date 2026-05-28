/**
 * Research task handler: verify claims against collected sources.
 *
 * Extracted from ResearchRunner.runVerify. Prefers CitationAgent grounding
 * when model deps + draft + sources exist; falls back to a legacy
 * template-based section summary when CitationAgent is unavailable.
 */

import type {
  ResearchClaim,
  ResearchPlan,
  ResearchSession,
  ResearchSource,
} from '@taori/shared';
import type { MemoriesRepo, ModelsRepo, ProvidersRepo, ResearchRepo } from '../../db/repos/index.js';
import type { KeyStore } from '../../keystore.js';
import { runCitationVerification, confidenceToSupportStatus } from '../citation-agent.js';
import { pickSynthesisModel } from './shared.js';

export interface VerifyHandlerDeps {
  repo: ResearchRepo;
  modelsRepo?: ModelsRepo;
  providersRepo?: ProvidersRepo;
  keystore?: KeyStore;
  memories?: MemoriesRepo;
  log?: { info?: (msg: unknown, extra?: unknown) => void; warn?: (msg: unknown, extra?: unknown) => void; error?: (msg: unknown, extra?: unknown) => void };
}

export async function runVerify(
  deps: VerifyHandlerDeps,
  session: ResearchSession,
): Promise<void> {
  const plan = session.plan;
  if (!plan) return;
  const sources = deps.repo.listSources(session.id);
  const draft = (deps.repo.get(session.id)?.draft_markdown ?? session.draft_markdown ?? '').trim();

  // Prefer CitationAgent grounding when model deps + draft + sources exist.
  // Falls through to the legacy template-based summary only when CitationAgent
  // can't produce anything usable (no model, empty draft, or zero sources).
  if (deps.modelsRepo && deps.providersRepo && draft && sources.length > 0) {
    try {
      const result = await runCitationVerification(session, draft, sources, {
        modelsRepo: deps.modelsRepo,
        providersRepo: deps.providersRepo,
        keystore: deps.keystore ?? null,
        memories: deps.memories ?? null,
        log: deps.log,
        pickModel: () => pickSynthesisModel(
          session,
          deps.modelsRepo!,
          deps.providersRepo!,
          deps.keystore ?? null,
          deps.memories ?? null,
        ),
      });
      if (result.ok && result.claims.length > 0) {
        const verifiedAt = Date.now();
        const claims = result.claims.map<Omit<ResearchClaim, 'id' | 'research_session_id' | 'created_at' | 'updated_at'>>((c) => ({
          section_key: c.section_key,
          claim_text: c.claim_text,
          claim_kind: c.claim_kind,
          support_status: confidenceToSupportStatus(c.confidence, c.evidence_spans),
          citations: c.evidence_spans.map((span) => {
            const src = sources.find((s) => s.id === span.source_id);
            return {
              source_id: span.source_id,
              locator: src?.locator ?? null,
              note: span.span_text.slice(0, 240),
            };
          }),
          evidence_spans: c.evidence_spans,
          confidence: c.confidence,
          verified_at: verifiedAt,
        }));
        deps.repo.replaceClaims(session.id, claims);
        return;
      }
    } catch (err) {
      deps.log?.warn?.({ err, sessionId: session.id }, 'research.citation_agent_threw');
    }
  }

  // Fallback: legacy template-based section summaries. Kept so verify never
  // leaves the claims table empty when CitationAgent is unavailable.
  const sections = outputSections(plan.output_kind);
  const claims: Array<Omit<ResearchClaim, 'id' | 'research_session_id' | 'created_at' | 'updated_at'>> = [];
  for (let i = 0; i < sections.length; i += 1) {
    const section = sections[i] ?? `第 ${i + 1} 部分`;
    const question = pickQuestionForSection(plan, section, i);
    const matching = sources
      .filter((s) => matchesQuestion(s, question?.question ?? '', question?.id))
      .slice(0, 3);
    const support = pickSupport(matching);
    claims.push({
      section_key: section,
      claim_text: buildClaimText(section, question?.question ?? session.objective, matching),
      claim_kind: i === 0 ? 'recommendation' : 'fact',
      support_status: support,
      citations: matching.map((s) => ({ source_id: s.id, locator: s.locator, note: s.title })),
      evidence_spans: [],
      confidence: null,
      verified_at: null,
    });
  }
  deps.repo.replaceClaims(session.id, claims);
}

// ─── Template-based fallback helpers ───────────────────────────────────────

function outputSections(kind: ResearchPlan['output_kind']): string[] {
  if (kind === 'brief') return ['摘要', '关键事实', '风险', '下一步'];
  if (kind === 'comparison') return ['结论', '对比维度', '方案分析', '风险', '建议'];
  if (kind === 'decision') return ['结论', '判断依据', '可选路径', '风险与前提', '执行建议'];
  return ['结论', '证据', '风险', '建议', '待补充问题'];
}

function pickQuestionForSection(
  plan: ResearchPlan,
  section: string,
  index: number,
): ResearchPlan['key_questions'][number] | undefined {
  const priorities: Record<string, string[]> = {
    结论: ['现状判断', '方案差异', '推荐路径', '核心事实'],
    证据: ['问题拆解', '现状判断', '评估维度'],
    风险: ['风险争议'],
    建议: ['关键变量', '推荐路径', '方案差异'],
    待补充问题: ['问题拆解', '现状判断'],
    对比维度: ['评估维度'],
    方案分析: ['方案差异', '现状判断'],
    判断依据: ['决策条件', '现状判断'],
    可选路径: ['推荐路径', '方案差异'],
    风险与前提: ['风险争议', '决策条件'],
    执行建议: ['推荐路径', '关键变量'],
    摘要: ['核心事实', '现状判断'],
    关键事实: ['核心事实', '现状判断'],
    下一步: ['推荐路径', '关键变量'],
  };
  for (const reason of priorities[section] ?? []) {
    const found = plan.key_questions.find((question) => question.reason === reason);
    if (found) return found;
  }
  return plan.key_questions[index % Math.max(1, plan.key_questions.length)];
}

function pickSupport(matching: ResearchSource[]): 'supported' | 'weak' | 'unverified' {
  if (matching.length === 0) return 'unverified';
  if (matching.length === 1) return 'weak';
  return 'supported';
}

function matchesQuestion(source: ResearchSource, question: string, questionId?: string): boolean {
  if (questionId && source.metadata?.question_id === questionId) return true;
  if (
    questionId &&
    Array.isArray(source.metadata?.question_ids) &&
    source.metadata.question_ids.some((value) => value === questionId)
  ) {
    return true;
  }
  if (!question) return true;
  const hay = `${source.title ?? ''} ${source.snippet ?? ''}`.toLowerCase();
  if (!hay.trim()) return false;
  const tokens = meaningfulQuestionTokens(question);
  if (tokens.length === 0) return true;
  return tokens.some((t) => hay.includes(t));
}

function meaningfulQuestionTokens(question: string): string[] {
  const generic = new Set([
    'api',
    'apis',
    '模型',
    '大模型',
    '主流',
    '中国',
    '国产',
    '官方',
    '对比',
    '比较',
    '信息',
    '指标',
    '数据',
    '最新',
    '当前',
    'token',
    'tokens',
  ]);
  return question
    .toLowerCase()
    .split(/[\s,，。、？?!！:：;；()\[\]【】"'`]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !generic.has(token))
    .slice(0, 8);
}

function buildClaimText(section: string, question: string, sources: ResearchSource[]): string {
  if (sources.length === 0) {
    return `「${section}」目前缺少证据，需要继续检索 / 提供资料以确认：${question}`.slice(0, 1_900);
  }
  const lead = sources[0]!;
  const summary = (lead.snippet ?? lead.title ?? lead.locator).slice(0, 160).replace(/\s+/g, ' ');
  return `「${section}」围绕「${question}」可参考：${summary}…（共 ${sources.length} 条证据）`.slice(0, 1_900);
}
