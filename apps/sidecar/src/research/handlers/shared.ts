/**
 * Shared utilities consumed by multiple research task handlers.
 *
 * `pickSynthesisModel` resolves the LLM to use for synthesis / reflect /
 * verify. `buildDraft` produces the template-based fallback markdown.
 */

import type {
  Model,
  Provider,
  ResearchPlan,
  ResearchSession,
  ResearchSource,
} from '@taori/shared';
import type { MemoriesRepo, ModelsRepo, ProvidersRepo } from '../../db/repos/index.js';
import type { KeyStore } from '../../keystore.js';

// ─── Model picker ──────────────────────────────────────────────────────────

export async function pickSynthesisModel(
  session: ResearchSession,
  modelsRepo: ModelsRepo,
  providersRepo: ProvidersRepo,
  keystore: KeyStore | null,
  memories: MemoriesRepo | null,
): Promise<{ model: Model; provider: Provider; apiKey: string } | null> {
  // Priority chain: per-session synthesis override -> per-session preferred chat model ->
  // memories 'default_research_synthesis_model' -> memories 'default_model_id' ->
  // first available chat model. The synthesis-specific knobs let users pick a
  // beefier model (e.g. Opus) for research even when chat defaults to a cheaper
  // one.
  const synthesisOverride = session.synthesis_model_id
    ?? memories?.getEffective(session.conversation_id ?? null, 'default_research_synthesis_model')
    ?? null;
  const candidateIds = [
    synthesisOverride,
    session.preferred_model_id,
    memories?.getEffective(null, 'default_model_id') ?? null,
  ].filter((id): id is string => typeof id === 'string' && id.length > 0);

  let model: Model | null = null;
  for (const id of candidateIds) {
    const candidate = modelsRepo.get(id);
    if (candidate?.enabled && candidate.provider_id) {
      model = candidate;
      break;
    }
  }
  if (!model?.enabled || !model.provider_id) {
    model = modelsRepo.defaultFor('chat') ?? modelsRepo.pickCheapestActive('chat', '__none__');
  }
  if (!model?.provider_id) return null;

  const provider = providersRepo.get(model.provider_id);
  if (!provider) return null;

  let apiKey = '';
  if (provider.api_key_ref && keystore) {
    try {
      apiKey = (await keystore.read(provider.api_key_ref)) ?? '';
    } catch {
      // key unavailable
    }
  }

  return { model, provider, apiKey };
}

// ─── Template-based draft builder ──────────────────────────────────────────

export function buildDraft(
  session: ResearchSession,
  plan: ResearchPlan,
  sources: ResearchSource[],
): string {
  const lines: string[] = [
    `# ${session.title}`,
    '',
    '## 研究目标',
    '',
    session.objective,
    '',
    '## 计划摘要',
    '',
    plan.summary,
  ];
  if (plan.key_questions.length > 0) {
    lines.push('', '## 关键问题与证据');
    for (const q of plan.key_questions) {
      lines.push('', `### ${q.question}`);
      const matching = sources.filter((s) => matchesQuestion(s, q.question, q.id)).slice(0, 5);
      if (matching.length === 0) {
        lines.push('', '_暂无匹配证据，建议扩大检索关键词或追加来源。_');
        continue;
      }
      for (const s of matching) {
        const title = (s.title ?? s.locator).slice(0, 120);
        const snippet = (s.snippet ?? '').slice(0, 220).replace(/\s+/g, ' ');
        lines.push('', `- [${title}](${s.locator})`);
        if (snippet) lines.push(`  - ${snippet}`);
      }
    }
  }
  lines.push('', '## 待人工确认的问题', '', '- 是否需要继续追加证据或重跑搜索');
  return `${lines.join('\n').trim()}\n`;
}

// ─── Small helpers also used by verify ─────────────────────────────────────

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
