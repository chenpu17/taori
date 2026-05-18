/**
 * CitationAgent — independent grounding pass.
 *
 * After the synthesis step produces a Markdown draft, this module runs a
 * separate LLM call whose job is *only* to verify which draft claims are
 * supported by which source spans. It does NOT browse, search, or invent —
 * its job is fact-binding within the pool of already-collected sources.
 *
 * Output is consumed by `runVerify` to replace the old template-based
 * `research_claims` rows with claim-level evidence spans + confidence,
 * which the UI then renders as a "引用核查" panel.
 *
 * Why decouple this from synthesis (Anthropic's recommended pattern):
 * generation and citation grounding optimize for different things — letting
 * the synthesis pass write freely + a dedicated pass align each assertion
 * back to source text yields more honest citations than asking one model to
 * do both at once.
 */

import { generateText } from 'ai';
import type {
  ResearchClaimConfidence,
  ResearchClaimEvidenceSpan,
  ResearchClaimEvidenceStance,
  ResearchClaimKind,
  ResearchSession,
  ResearchSource,
} from '@taori/shared';
import { createChatModel } from '../providers/chat-model.js';
import type { MemoriesRepo, ModelsRepo, ProvidersRepo } from '../db/repos/index.js';
import type { KeyStore } from '../keystore.js';

export interface CitationVerificationClaim {
  section_key: string;
  claim_text: string;
  claim_kind: ResearchClaimKind;
  evidence_spans: ResearchClaimEvidenceSpan[];
  confidence: ResearchClaimConfidence;
}

export interface CitationVerificationResult {
  claims: CitationVerificationClaim[];
  /** True if the LLM call succeeded and at least one claim was returned. */
  ok: boolean;
  /** Non-fatal warnings (model picked nothing, parse fallback used, etc.). */
  notes?: string[];
}

export interface CitationAgentDeps {
  modelsRepo: ModelsRepo;
  providersRepo: ProvidersRepo;
  keystore?: KeyStore | null;
  memories?: MemoriesRepo | null;
  log?: { warn?: (msg: unknown, extra?: unknown) => void; error?: (msg: unknown, extra?: unknown) => void };
  /** Model picker reused from task-runner so synthesis and citation share one config knob. */
  pickModel: () => Promise<{ model: import('@taori/shared').Model; provider: import('@taori/shared').Provider; apiKey: string } | null>;
}

const SOURCE_BUDGET_BY_MODE: Record<string, number> = {
  fast: 8,
  balanced: 12,
  deep: 16,
  custom: 12,
};
const PER_SOURCE_SNIPPET_CHARS = 3500;
const CITATION_OUTPUT_MAX_TOKENS = 4000;
const CITATION_TIMEOUT_MS = 45_000;

export async function runCitationVerification(
  session: ResearchSession,
  draft: string,
  sources: ResearchSource[],
  deps: CitationAgentDeps,
): Promise<CitationVerificationResult> {
  if (!draft.trim() || sources.length === 0) {
    return { ok: false, claims: [], notes: ['no_draft_or_sources'] };
  }

  const picked = await deps.pickModel();
  if (!picked) {
    return { ok: false, claims: [], notes: ['no_usable_model'] };
  }

  const limit = SOURCE_BUDGET_BY_MODE[session.budget_mode] ?? 12;
  const orderedSources = [...sources]
    .sort((a, b) => (b.credibility_score ?? 0.5) - (a.credibility_score ?? 0.5))
    .slice(0, limit);

  const prompt = buildCitationPrompt(session, draft, orderedSources);
  const { model: chatModel } = createChatModel({
    provider: picked.provider,
    model: picked.model,
    apiKey: picked.apiKey,
  });

  let text = '';
  try {
    const result = await generateText({
      model: chatModel,
      prompt,
      maxTokens: CITATION_OUTPUT_MAX_TOKENS,
      abortSignal: AbortSignal.timeout(CITATION_TIMEOUT_MS),
    });
    text = result.text;
  } catch (err) {
    deps.log?.warn?.({ err, sessionId: session.id }, 'research.citation_agent_failed');
    return { ok: false, claims: [], notes: ['llm_call_failed'] };
  }

  const parsed = parseCitationResponse(text, new Set(orderedSources.map((s) => s.id)));
  if (parsed.length === 0) {
    return { ok: false, claims: [], notes: ['empty_or_unparseable'] };
  }
  return { ok: true, claims: parsed };
}

export function buildCitationPrompt(
  session: ResearchSession,
  draft: string,
  sources: ResearchSource[],
): string {
  const sourceBlocks = sources.map((source, index) => {
    const title = (source.title ?? source.locator).slice(0, 200);
    const snippet = (source.snippet ?? '').slice(0, PER_SOURCE_SNIPPET_CHARS).replace(/\s+/g, ' ');
    const credLabel = formatCredibility(source.credibility_score);
    return `[${source.id}] #${index + 1}
标题：${title}
URL：${source.locator}
可信度：${credLabel}
原文（截断 ${PER_SOURCE_SNIPPET_CHARS} 字内）：${snippet || '（无摘要）'}`;
  }).join('\n\n---\n\n');

  return `你是研究引用核查师，专门把研究草稿中的论断绑回原始来源的具体原文片段。

任务：
1. 从【草稿】中抽出关键论断（重要事实、对比结论、推荐建议、风险判断）。
   - 一条论断 ≤200 字，应是可独立判定真假的陈述句
   - 不要抽取章节标题、过渡句、纯结构性内容
   - 总数 8-20 条
2. 对每条论断，在【来源池】中找出支持/反驳它的具体原文片段（30-300 字逐字摘录）
3. 评估每条论断的信心：
   - high：≥2 个高可信来源直接支持，无明显矛盾
   - medium：1 个来源直接支持，或多源但有小分歧
   - low：仅有间接证据，或仅低可信来源支撑
   - unverified：来源池中找不到能支持或反驳的具体片段

严格规则：
- 不得编造来源池外的事实
- span_text 必须是来源原文的逐字片段（允许去除多余空白）；禁止改写、总结或翻译
- source_id 必须使用下方来源池中的 ID（方括号里的字符串），不要写成 [#1] 等编号
- stance 取 supports / contradicts / partial 之一
- claim_kind 取 fact / inference / recommendation / comparison 之一
- section_key 用对应的草稿章节标题（如未明确则用"综合"）

━━━ 草稿 ━━━

${draft}

━━━ 来源池（共 ${sources.length} 条，按可信度排序）━━━

${sourceBlocks}

━━━ 输出 ━━━

严格输出 JSON，禁止任何额外文字、Markdown 代码块或注释：

{
  "claims": [
    {
      "section_key": "...",
      "claim_text": "...",
      "claim_kind": "fact",
      "confidence": "high",
      "evidence_spans": [
        { "source_id": "<来源ID>", "span_text": "<原文逐字片段>", "stance": "supports" }
      ]
    }
  ]
}`;
}

function formatCredibility(score: number | null | undefined): string {
  const s = score ?? 0.5;
  if (s >= 0.85) return '★高';
  if (s >= 0.7) return '★中';
  return '★低';
}

export function parseCitationResponse(
  text: string,
  validSourceIds: Set<string>,
): CitationVerificationClaim[] {
  if (!text) return [];
  const cleaned = text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
  const jsonStart = cleaned.indexOf('{');
  const jsonEnd = cleaned.lastIndexOf('}');
  if (jsonStart === -1 || jsonEnd === -1) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(cleaned.slice(jsonStart, jsonEnd + 1));
  } catch {
    return [];
  }
  if (!raw || typeof raw !== 'object') return [];
  const claimsRaw = (raw as { claims?: unknown }).claims;
  if (!Array.isArray(claimsRaw)) return [];

  const claims: CitationVerificationClaim[] = [];
  for (const entry of claimsRaw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const rec = entry as Record<string, unknown>;
    const claim_text = typeof rec.claim_text === 'string' ? rec.claim_text.trim().slice(0, 1900) : '';
    if (!claim_text) continue;
    const section_key = typeof rec.section_key === 'string' && rec.section_key.trim()
      ? rec.section_key.trim().slice(0, 80)
      : '综合';
    const claim_kind = normalizeClaimKind(rec.claim_kind);
    const confidence = normalizeConfidence(rec.confidence);
    const spansRaw = Array.isArray(rec.evidence_spans) ? rec.evidence_spans : [];
    const evidence_spans: ResearchClaimEvidenceSpan[] = [];
    for (const s of spansRaw) {
      if (!s || typeof s !== 'object' || Array.isArray(s)) continue;
      const sRec = s as Record<string, unknown>;
      const source_id = typeof sRec.source_id === 'string' ? sRec.source_id.trim() : '';
      const span_text = typeof sRec.span_text === 'string' ? sRec.span_text.trim() : '';
      if (!source_id || !span_text) continue;
      if (!validSourceIds.has(source_id)) continue;
      const stance = normalizeStance(sRec.stance);
      evidence_spans.push({
        source_id,
        span_text: span_text.slice(0, 600),
        stance,
      });
      if (evidence_spans.length >= 6) break;
    }
    // If confidence claims support but no spans bind, downgrade to unverified.
    let finalConfidence: ResearchClaimConfidence = confidence;
    if (evidence_spans.length === 0 && finalConfidence !== 'unverified') {
      finalConfidence = 'unverified';
    }
    claims.push({
      section_key,
      claim_text,
      claim_kind,
      confidence: finalConfidence,
      evidence_spans,
    });
    if (claims.length >= 30) break;
  }
  return claims;
}

function normalizeClaimKind(value: unknown): ResearchClaimKind {
  // Note: shared schema currently restricts to fact|inference|recommendation.
  // Treat 'comparison' as 'inference' to avoid breaking the union.
  if (value === 'fact' || value === 'inference' || value === 'recommendation') return value;
  if (value === 'comparison') return 'inference';
  return 'fact';
}

function normalizeConfidence(value: unknown): ResearchClaimConfidence {
  if (value === 'high' || value === 'medium' || value === 'low' || value === 'unverified') return value;
  return 'low';
}

function normalizeStance(value: unknown): ResearchClaimEvidenceStance {
  if (value === 'supports' || value === 'contradicts' || value === 'partial') return value;
  return 'supports';
}

export function confidenceToSupportStatus(
  confidence: ResearchClaimConfidence,
  spans: ResearchClaimEvidenceSpan[],
): 'supported' | 'weak' | 'conflicted' | 'unverified' {
  const hasContradiction = spans.some((s) => s.stance === 'contradicts');
  const hasSupport = spans.some((s) => s.stance === 'supports');
  if (hasContradiction && hasSupport) return 'conflicted';
  if (confidence === 'unverified' || spans.length === 0) return 'unverified';
  if (confidence === 'high') return 'supported';
  return 'weak';
}
