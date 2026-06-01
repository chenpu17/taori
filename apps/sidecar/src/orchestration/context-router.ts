import type { CapabilityBus } from '../bus/index.js';
import type { MemoriesRepo } from '../db/repos/index.js';
import { buildConversationToolPolicy } from '../chat/tool-policy.js';
import { pickPreferredSearchToolName } from '../search/tool-selection.js';

export type ExternalInfoMode = 'none' | 'web_search' | 'web_search_fetch' | 'deep_research_suggest';
export type LocalContextMode = 'none' | 'file_search';

export interface OrchestrationPlan {
  type: 'orchestration_plan';
  externalInfo: ExternalInfoMode;
  localContext: LocalContextMode;
  reason:
    | 'none'
    | 'explicit_search'
    | 'freshness_required'
    | 'evidence_required'
    | 'high_stakes_current'
    | 'deep_research_candidate'
    | 'local_context_available';
  queries: string[];
  searchToolName: string | null;
  fetchTopK: number;
  citeRequired: boolean;
  allowModelToolUse: boolean;
}

export function buildChatOrchestrationPlan(args: {
  bus: CapabilityBus | null | undefined;
  memoriesRepo: MemoriesRepo;
  conversationId: string;
  userText: string;
  hasConversationFiles: boolean;
  skipToolName?: string | null;
}): OrchestrationPlan {
  const text = normalizeText(args.userText);
  const sessionToolPolicy = args.bus
    ? buildConversationToolPolicy(args.bus, args.memoriesRepo, args.conversationId, {
        skipToolName: args.skipToolName,
      })
    : {};
  const enabledToolNames = Object.entries(sessionToolPolicy)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name);
  const preferredSearchToolName = pickPreferredSearchToolName(
    args.bus,
    args.memoriesRepo.getEffective(args.conversationId, 'default_search_tool'),
    enabledToolNames,
  );

  const explicitSearch = needsExplicitSearch(text);
  const freshnessRequired = needsFreshness(text);
  const evidenceRequired = needsEvidence(text);
  const highStakesCurrent = needsHighStakesCurrentInfo(text);
  const deepCandidate = isDeepResearchCandidate(text);
  const localContext = args.hasConversationFiles || needsLocalContext(text) ? 'file_search' : 'none';

  let externalInfo: ExternalInfoMode = 'none';
  let reason: OrchestrationPlan['reason'] = localContext === 'file_search'
    ? 'local_context_available'
    : 'none';
  let fetchTopK = 0;
  let citeRequired = false;

  if (deepCandidate) {
    externalInfo = 'deep_research_suggest';
    reason = 'deep_research_candidate';
    fetchTopK = 3;
    citeRequired = true;
  } else if (highStakesCurrent) {
    externalInfo = 'web_search_fetch';
    reason = 'high_stakes_current';
    fetchTopK = 2;
    citeRequired = true;
  } else if (evidenceRequired) {
    externalInfo = 'web_search_fetch';
    reason = 'evidence_required';
    fetchTopK = 2;
    citeRequired = true;
  } else if (explicitSearch) {
    externalInfo = 'web_search';
    reason = 'explicit_search';
    citeRequired = true;
  } else if (freshnessRequired) {
    externalInfo = 'web_search';
    reason = 'freshness_required';
    citeRequired = true;
  }

  const searchToolName = externalInfo === 'none' ? null : preferredSearchToolName;
  const queries = searchToolName ? buildSearchQueries(text) : [];
  return {
    type: 'orchestration_plan',
    externalInfo,
    localContext,
    reason,
    queries,
    searchToolName,
    fetchTopK,
    citeRequired,
    allowModelToolUse: true,
  };
}

export function buildSearchQueries(text: string): string[] {
  const cleaned = normalizeText(text).slice(0, 180);
  if (!cleaned) return [];
  const queries = [cleaned];
  const currentYear = new Date().getFullYear();
  if (needsFreshness(cleaned) && !cleaned.includes(String(currentYear))) {
    queries.push(`${cleaned} ${currentYear}`);
  }
  return Array.from(new Set(queries)).slice(0, 2);
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function needsExplicitSearch(text: string): boolean {
  return /(搜索|搜一下|查一下|查询|检索|联网|上网|网上|浏览|查资料|找资料|search|browse|look up|google)/i.test(text);
}

function needsFreshness(text: string): boolean {
  return /(最新|最近|今日|今天|现在|当前|实时|刚刚|今年|明天|昨天|本周|本月|202[5-9]|新闻|公告|发布|更新|价格|股价|汇率|天气|版本|release|latest|recent|today|current|now|news|price|weather)/i.test(text);
}

function needsEvidence(text: string): boolean {
  return /(引用|来源|出处|证据|依据|数据|报告|论文|官网|原文|链接|对比|评测|推荐|排行|哪家|哪个好|是否还有效|cite|source|evidence|report|paper|benchmark|review|ranking)/i.test(text);
}

function needsHighStakesCurrentInfo(text: string): boolean {
  return /(报名|志愿|分数线|录取|招生|政策|考试|中考|高考|小升初|初升高|升学|学区|学校|签证|移民|税|法律|法规|医疗|药|保险|贷款|房贷|投资|admission|enrollment|policy|deadline|legal|medical|tax|visa)/i.test(text);
}

function isDeepResearchCandidate(text: string): boolean {
  const longEnough = text.length >= 80;
  return longEnough && /(深入|系统|全面|研究|调研|市场|行业|竞品|格局|趋势|方案|可行性|分析报告|deep research|market|industry|competitor|feasibility)/i.test(text);
}

function needsLocalContext(text: string): boolean {
  return /(附件|文件|文档|PDF|这份|上面|刚才上传|本地|知识库|file|attachment|document|pdf)/i.test(text);
}
