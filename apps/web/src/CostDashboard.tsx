import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatUsd, type Model, type ModelHealthRow, type Provider } from '@taori/shared';
import { api } from './api.js';
import { providerTypeDisplay } from './providerLabels.js';

type CostScope = 'today' | 'week' | 'month';
type CostGroupBy = 'model' | 'conversation' | 'feature' | 'tag';

interface CostDashboardProps {
  onClose: () => void;
  embedded?: boolean;
  focusTarget?: CostCallFocusTarget | null;
  onFocusConsumed?: () => void;
  onOpenModels?: () => void;
}

interface CostRunFocusDetail {
  conversationId: string;
  runId: string;
  runEventId: string | null;
  costRecordId: string;
}

interface CostCallFocusTarget {
  costRecordId: string | null;
  runId: string | null;
  runEventId: string | null;
  providerKey?: string | null;
  modelId?: string | null;
  preferredScope?: CostScope;
}

interface DashboardRow {
  key: string;
  label: string;
  model_id: string | null;
  model_name_snapshot: string | null;
  conversation_id: string | null;
  conversation_title: string | null;
  feature: string | null;
  sum_usd: number;
  count: number;
  success_count: number;
  billed_failure_count: number;
  trend: Array<{
    bucket_start: number;
    label: string;
    sum_usd: number;
    count: number;
  }>;
}

interface DashboardApiRow {
  key?: string;
  label?: string;
  model_id?: string | null;
  model_name_snapshot?: string | null;
  conversation_id?: string | null;
  conversation_title?: string | null;
  feature?: string | null;
  sum_usd?: number;
  count?: number;
  success_count?: number;
  billed_failure_count?: number;
  trend?: Array<{
    bucket_start?: number;
    label?: string;
    sum_usd?: number;
    count?: number;
  }>;
}

interface AdvisorInsight {
  id: string;
  tone: 'neutral' | 'positive' | 'caution';
  title: string;
  summary: string;
  detail: string;
  chips: string[];
}

interface BudgetAlertInsight {
  id: string;
  tone: 'watch' | 'over';
  title: string;
  detail: string;
  chips: string[];
}

interface ProviderSpendInsight {
  key: string;
  label: string;
  providerType: string;
  providerTypeLabel: string;
  sumUsd: number;
  count: number;
  successCount: number;
  billedFailureCount: number;
  modelCount: number;
  share: number;
}

interface FocusedModelHealthInsight {
  state: 'healthy' | 'demoted' | 'cooldown';
  failureRate: number | null;
  failures24h: number;
  calls24h: number;
  avgFirstTokenMs: number | null;
  lastFailureLabel: string | null;
  disabledUntil: number | null;
}

interface CallLogRow {
  id: string;
  created_at: number;
  conversation_id: string | null;
  conversation_title: string | null;
  source_type: string;
  source_id: string | null;
  feature: string;
  model_id: string | null;
  model_name_snapshot: string;
  provider_name: string | null;
  provider_type: string | null;
  input_tokens: number | null;
  cache_input_tokens: number | null;
  output_tokens: number | null;
  actual_cost_usd: number | null;
  success: boolean;
  classification: string | null;
  first_token_ms: number | null;
  duration_ms: number | null;
  run_id: string | null;
  run_event_id: string | null;
  run_event_kind: string | null;
  run_event_label: string | null;
}

const GROUP_LABELS: Record<CostGroupBy, string> = {
  model: '按模型',
  conversation: '按会话',
  feature: '按特性',
  tag: '按项目/标签',
};

const SCOPE_LABELS: Record<CostScope, string> = {
  today: '今日',
  week: '本周',
  month: '本月',
};

const FAILURE_LABELS: Record<string, string> = {
  rate_limit: '限流',
  quota: '额度耗尽',
  network: '网络失败',
  auth: '鉴权失败',
  config_error: '配置错误',
  content_filter: '内容拦截',
  key_missing: 'Key 缺失',
  unknown: '未知失败',
};

function formatCount(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function modelPriceScore(model: Model): number | null {
  if (model.capability === 'image') return model.price_per_image;
  if (model.capability === 'video') return model.price_per_video_second;
  if (model.price_per_call != null) return model.price_per_call;
  if (model.price_input_per_1m != null || model.price_output_per_1m != null) {
    return (model.price_input_per_1m ?? 0) + (model.price_output_per_1m ?? 0);
  }
  return null;
}

function modelCapabilityLabel(model: Model): string {
  if (model.capability === 'multimodal') return '多模态';
  if (model.capability === 'chat') return '聊天';
  if (model.capability === 'image') return '图像生成';
  if (model.capability === 'video') return '视频生成';
  return model.capability;
}

function countLabel(groupBy: CostGroupBy, value: number, kind: 'count' | 'success' | 'billed_failure'): string {
  const prefix = groupBy === 'tag' ? '折算' : '';
  if (kind === 'success') return `${prefix}${formatCount(value)} 成功`;
  if (kind === 'billed_failure') return `计费失败 ${prefix}${formatCount(value)}`;
  return `${prefix}${formatCount(value)} 次`;
}

const SOURCE_LABELS: Record<string, string> = {
  message: '聊天',
  roundtable_message: '圆桌',
  topic_analyzer: '圆桌规划',
  summarizer: '圆桌总结',
  tool_call: '工具',
};

function dispatchCostRunFocus(detail: CostRunFocusDetail): void {
  window.dispatchEvent(new CustomEvent<CostRunFocusDetail>('taori:focus-run-event', { detail }));
}

function normalizeDashboardRow(row: DashboardApiRow, groupBy: CostGroupBy): DashboardRow {
  const modelId = typeof row.model_id === 'string' ? row.model_id : null;
  const modelNameSnapshot =
    typeof row.model_name_snapshot === 'string' ? row.model_name_snapshot : null;
  const conversationId =
    typeof row.conversation_id === 'string' ? row.conversation_id : null;
  const conversationTitle =
    typeof row.conversation_title === 'string' ? row.conversation_title : null;
  const feature = typeof row.feature === 'string' ? row.feature : null;
  const fallbackLabel =
    groupBy === 'model'
      ? modelNameSnapshot ?? '(已删除模型)'
      : groupBy === 'conversation'
        ? (conversationTitle ?? (conversationId ? '未命名会话' : '无会话归属'))
        : (feature ?? '未分类');

  return {
    key: typeof row.key === 'string' ? row.key : modelId ?? conversationId ?? feature ?? fallbackLabel,
    label: typeof row.label === 'string' ? row.label : fallbackLabel,
    model_id: modelId,
    model_name_snapshot: modelNameSnapshot,
    conversation_id: conversationId,
    conversation_title: conversationTitle,
    feature,
    sum_usd: typeof row.sum_usd === 'number' ? row.sum_usd : 0,
    count: typeof row.count === 'number' ? row.count : 0,
    success_count: typeof row.success_count === 'number' ? row.success_count : 0,
    billed_failure_count:
      typeof row.billed_failure_count === 'number' ? row.billed_failure_count : 0,
    trend: Array.isArray(row.trend)
      ? row.trend.map((point) => ({
          bucket_start: typeof point.bucket_start === 'number' ? point.bucket_start : 0,
          label: typeof point.label === 'string' ? point.label : '',
          sum_usd: typeof point.sum_usd === 'number' ? point.sum_usd : 0,
          count: typeof point.count === 'number' ? point.count : 0,
        }))
      : [],
  };
}

function sparklinePath(points: number[], width: number, height: number): string {
  if (points.length === 0) return '';
  const max = Math.max(...points, 0.000001);
  const stepX = points.length <= 1 ? width : width / (points.length - 1);
  return points
    .map((value, index) => {
      const x = Number((index * stepX).toFixed(2));
      const y = Number((height - (value / max) * (height - 2) - 1).toFixed(2));
      return `${index === 0 ? 'M' : 'L'}${x},${y}`;
    })
    .join(' ');
}

function Sparkline({
  trend,
}: {
  trend: DashboardRow['trend'];
}): JSX.Element {
  const values = trend.map((point) => point.sum_usd);
  const path = sparklinePath(values, 96, 28);
  const hasValue = values.some((value) => value > 0);
  return (
    <svg
      className="cost-dashboard-sparkline"
      width="96"
      height="28"
      viewBox="0 0 96 28"
      fill="none"
      aria-hidden="true"
      data-testid="cost-dashboard-sparkline"
    >
      <path d="M0 27.5H96" stroke="currentColor" strokeOpacity="0.08" />
      {hasValue ? (
        <path
          d={path}
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : (
        <path
          d="M0 18 L96 18"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeOpacity="0.35"
        />
      )}
    </svg>
  );
}

export function CostDashboard({
  onClose,
  embedded = false,
  focusTarget = null,
  onFocusConsumed,
  onOpenModels,
}: CostDashboardProps): JSX.Element {
  const [scope, setScope] = useState<CostScope>('today');
  const [groupBy, setGroupBy] = useState<CostGroupBy>('model');
  const [rows, setRows] = useState<DashboardRow[] | null>(null);
  const [callLogs, setCallLogs] = useState<CallLogRow[] | null>(null);
  const [advisorModelRows, setAdvisorModelRows] = useState<DashboardRow[] | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [modelHealthRows, setModelHealthRows] = useState<ModelHealthRow[]>([]);
  const [todayUsd, setTodayUsd] = useState<number | null>(null);
  const [monthUsd, setMonthUsd] = useState<number | null>(null);
  const [dailyBudgetUsd, setDailyBudgetUsd] = useState<number | null>(null);
  const [monthlyBudgetUsd, setMonthlyBudgetUsd] = useState<number | null>(null);
  const [dailyHardLimit, setDailyHardLimit] = useState(false);
  const [monthlyHardLimit, setMonthlyHardLimit] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [exportingFormat, setExportingFormat] = useState<'csv' | 'json' | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [focusedCostRecordId, setFocusedCostRecordId] = useState<string | null>(null);
  const [focusedProviderKey, setFocusedProviderKey] = useState<string | null>(null);
  const [focusedModelId, setFocusedModelId] = useState<string | null>(null);
  const refreshSeq = useRef(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!embedded && e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, embedded]);

  const refresh = useCallback(async (reset: boolean): Promise<void> => {
    const seq = ++refreshSeq.current;
      if (reset) setRows(null);
      if (reset) setCallLogs(null);
      if (reset) setAdvisorModelRows(null);
      setRefreshing(true);
      setError(null);
      try {
        const [
          res,
          logs,
          modelBreakdown,
          modelRes,
          providerRes,
          modelHealthRes,
          realtimeRes,
          dailyBudgetRes,
          monthlyBudgetRes,
          dailyHardLimitRes,
          monthlyHardLimitRes,
        ] = await Promise.all([
          api.costsDashboardBreakdown(scope, groupBy),
          api.costsCallLogs(50),
          api.costsDashboardBreakdown(scope, 'model'),
          api.listModels(),
          api.listProviders(),
          api.modelsHealth().catch(() => ({ rows: [] })),
          api.costsRealtime().catch(() => ({ data: { today_usd: null, month_usd: null } })),
          api.getMemoryEffective('daily_budget_usd').catch(() => ({ data: { value: null as string | null } })),
          api.getMemoryEffective('monthly_budget_usd').catch(() => ({ data: { value: null as string | null } })),
          api.getMemoryEffective('daily_budget_hard_limit').catch(() => ({ data: { value: null as string | null } })),
          api.getMemoryEffective('monthly_budget_hard_limit').catch(() => ({ data: { value: null as string | null } })),
        ]);
        if (seq !== refreshSeq.current) return;
        setRows((res.data.rows ?? []).map((row) => normalizeDashboardRow(row, groupBy)));
        setCallLogs(logs.data.rows ?? []);
        setAdvisorModelRows((modelBreakdown.data.rows ?? []).map((row) => normalizeDashboardRow(row, 'model')));
        setModels(modelRes.models ?? []);
        setProviders(providerRes.providers ?? []);
        setModelHealthRows(modelHealthRes.rows ?? []);
        setTodayUsd(typeof realtimeRes.data.today_usd === 'number' ? realtimeRes.data.today_usd : null);
        setMonthUsd(typeof realtimeRes.data.month_usd === 'number' ? realtimeRes.data.month_usd : null);
        const parsedDaily = Number(dailyBudgetRes.data.value);
        const parsedMonthly = Number(monthlyBudgetRes.data.value);
        setDailyBudgetUsd(Number.isFinite(parsedDaily) && parsedDaily > 0 ? parsedDaily : null);
        setMonthlyBudgetUsd(Number.isFinite(parsedMonthly) && parsedMonthly > 0 ? parsedMonthly : null);
        setDailyHardLimit(dailyHardLimitRes.data.value === 'true');
        setMonthlyHardLimit(monthlyHardLimitRes.data.value === 'true');
        setLastUpdatedAt(Date.now());
      } catch (e) {
      if (seq !== refreshSeq.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (seq === refreshSeq.current) setRefreshing(false);
    }
  }, [scope, groupBy]);

  const refreshFocusedCall = useCallback(async (costRecordId: string): Promise<void> => {
    const seq = ++refreshSeq.current;
    setRefreshing(true);
    setError(null);
    try {
      const logs = await api.costsCallLogs(1, { costRecordId });
      if (seq !== refreshSeq.current) return;
      const focusedRows = logs.data.rows ?? [];
      setCallLogs((prev) => {
        const rest = (prev ?? []).filter((row) => row.id !== costRecordId);
        return [...focusedRows, ...rest].slice(0, 12);
      });
      setLastUpdatedAt(Date.now());
    } catch (e) {
      if (seq !== refreshSeq.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (seq === refreshSeq.current) setRefreshing(false);
    }
  }, []);
  const applyProviderFocus = useCallback((providerKey: string, costRecordId: string | null = null): void => {
    setGroupBy('model');
    setFocusedProviderKey(providerKey);
    setFocusedModelId(null);
    setFocusedCostRecordId(costRecordId);
    if (costRecordId) {
      void refreshFocusedCall(costRecordId);
    }
  }, [refreshFocusedCall]);
  const applyModelFocus = useCallback((modelId: string, costRecordId: string | null = null): void => {
    setGroupBy('model');
    setFocusedProviderKey(null);
    setFocusedModelId(modelId);
    setFocusedCostRecordId(costRecordId);
    if (costRecordId) {
      void refreshFocusedCall(costRecordId);
    }
  }, [refreshFocusedCall]);

  useEffect(() => {
    let cancelled = false;
    const run = async (reset: boolean): Promise<void> => {
      if (cancelled) return;
      await refresh(reset);
    };
    void run(true);
    const timer = window.setInterval(() => void run(false), 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [refresh]);

  useEffect(() => {
    if (!focusTarget) return;
    if (focusTarget.preferredScope) {
      setScope((current) => (current === focusTarget.preferredScope ? current : focusTarget.preferredScope!));
    }
    if (focusTarget.modelId) {
      applyModelFocus(focusTarget.modelId, focusTarget.costRecordId ?? null);
      return;
    }
    setGroupBy('model');
    setFocusedProviderKey(focusTarget.providerKey ?? null);
    setFocusedModelId(null);
    setFocusedCostRecordId(focusTarget.costRecordId ?? null);
    if (!focusTarget.costRecordId) return;
    void refreshFocusedCall(focusTarget.costRecordId);
  }, [applyModelFocus, focusTarget, refreshFocusedCall]);

  useEffect(() => {
    if (!focusedCostRecordId || callLogs == null) return;
    const target = document.querySelector(
      `[data-testid="cost-call-log-row"][data-cost-record-id="${focusedCostRecordId}"]`,
    );
    target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    if (target) onFocusConsumed?.();
  }, [callLogs, focusedCostRecordId, onFocusConsumed]);

  const advisorInsights = useMemo(() => {
    if (!advisorModelRows || advisorModelRows.length === 0) return [] as AdvisorInsight[];
    const modelById = new Map(models.map((model) => [model.id, model]));
    const healthByModelId = new Map(modelHealthRows.map((row) => [row.model_id, row]));
    const totalModelSpend = advisorModelRows.reduce((sum, row) => sum + row.sum_usd, 0);
    const topSpendRow = advisorModelRows[0]!;
    const topModel = topSpendRow.model_id ? modelById.get(topSpendRow.model_id) ?? null : null;
    const share = totalModelSpend > 0 ? topSpendRow.sum_usd / totalModelSpend : 0;
    const insights: AdvisorInsight[] = [
      {
        id: 'hotspot',
        tone: share >= 0.45 ? 'caution' : 'neutral',
        title: '当前最大成本热点',
        summary: `${topSpendRow.label} 在${SCOPE_LABELS[scope]}按模型支出中占 ${formatPercent(share)}`,
        detail:
          share >= 0.45
            ? `如果这不是必须坚持的高质量模型，建议先把草稿、探索性提问或低风险任务转去更便宜的模型，把它留给最终定稿。`
            : `当前支出还没有过度集中，但 ${topSpendRow.label} 已是最主要的成本来源，适合作为下一步优化入口。`,
        chips: [
          `${SCOPE_LABELS[scope]} ${formatUsd(topSpendRow.sum_usd)}`,
          `${formatCount(topSpendRow.count)} 次调用`,
        ],
      },
    ];

    if (topModel) {
      const topScore = modelPriceScore(topModel);
      const cheaperCandidate = models
        .filter((candidate) => {
          if (candidate.id === topModel.id) return false;
          if (!candidate.enabled || candidate.demoted) return false;
          if (candidate.disabled_until && candidate.disabled_until > Date.now()) return false;
          if (candidate.capability !== topModel.capability) return false;
          if (topModel.supports_tools && !candidate.supports_tools) return false;
          if (topModel.supports_vision && !candidate.supports_vision) return false;
          const candidateScore = modelPriceScore(candidate);
          return topScore != null && candidateScore != null && candidateScore < topScore;
        })
        .sort((a, b) => (modelPriceScore(a) ?? Number.POSITIVE_INFINITY) - (modelPriceScore(b) ?? Number.POSITIVE_INFINITY))[0];

      if (cheaperCandidate && topScore != null) {
        const candidateScore = modelPriceScore(cheaperCandidate)!;
        const savingRatio = topScore > 0 ? 1 - candidateScore / topScore : 0;
        insights.push({
          id: 'cheaper-alt',
          tone: 'positive',
          title: '可先试的低成本替代',
          summary: `${cheaperCandidate.display_name} 更适合先出草稿或做第一轮探索`,
          detail: `如果当前任务不依赖 ${topModel.display_name} 的额外质量冗余，可以先切到 ${cheaperCandidate.display_name}，标价约低 ${formatPercent(Math.max(0, savingRatio))}。`,
          chips: [
            modelCapabilityLabel(cheaperCandidate),
            cheaperCandidate.supports_tools ? '支持工具' : '纯文本优先',
          ],
        });
      }

      const health = healthByModelId.get(topModel.id);
      const failureRate = health && health.calls_24h > 0 ? health.failures_24h / health.calls_24h : 0;
      const staleDays =
        topModel.price_synced_at == null
          ? null
          : Math.floor((Date.now() - topModel.price_synced_at) / 86_400_000);

      if (health && health.calls_24h >= 3 && failureRate >= 0.15) {
        insights.push({
          id: 'risk',
          tone: 'caution',
          title: '高花费模型近期不够稳定',
          summary: `${topModel.display_name} 近 24h 失败率约 ${formatPercent(failureRate)}`,
          detail: `如果它仍承担高价值任务，建议先把关键流程切到更稳的候选模型；最近失败主要表现为 ${FAILURE_LABELS[health.last_failure_classification ?? 'unknown'] ?? '未知失败'}。`,
          chips: [
            `24h ${health.failures_24h}/${health.calls_24h}`,
            health.avg_first_token_ms != null ? `首字 ${Math.round(health.avg_first_token_ms)}ms` : '延迟待采样',
          ],
        });
      } else if (staleDays == null || staleDays >= 7) {
        insights.push({
          id: 'pricing-freshness',
          tone: 'neutral',
          title: '价格信息值得复核',
          summary:
            staleDays == null
              ? `${topModel.display_name} 还没有自动价格同步记录`
              : `${topModel.display_name} 的价格已 ${staleDays} 天未同步`,
          detail: '如果你最近切换了国内 provider 或套餐价格有变化，建议到模型中心重新同步，避免成本判断基于旧价目。',
          chips: [
            modelCapabilityLabel(topModel),
            topModel.supports_vision ? '含视觉能力' : '文本优先',
          ],
        });
      }
    }

    return insights.slice(0, 3);
  }, [advisorModelRows, modelHealthRows, models, scope]);

  const budgetAlerts = useMemo(() => {
    const items: BudgetAlertInsight[] = [];
    const pushAlert = (
      id: string,
      periodLabel: string,
      spent: number | null,
      budget: number | null,
      hardLimit: boolean,
    ): void => {
      if (spent == null || budget == null || budget <= 0) return;
      const ratio = spent / budget;
      if (ratio < 0.8) return;
      const tone: BudgetAlertInsight['tone'] = ratio >= 1 ? 'over' : 'watch';
      items.push({
        id,
        tone,
        title: tone === 'over' ? `${periodLabel}预算已超出` : `${periodLabel}预算接近上限`,
        detail:
          tone === 'over'
            ? `${periodLabel}已使用 ${Math.round(ratio * 100)}%。${hardLimit ? '后续高成本调用会被阻断，建议立刻改用更便宜模型或缩短上下文。' : '后续发送会继续要求确认，建议优先采纳上方成本建议中的低成本替代。'}`
            : `${periodLabel}已使用 ${Math.round(ratio * 100)}%。接下来更适合把探索性提问和第一轮草稿转到低成本模型。`,
        chips: [`${formatUsd(spent)} / ${formatUsd(budget)}`, hardLimit ? '硬上限' : '软提醒'],
      });
    };
    pushAlert('day', '今日', todayUsd, dailyBudgetUsd, dailyHardLimit);
    pushAlert('month', '本月', monthUsd, monthlyBudgetUsd, monthlyHardLimit);
    return items;
  }, [dailyBudgetUsd, dailyHardLimit, monthUsd, monthlyBudgetUsd, monthlyHardLimit, todayUsd]);
  const providerSpendInsights = useMemo(() => {
    if (!advisorModelRows || advisorModelRows.length === 0) return [] as ProviderSpendInsight[];
    const modelById = new Map(models.map((model) => [model.id, model]));
    const providerById = new Map(providers.map((provider) => [provider.id, provider]));
    const grouped = new Map<string, ProviderSpendInsight>();
    const total = advisorModelRows.reduce((sum, row) => sum + row.sum_usd, 0);
    for (const row of advisorModelRows) {
      const model = row.model_id ? modelById.get(row.model_id) ?? null : null;
      const provider = model?.provider_id ? providerById.get(model.provider_id) ?? null : null;
      const key = provider?.id ?? `unknown:${row.label}`;
      const current = grouped.get(key) ?? {
        key,
        label: provider?.name ?? '未识别 Provider',
        providerType: provider?.type ?? 'unknown',
        providerTypeLabel: provider ? providerTypeDisplay(provider) : '未知 Provider',
        sumUsd: 0,
        count: 0,
        successCount: 0,
        billedFailureCount: 0,
        modelCount: 0,
        share: 0,
      };
      current.sumUsd += row.sum_usd;
      current.count += row.count;
      current.successCount += row.success_count;
      current.billedFailureCount += row.billed_failure_count;
      if (row.model_id) current.modelCount += 1;
      grouped.set(key, current);
    }
    return Array.from(grouped.values())
      .map((item) => ({
        ...item,
        modelCount: Math.max(1, item.modelCount),
        share: total > 0 ? item.sumUsd / total : 0,
      }))
      .sort((left, right) => right.sumUsd - left.sumUsd)
      .slice(0, 4);
  }, [advisorModelRows, models, providers]);
  const focusedModel = useMemo(
    () => models.find((item) => item.id === focusedModelId) ?? null,
    [focusedModelId, models],
  );
  const focusedModelRow = useMemo(
    () => advisorModelRows?.find((row) => row.model_id === focusedModelId) ?? null,
    [advisorModelRows, focusedModelId],
  );
  const focusedModelProvider = useMemo(
    () => providers.find((item) => item.id === focusedModel?.provider_id) ?? null,
    [focusedModel, providers],
  );
  const focusedModelHealth = useMemo<FocusedModelHealthInsight | null>(() => {
    if (!focusedModel) return null;
    const row = modelHealthRows.find((item) => item.model_id === focusedModel.id) ?? null;
    const cooldown = focusedModel.disabled_until != null && focusedModel.disabled_until > Date.now();
    const calls24h = row?.calls_24h ?? 0;
    const failures24h = row?.failures_24h ?? 0;
    return {
      state: cooldown ? 'cooldown' : focusedModel.demoted ? 'demoted' : 'healthy',
      failureRate: calls24h > 0 ? failures24h / calls24h : null,
      failures24h,
      calls24h,
      avgFirstTokenMs: row?.avg_first_token_ms ?? null,
      lastFailureLabel: row?.last_failure_classification
        ? FAILURE_LABELS[row.last_failure_classification] ?? row.last_failure_classification
        : null,
      disabledUntil: cooldown ? focusedModel.disabled_until ?? null : null,
    };
  }, [focusedModel, modelHealthRows]);
  const focusedProviderInsight = useMemo(
    () => providerSpendInsights.find((item) => item.key === focusedProviderKey) ?? null,
    [focusedProviderKey, providerSpendInsights],
  );
  const focusedProviderModelIds = useMemo(() => {
    if (!focusedProviderKey) return new Set<string>();
    return new Set(
      models
        .filter((model) => model.provider_id === focusedProviderKey)
        .map((model) => model.id),
    );
  }, [focusedProviderKey, models]);
  const providerKeyByModelId = useMemo(
    () => new Map(models.filter((item) => item.provider_id != null).map((item) => [item.id, item.provider_id!])),
    [models],
  );
  const providerKeyByTypeAndName = useMemo(
    () => new Map<string, string>(
      providers.map((item) => [`${item.type}::${item.name.toLocaleLowerCase()}`, item.id]),
    ),
    [providers],
  );
  const visibleRows = useMemo(() => {
    if (groupBy !== 'model') return rows ?? [];
    if (focusedModelId) {
      return (rows ?? []).filter((row) => row.model_id === focusedModelId);
    }
    if (!focusedProviderKey) return rows ?? [];
    return (rows ?? []).filter((row) => row.model_id != null && focusedProviderModelIds.has(row.model_id));
  }, [focusedModelId, focusedProviderKey, focusedProviderModelIds, groupBy, rows]);
  const topVisibleRows = useMemo(() => visibleRows.slice(0, 8), [visibleRows]);
  const resolveCallLogProviderKey = useCallback((row: CallLogRow): string | null => {
    if (row.model_id && providerKeyByModelId.has(row.model_id)) {
      return providerKeyByModelId.get(row.model_id) ?? null;
    }
    if (row.provider_name && row.provider_type) {
      return providerKeyByTypeAndName.get(`${row.provider_type}::${row.provider_name.toLocaleLowerCase()}`) ?? null;
    }
    return null;
  }, [providerKeyByModelId, providerKeyByTypeAndName]);
  const visibleCallLogs = useMemo(() => {
    if (focusedModel) {
      return (callLogs ?? []).filter((row) =>
        row.model_id === focusedModel.id
        || (row.model_id == null && row.model_name_snapshot === (focusedModel.display_name ?? focusedModel.model_name))
      );
    }
    if (!focusedProviderInsight) return callLogs ?? [];
    return (callLogs ?? []).filter((row) =>
      row.provider_name === focusedProviderInsight.label
      && row.provider_type === focusedProviderInsight.providerType
    );
  }, [callLogs, focusedModel, focusedProviderInsight]);
  const total = useMemo(
    () => visibleRows.reduce((sum, row) => sum + row.sum_usd, 0),
    [visibleRows],
  );
  const totalCalls = useMemo(
    () => visibleRows.reduce((sum, row) => sum + row.count, 0),
    [visibleRows],
  );
  useEffect(() => {
    if (!focusedProviderKey || providerSpendInsights.length === 0) return;
    const target = document.querySelector(
      `[data-testid="cost-dashboard-provider-card"][data-provider-key="${focusedProviderKey}"]`,
    );
    target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    if (target) onFocusConsumed?.();
  }, [focusedProviderKey, onFocusConsumed, providerSpendInsights]);
  useEffect(() => {
    if (!focusedModelId || visibleRows.length === 0) return;
    const target = document.querySelector(
      `[data-testid="cost-dashboard-row"][data-model-id="${focusedModelId}"]`,
    );
    target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    if (target) onFocusConsumed?.();
  }, [focusedModelId, onFocusConsumed, visibleRows]);

  const exportBreakdown = useCallback(async (format: 'csv' | 'json'): Promise<void> => {
    setExportingFormat(format);
    setError(null);
    try {
      const { blob, filename } = await api.costsExport(scope, groupBy, format);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setExportingFormat(null);
    }
  }, [groupBy, scope]);

  return (
    <section
      className={`cost-dashboard${embedded ? ' cost-dashboard--embedded' : ''}`}
      data-testid="cost-dashboard-panel"
    >
      <header className="cost-dashboard__header">
        <div>
          <h2>成本看板</h2>
          <p className="hint">
            复盘最近消费结构，回答“钱花在哪了”。
            {lastUpdatedAt ? ` 上次刷新：${new Date(lastUpdatedAt).toLocaleTimeString()}` : ''}
          </p>
        </div>
        <div className="cost-dashboard__header-actions">
          <button
            type="button"
            className="cost-dashboard__header-button"
            data-tone="secondary"
            onClick={() => void exportBreakdown('csv')}
            disabled={exportingFormat !== null}
            data-testid="cost-dashboard-export-csv"
          >
            {exportingFormat === 'csv' ? '导出中…' : '导出 CSV'}
          </button>
          <button
            type="button"
            className="cost-dashboard__header-button"
            data-tone="secondary"
            onClick={() => void exportBreakdown('json')}
            disabled={exportingFormat !== null}
            data-testid="cost-dashboard-export-json"
          >
            {exportingFormat === 'json' ? '导出中…' : '导出 JSON'}
          </button>
          <button
            type="button"
            className="cost-dashboard__header-button"
            data-tone="primary"
            onClick={() => void refresh(false)}
            disabled={refreshing}
            data-testid="cost-dashboard-refresh"
          >
            {refreshing ? '刷新中…' : '刷新'}
          </button>
          {!embedded && (
            <button
              type="button"
              className="settings-close"
              onClick={onClose}
              data-testid="cost-dashboard-close"
              aria-label="关闭成本看板"
            >
              ✕
            </button>
          )}
        </div>
      </header>

      <div className="cost-dashboard__controls">
        <div className="cost-dashboard__tabs" data-testid="cost-dashboard-scope-tabs">
          {([
            ['today', '今日'],
            ['week', '本周'],
            ['month', '本月'],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              data-testid={`cost-dashboard-scope-${value}`}
              data-active={scope === value ? '1' : '0'}
              onClick={() => setScope(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="cost-dashboard__tabs" data-testid="cost-dashboard-group-tabs">
          {(['model', 'conversation', 'feature', 'tag'] as const).map((value) => (
            <button
              key={value}
              type="button"
              data-testid={`cost-dashboard-group-${value}`}
              data-active={groupBy === value ? '1' : '0'}
              onClick={() => {
                setGroupBy(value);
                if (value !== 'model') {
                  setFocusedProviderKey(null);
                  setFocusedModelId(null);
                }
              }}
            >
              {GROUP_LABELS[value]}
            </button>
          ))}
        </div>
      </div>

      <div className="cost-dashboard__summary">
        <article className="cost-dashboard__metric">
          <span>总消费</span>
          <strong data-testid="cost-dashboard-total">{formatUsd(total)}</strong>
        </article>
        <article className="cost-dashboard__metric">
          <span>分组数</span>
          <strong>{visibleRows.length}</strong>
        </article>
        <article className="cost-dashboard__metric">
          <span>{groupBy === 'tag' ? '折算调用数' : '调用数'}</span>
          <strong>{formatCount(totalCalls)}</strong>
        </article>
      </div>

      {groupBy === 'tag' && (
        <div className="cost-dashboard__hint" data-testid="cost-dashboard-tag-hint">
          多标签会话的成本会按标签数均分归因，保证总消费不被重复放大。
        </div>
      )}

      {focusedModel && (
        <section className="cost-dashboard__focus-banner" data-testid="cost-dashboard-model-focus-banner">
          <div className="cost-dashboard__focus-banner-content">
            <strong>当前只看 {focusedModel.display_name ?? focusedModel.model_name}</strong>
            <p>
              已切到按模型视角，并把最近调用收窄到这个模型，方便从预算或健康提醒直接判断它是否值得继续承担当前任务。
            </p>
            <div className="cost-dashboard__focus-banner-chips">
              <span>{modelCapabilityLabel(focusedModel)}</span>
              {focusedModelProvider ? <span>{focusedModelProvider.name}</span> : null}
              {focusedModelRow ? <span>{SCOPE_LABELS[scope]} {formatUsd(focusedModelRow.sum_usd)}</span> : null}
              {focusedModelHealth?.state === 'cooldown'
                ? <span>{focusedModelHealth.disabledUntil ? `冷却至 ${new Date(focusedModelHealth.disabledUntil).toLocaleTimeString()}` : '冷却中'}</span>
                : focusedModelHealth?.state === 'demoted'
                  ? <span>已降级</span>
                  : <span>健康</span>}
              {focusedModelHealth?.failureRate != null
                ? <span>24h 失败 {focusedModelHealth.failures24h}/{focusedModelHealth.calls24h}</span>
                : null}
              {focusedModelHealth?.avgFirstTokenMs != null
                ? <span>首字 {Math.round(focusedModelHealth.avgFirstTokenMs)}ms</span>
                : null}
              {focusedModelHealth?.lastFailureLabel ? <span>最近失败 {focusedModelHealth.lastFailureLabel}</span> : null}
              {focusedModel.supports_tools ? <span>支持工具</span> : <span>纯文本优先</span>}
              <span>{formatCount(visibleCallLogs.length)} 条最近调用</span>
            </div>
          </div>
          <div className="cost-dashboard__focus-banner-actions">
            {focusedModelProvider ? (
              <button
                type="button"
                onClick={() => applyProviderFocus(focusedModelProvider.id, focusedCostRecordId)}
                data-testid="cost-dashboard-model-focus-open-provider"
              >
                看所属 Provider
              </button>
            ) : null}
            {onOpenModels ? (
              <button
                type="button"
                onClick={onOpenModels}
                data-testid="cost-dashboard-model-focus-open-models"
              >
                去模型中心
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => {
                setFocusedModelId(null);
                onFocusConsumed?.();
              }}
              data-testid="cost-dashboard-model-focus-clear"
            >
              清除聚焦
            </button>
          </div>
        </section>
      )}

      {!focusedModel && focusedProviderInsight && (
        <section className="cost-dashboard__focus-banner" data-testid="cost-dashboard-provider-focus-banner">
          <div className="cost-dashboard__focus-banner-content">
            <strong>当前只看 {focusedProviderInsight.label}</strong>
            <p>
              已切到按模型视角，并优先展示这个 Provider 的花费卡与最近调用，方便从出口视角继续排查或优化。
            </p>
            <div className="cost-dashboard__focus-banner-chips">
              <span>{focusedProviderInsight.providerTypeLabel}</span>
              <span>{focusedProviderInsight.modelCount} 个模型</span>
              <span>{formatCount(visibleCallLogs.length)} 条最近调用</span>
            </div>
          </div>
          <div className="cost-dashboard__focus-banner-actions">
            <button
              type="button"
              onClick={() => {
                setFocusedProviderKey(null);
                onFocusConsumed?.();
              }}
              data-testid="cost-dashboard-provider-focus-clear"
            >
              清除聚焦
            </button>
          </div>
        </section>
      )}

      {budgetAlerts.length > 0 && (
        <section className="cost-dashboard__budget-alerts" data-testid="cost-dashboard-budget-alerts">
          {budgetAlerts.map((item) => (
            <article
              key={item.id}
              className={`cost-dashboard__budget-alert is-${item.tone}`}
            >
              <div className="cost-dashboard__budget-alert-head">
                <strong>{item.title}</strong>
              </div>
              <p>{item.detail}</p>
              <div className="cost-dashboard__budget-alert-chips">
                {item.chips.map((chip) => (
                  <span key={chip}>{chip}</span>
                ))}
              </div>
            </article>
          ))}
        </section>
      )}

      {advisorInsights.length > 0 && (
        <section className="cost-dashboard__advisor" data-testid="cost-dashboard-advisor">
          <div className="cost-dashboard__advisor-head">
            <div>
              <h3>成本建议</h3>
              <p className="hint">基于 {SCOPE_LABELS[scope]} 按模型支出、模型价格与 24h 健康自动生成。</p>
            </div>
          </div>
          <div className="cost-dashboard__advisor-grid">
            {advisorInsights.map((item) => (
              <article
                key={item.id}
                className={`cost-dashboard__advisor-card is-${item.tone}`}
                data-testid="cost-dashboard-advisor-card"
              >
                <div className="cost-dashboard__advisor-card-head">
                  <span>{item.title}</span>
                  <strong>{item.summary}</strong>
                </div>
                <p>{item.detail}</p>
                <div className="cost-dashboard__advisor-chips">
                  {item.chips.map((chip) => (
                    <span key={chip}>{chip}</span>
                  ))}
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      {providerSpendInsights.length > 0 && (
        <section className="cost-dashboard__provider-breakdown" data-testid="cost-dashboard-provider-breakdown">
          <div className="cost-dashboard__advisor-head">
            <div>
              <h3>Provider 花费分布</h3>
              <p className="hint">基于 {SCOPE_LABELS[scope]} 按模型支出前端聚合，帮助先判断“钱主要流向了哪个出口”。</p>
            </div>
          </div>
          <div className="cost-dashboard__provider-grid">
            {providerSpendInsights.map((item) => (
              <article
                key={item.key}
                className="cost-dashboard__provider-card"
                data-testid="cost-dashboard-provider-card"
                data-provider-key={item.key}
                data-focused={focusedProviderKey === item.key ? '1' : '0'}
              >
                <div className="cost-dashboard__provider-card-head">
                  <span>{item.label}</span>
                  <strong>{formatUsd(item.sumUsd)}</strong>
                </div>
                <p>{item.providerTypeLabel} · 占 {formatPercent(item.share)} · {item.modelCount} 个模型</p>
                <div className="cost-dashboard__provider-chips">
                  <span>{formatCount(item.count)} 次调用</span>
                  <span>{formatCount(item.successCount)} 成功</span>
                  {item.billedFailureCount > 0 ? <span>计费失败 {formatCount(item.billedFailureCount)}</span> : null}
                </div>
                {onOpenModels && item.key !== 'unknown' ? (
                  <div className="cost-dashboard__provider-actions">
                    <button
                      type="button"
                      onClick={() => {
                        setGroupBy('model');
                        setFocusedProviderKey(item.key);
                        setFocusedModelId(null);
                        setFocusedCostRecordId(null);
                      }}
                      data-testid={`cost-dashboard-provider-drilldown-${item.key}`}
                    >
                      {focusedProviderKey === item.key ? '当前聚焦中' : '只看这个 Provider'}
                    </button>
                    <button
                      type="button"
                      onClick={onOpenModels}
                      data-testid={`cost-dashboard-provider-open-models-${item.key}`}
                    >
                      去模型中心
                    </button>
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        </section>
      )}

      <div className="cost-dashboard__body">
        {error && <div className="error">加载失败：{error}</div>}
        {!error && rows == null && <div className="hint">加载中…</div>}
        {!error && rows != null && visibleRows.length === 0 && (
          <div className="hint" data-testid="cost-dashboard-empty">当前时间窗口还没有成本记录。</div>
        )}
        {!error && rows != null && visibleRows.length > 0 && (
          <ol className="cost-dashboard__list">
            {topVisibleRows.map((row, index) => (
              <li
                key={`${row.key}-${index}`}
                className="cost-dashboard__row"
                data-testid="cost-dashboard-row"
                data-model-id={row.model_id ?? ''}
                data-focused={focusedModelId != null && row.model_id === focusedModelId ? '1' : '0'}
              >
                <div className="cost-dashboard__row-rank">{index + 1}</div>
                <div className="cost-dashboard__row-main">
                  <div className="cost-dashboard__row-head">
                    <strong>{row.label}</strong>
                    <div className="cost-dashboard__row-head-side">
                      <span className="cost-dashboard__row-amount">{formatUsd(row.sum_usd)}</span>
                      {groupBy === 'model' && row.model_id ? (
                        <button
                          type="button"
                          className="cost-dashboard__row-action"
                          data-testid="cost-dashboard-row-drilldown"
                          onClick={() => applyModelFocus(row.model_id!)}
                        >
                          {focusedModelId === row.model_id ? '当前聚焦中' : '只看该模型'}
                        </button>
                      ) : null}
                    </div>
                  </div>
                  <div className="cost-dashboard__row-meta">
                    <span>{countLabel(groupBy, row.count, 'count')}</span>
                    <span>{countLabel(groupBy, row.success_count, 'success')}</span>
                    {row.billed_failure_count > 0 && (
                      <span>{countLabel(groupBy, row.billed_failure_count, 'billed_failure')}</span>
                    )}
                    {row.trend.length > 0 && (
                      <span>{row.trend[0]!.label} → {row.trend[row.trend.length - 1]!.label}</span>
                    )}
                  </div>
                </div>
                <Sparkline trend={row.trend} />
              </li>
            ))}
          </ol>
        )}
      </div>

      <div className="cost-dashboard__calls" data-testid="cost-call-log">
        <div className="cost-dashboard__calls-head">
          <h3>最近模型 / 工具调用</h3>
          <span>按实际 Sidecar 出口记录，便于核对外部消费。</span>
        </div>
        {callLogs == null && <div className="hint">调用日志加载中…</div>}
        {callLogs != null && visibleCallLogs.length === 0 && (
          <div className="hint" data-testid="cost-call-log-empty">暂无调用日志。</div>
        )}
        {callLogs != null && visibleCallLogs.length > 0 && (
          <div className="cost-call-log-list">
            {visibleCallLogs.slice(0, 12).map((row) => (
              <article
                key={row.id}
                className="cost-call-log-row"
                data-testid="cost-call-log-row"
                data-cost-record-id={row.id}
                data-conversation-id={row.conversation_id ?? ''}
                data-source-id={row.source_id ?? ''}
                data-run-id={row.run_id ?? ''}
                data-run-event-id={row.run_event_id ?? ''}
                data-focused={focusedCostRecordId === row.id ? '1' : '0'}
              >
                <div className="cost-call-log-main">
                  <strong>
                    {row.model_name_snapshot || row.model_id || '未知模型 / 工具'}
                    {row.provider_name ? ` · ${row.provider_name}` : ''}
                  </strong>
                  <span>
                    {SOURCE_LABELS[row.source_type] ?? row.source_type} · {row.feature}
                    {row.conversation_title ? ` · ${row.conversation_title}` : ''}
                    {row.source_id ? ` · 来源 ${row.source_id.slice(0, 10)}` : ''}
                  </span>
                  <div className="cost-call-log-links">
                    <span data-testid="cost-call-source-id">Cost {row.id.slice(0, 10)}</span>
                    {row.run_id ? (
                      <span data-testid="cost-call-run-link">Run {row.run_id.slice(0, 10)}</span>
                    ) : null}
                    {row.run_event_id ? (
                      <span data-testid="cost-call-event-link">
                        {row.run_event_label ?? row.run_event_kind ?? '运行事件'} {row.run_event_id.slice(0, 10)}
                      </span>
                    ) : null}
                  </div>
                </div>
                <div className="cost-call-log-meta">
                  <span className={row.success ? 'ok' : 'fail'}>
                    {row.success ? '成功' : `失败${row.classification ? `:${row.classification}` : ''}`}
                  </span>
                  <span>{row.actual_cost_usd == null ? '费用未知' : formatUsd(row.actual_cost_usd)}</span>
                  <span>{new Date(row.created_at).toLocaleTimeString()}</span>
                  {row.model_id ? (
                        <button
                          type="button"
                          className="cost-call-log-focus"
                          data-testid="cost-call-focus-model"
                          onClick={() => applyModelFocus(row.model_id!, row.id)}
                    >
                      看同模型
                    </button>
                  ) : null}
                  {resolveCallLogProviderKey(row) ? (
                    <button
                      type="button"
                      className="cost-call-log-focus"
                      data-testid="cost-call-focus-provider"
                      onClick={() => applyProviderFocus(resolveCallLogProviderKey(row)!, row.id)}
                    >
                      看同 Provider
                    </button>
                  ) : null}
                  {row.conversation_id && row.run_id ? (
                    <button
                      type="button"
                      className="cost-call-log-focus"
                      data-testid="cost-call-focus-run"
                      onClick={() =>
                        dispatchCostRunFocus({
                          conversationId: row.conversation_id!,
                          runId: row.run_id!,
                          runEventId: row.run_event_id,
                          costRecordId: row.id,
                        })
                      }
                    >
                      查看运行
                    </button>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
