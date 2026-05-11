/**
 * Model Center — M2.5 §F-MC.
 *
 * Top-level page for managing the entire model fleet:
 *   • Provider section (add / delete provider — Volcengine Ark, OpenRouter, …)
 *   • Capability tabs (chat / multimodal / image / video / asr / tts / embedding)
 *   • Per-tab matrix: alias × provider × price × default × enabled
 *   • Sync prices button (diff toast) — calls /v1/catalog/sync
 *   • "+ 导入模型" per tab — runs Provider.discover → user picks → createModel
 *
 * Replaces the old crude "Settings → Models" list. Settings now only carries
 * Auto-fallback, Provider deletion, and the Danger Zone.
 */

import { Fragment, useEffect, useMemo, useState } from 'react';
import type { FormEvent, JSX } from 'react';
import { api } from './api.js';
import {
  formatUsd,
  isChatCapable,
  type Model,
  type ModelHealthRow,
  type ModelCapability,
  type DiscoveredModel,
  type Provider,
  type ProviderUpdate,
} from '@taori/shared';
import { providerTypeDisplay } from './providerLabels.js';

const CAPABILITY_TABS: { id: ModelCapability; label: string; hint: string }[] = [
  { id: 'chat', label: '💬 文本对话', hint: '纯文本聊天 / 长文本' },
  { id: 'multimodal', label: '🖼️ 多模态', hint: '可读图，亦可对话' },
  { id: 'image', label: '🎨 图像生成', hint: '文生图 / 图生图' },
  { id: 'video', label: '🎬 视频生成', hint: '文生视频 / 图生视频' },
  { id: 'asr', label: '🎙️ 语音识别', hint: 'Whisper / 实时转写' },
  { id: 'tts', label: '🔊 语音合成', hint: '文本转语音' },
  { id: 'embedding', label: '🧬 向量嵌入', hint: '检索 / 语义索引' },
];

type ImportCapabilityFilter = ModelCapability | 'all';

interface SyncSummary {
  synced_at: number;
  total_providers: number;
  total_models: number;
  changed: number;
  newCount: number;
  errors: { provider_id: string; message: string }[];
  diffs: {
    provider_id: string;
    model_name: string;
    display_name?: string | null;
    change: 'new' | 'price_changed' | 'unchanged' | 'removed';
  }[];
}

type ModelFeatureFilter = 'all' | 'tools' | 'vision' | 'default' | 'unknown_price';
type ModelSortKey = 'priority' | 'name' | 'price_low' | 'price_high' | 'context_desc';

interface ManagedModelDiff {
  model: Model;
  discovered: DiscoveredModel;
  changes: string[];
}

interface ProviderProfile {
  category: string;
  focus: string;
  pricingHint: string;
  errorHint: string;
  fallbackHint: string;
  preferredFallbackTypes: Array<Provider['type']>;
  rank: number;
}

interface ProviderInsight {
  provider: Provider;
  profile: ProviderProfile;
  managedCount: number;
  enabledCount: number;
  healthCalls24h: number;
  failures24h: number;
  modelsWithFailures: number;
  avgFirstTokenMs: number | null;
  latestFailureLabel: string;
  capabilityLabels: string[];
  keyStateLabel: string;
  statusLabel: string;
  keyState: 'not_required' | 'missing' | 'verified' | 'unchecked';
  isReady: boolean;
  isOperational: boolean;
  monthlyCostUsd: number;
  syncedCount: number;
  freshSyncedCount: number;
  lastSyncedAt: number | null;
  fallbackLabel: string;
}

const FAILURE_LABELS: Record<string, string> = {
  rate_limit: '限流',
  quota: '额度耗尽',
  network: '网络失败',
  auth: '鉴权失败',
  content_filter: '内容拦截',
  unknown: '未知失败',
  key_missing: 'Key 缺失',
};

const CAPABILITY_LABELS: Record<ModelCapability, string> = {
  chat: '对话',
  multimodal: '视觉',
  image: '生图',
  video: '视频',
  asr: '识别',
  tts: '语音',
  embedding: '嵌入',
};

const PROVIDER_PROFILES: Record<Provider['type'], ProviderProfile> = {
  deepseek: {
    category: '国内直连',
    focus: 'DeepSeek 官方直连，适合作为主力中文推理 / 编码入口。',
    pricingHint: '官方价格语义最直接，适合做成本基线。',
    errorHint: '重点关注 auth / quota / rate_limit，通常最能反映官方额度与权限状态。',
    fallbackHint: '官方不稳时优先切到硅基流动或 OpenRouter，保证同类 chat 模型继续工作。',
    preferredFallbackTypes: ['siliconflow', 'openrouter', 'ollama'],
    rank: 10,
  },
  siliconflow: {
    category: '国内聚合',
    focus: '硅基流动适合作为国内多模型聚合层，承担国产模型 fallback。',
    pricingHint: '适合统一比较多家模型价格，但价格同步后要关注具体模型族差异。',
    errorHint: '出现 config_error 时通常优先检查模型名、能力匹配和是否误开 tools/vision。',
    fallbackHint: '高频任务可把官方直连放前、硅基放后，既保稳定也保扩展面。',
    preferredFallbackTypes: ['deepseek', 'volcengine_ark', 'openrouter', 'ollama'],
    rank: 20,
  },
  volcengine_ark: {
    category: '国内直连',
    focus: '火山方舟覆盖 Doubao / Seedream / 视频模型，适合中文多模态主力。',
    pricingHint: '图像 / 视频模型价格形态差异大，建议结合价格同步时间一起看。',
    errorHint: '重点关注 rate_limit / config_error，尤其是模型能力和请求参数是否匹配。',
    fallbackHint: '图像或视觉链路异常时，可准备 SiliconFlow / OpenRouter 作为备用出口。',
    preferredFallbackTypes: ['siliconflow', 'openrouter', 'ollama'],
    rank: 15,
  },
  huawei_maas: {
    category: '国内直连',
    focus: '华为云 MaaS 更像企业接入面，适合作为兼容 OpenAI 的稳态出口。',
    pricingHint: '适合补强企业云场景，但价格与能力矩阵要和主力模型分开看。',
    errorHint: '出现 auth / network 时优先排查企业网络、区域和接入域名。',
    fallbackHint: '企业链路不稳时，优先保留一个公网聚合出口做兜底。',
    preferredFallbackTypes: ['openrouter', 'siliconflow', 'ollama'],
    rank: 25,
  },
  packyapi: {
    category: '专用图像',
    focus: 'PackyAPI 更适合承担固定图像生成出口。',
    pricingHint: '单次/单图价格更关键，适合和火山图像模型并排比较。',
    errorHint: '图像失败优先看 quota / config_error，通常和模型或套餐约束相关。',
    fallbackHint: '图像任务建议至少保留一个火山或 SiliconFlow 备用模型。',
    preferredFallbackTypes: ['volcengine_ark', 'siliconflow', 'openrouter'],
    rank: 50,
  },
  openrouter: {
    category: '海外聚合',
    focus: 'OpenRouter 适合作为广覆盖兜底层，用来接住多家海外模型。',
    pricingHint: '价格同步面最广，适合做跨 provider 决策与对照。',
    errorHint: 'rate_limit / quota 之外，也要关注上游模型不支持 tools 的语义。',
    fallbackHint: '当国内直连异常时，可临时切到 OpenRouter 保证任务不中断。',
    preferredFallbackTypes: ['deepseek', 'siliconflow', 'ollama'],
    rank: 40,
  },
  ollama: {
    category: '本地',
    focus: 'Ollama 适合作为离线 / 内网 fallback，稳定但能力与速度取决于本机。',
    pricingHint: '本地成本看不到外部账单，但要结合机器资源和首 token 延迟判断。',
    errorHint: '失败通常更偏本地进程 / 模型未拉取 / 端口不可达。',
    fallbackHint: '本地模型适合做最后一道兜底，不建议一开始就承担高价值主任务。',
    preferredFallbackTypes: ['deepseek', 'siliconflow', 'openrouter'],
    rank: 60,
  },
  custom: {
    category: '兼容接入',
    focus: 'OpenAI 兼容入口，可用于通义 / Kimi / 智谱等尚未做预设的端点。',
    pricingHint: '接第三方兼容端点时，建议手动补齐价格信息，否则很难做成本判断。',
    errorHint: 'config_error 最值得关注，通常说明能力声明和真实上游不一致。',
    fallbackHint: '把兼容端点放在明确主力 provider 后面，用作定向补位更稳妥。',
    preferredFallbackTypes: ['siliconflow', 'openrouter', 'ollama'],
    rank: 30,
  },
  openai: {
    category: '官方',
    focus: 'OpenAI 适合承担国际通用基线，对比意义大于本地化优势。',
    pricingHint: '更适合作为对照成本基线，而不是中文 BYOK 用户的唯一主力。',
    errorHint: '重点关注 quota / rate_limit / model mismatch。',
    fallbackHint: '需要中文本地化体验时，优先准备国内直连或本地模型作为后备。',
    preferredFallbackTypes: ['deepseek', 'siliconflow', 'openrouter'],
    rank: 70,
  },
  anthropic: {
    category: '官方',
    focus: 'Anthropic 更适合高质量长文本与审阅任务。',
    pricingHint: '适合作为质量标杆，不一定适合高频低成本入口。',
    errorHint: '出现 content_filter 时要和普通 auth / quota 错误分开看。',
    fallbackHint: '高质量列可保留 Anthropic，执行层建议另备国产或聚合模型。',
    preferredFallbackTypes: ['openrouter', 'deepseek', 'ollama'],
    rank: 80,
  },
  replicate: {
    category: '专用图像',
    focus: 'Replicate 适合接特定图像 / 多模态模型。',
    pricingHint: '价格形态因模型差异很大，最好作为专用通道使用。',
    errorHint: '网络与配置错误要优先排查模型 ID 和运行参数。',
    fallbackHint: '不要单点依赖，最好配一个火山或 Packy 图像出口。',
    preferredFallbackTypes: ['packyapi', 'volcengine_ark', 'openrouter'],
    rank: 90,
  },
  sd_webui: {
    category: '本地',
    focus: 'Stable Diffusion WebUI 适合本地图像实验。',
    pricingHint: '没有外部账单，但会消耗本地 GPU/CPU 资源。',
    errorHint: '重点看本地服务可用性与模型权重是否准备完整。',
    fallbackHint: '本地生图失败时，要准备一个云端图像 provider 兜底。',
    preferredFallbackTypes: ['packyapi', 'volcengine_ark', 'openrouter'],
    rank: 95,
  },
};

function priceChanged(a: number | null | undefined, b: number | null | undefined): boolean {
  if (a == null && b == null) return false;
  if (a == null || b == null) return true;
  return Math.abs(a - b) > 0.0000001;
}

function primaryPrice(model: Pick<Model, 'price_input_per_1m' | 'price_output_per_1m' | 'price_per_image' | 'price_per_video_second' | 'price_per_call'>): number | null {
  const values = [
    model.price_input_per_1m,
    model.price_output_per_1m,
    model.price_per_image,
    model.price_per_video_second,
    model.price_per_call,
  ].filter((v): v is number => v != null && Number.isFinite(v));
  if (values.length === 0) return null;
  return Math.min(...values);
}

function discoveredPrice(discovered: DiscoveredModel): number | null {
  const values = [
    discovered.price_input_per_1m,
    discovered.price_output_per_1m,
    discovered.price_per_image ?? null,
    discovered.price_per_video_second ?? null,
  ].filter((v): v is number => v != null && Number.isFinite(v));
  if (values.length === 0) return null;
  return Math.min(...values);
}

function pricePairLabel(before: number | null | undefined, after: number | null | undefined): string {
  return `${formatUsd(before ?? null)} -> ${formatUsd(after ?? null)}`;
}

function managedDiff(existing: Model | undefined, discovered: DiscoveredModel): ManagedModelDiff | null {
  if (!existing) return null;
  const changes: string[] = [];
  if (priceChanged(existing.price_input_per_1m, discovered.price_input_per_1m)) {
    changes.push(`输入价 ${pricePairLabel(existing.price_input_per_1m, discovered.price_input_per_1m)}`);
  }
  if (priceChanged(existing.price_output_per_1m, discovered.price_output_per_1m)) {
    changes.push(`输出价 ${pricePairLabel(existing.price_output_per_1m, discovered.price_output_per_1m)}`);
  }
  if (priceChanged(existing.price_per_image, discovered.price_per_image)) {
    changes.push(`图片价 ${pricePairLabel(existing.price_per_image, discovered.price_per_image)}`);
  }
  if (priceChanged(existing.price_per_video_second, discovered.price_per_video_second)) {
    changes.push(`视频价 ${pricePairLabel(existing.price_per_video_second, discovered.price_per_video_second)}`);
  }
  if (existing.capability !== discovered.capability) {
    changes.push(`能力 ${existing.capability} -> ${discovered.capability}`);
  }
  if (existing.context_length !== discovered.context_length) {
    changes.push(`上下文 ${existing.context_length ?? '未知'} -> ${discovered.context_length ?? '未知'}`);
  }
  if (existing.supports_vision !== discovered.supports_vision) {
    changes.push(`视觉 ${existing.supports_vision ? '支持' : '不支持'} -> ${discovered.supports_vision ? '支持' : '不支持'}`);
  }
  if (discovered.supports_tools !== undefined && existing.supports_tools !== discovered.supports_tools) {
    changes.push(`工具 ${existing.supports_tools ? '支持' : '不支持'} -> ${discovered.supports_tools ? '支持' : '不支持'}`);
  }
  return changes.length > 0 ? { model: existing, discovered, changes } : null;
}

function formatMetricMs(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${Math.round(value)}ms`;
}

function formatAgo(ts: number | null): string {
  if (ts == null) return '—';
  const diff = Math.max(0, Date.now() - ts);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  return `${Math.floor(diff / hour)} 小时前`;
}

function providerNeedsApiKey(provider: Provider): boolean {
  return provider.type !== 'ollama' && provider.type !== 'sd_webui';
}

function sparklinePath(points: number[], width: number, height: number): string {
  if (points.length === 0) return '';
  const max = Math.max(...points, 1);
  const stepX = points.length <= 1 ? width : width / (points.length - 1);
  return points
    .map((value, index) => {
      const x = Number((index * stepX).toFixed(2));
      const y = Number((height - (value / max) * (height - 4) - 2).toFixed(2));
      return `${index === 0 ? 'M' : 'L'}${x},${y}`;
    })
    .join(' ');
}

function FailureTrendSparkline({
  trend,
}: {
  trend: ModelHealthRow['failure_trend_24h'];
}): JSX.Element {
  const values = trend.map((item) => item.failures);
  const path = sparklinePath(values, 180, 44);
  const hasValue = values.some((value) => value > 0);
  return (
    <svg
      className="model-health-trend__sparkline"
      viewBox="0 0 180 44"
      aria-hidden="true"
    >
      <path d="M0 42.5H180" stroke="currentColor" strokeOpacity="0.08" />
      {hasValue ? (
        <path
          d={path}
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      ) : (
        <path
          d="M0 24 L180 24"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeOpacity="0.35"
          fill="none"
        />
      )}
    </svg>
  );
}

export function ModelCenter({
  onClose,
  onChanged,
  onReopenOnboarding,
  embedded = false,
}: {
  onClose: () => void;
  onChanged?: () => void;
  onReopenOnboarding: () => void;
  embedded?: boolean;
}): JSX.Element {
  const [activeTab, setActiveTab] = useState<ModelCapability>('chat');
  const [models, setModels] = useState<Model[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncingTarget, setSyncingTarget] = useState<string | 'all' | null>(null);
  const [syncSummary, setSyncSummary] = useState<SyncSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [healthRows, setHealthRows] = useState<Map<string, ModelHealthRow>>(new Map());
  const [expandedModelId, setExpandedModelId] = useState<string | null>(null);
  const [importDrawer, setImportDrawer] = useState<{
    capability: ImportCapabilityFilter;
    providerId: string | null;
  } | null>(null);
  const [modelQuery, setModelQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'enabled' | 'disabled'>('all');
  const [featureFilter, setFeatureFilter] = useState<ModelFeatureFilter>('all');
  const [sortKey, setSortKey] = useState<ModelSortKey>('priority');
  const [selectedModelIds, setSelectedModelIds] = useState<Set<string>>(new Set());
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  const [providerKeyStatus, setProviderKeyStatus] = useState<Map<string, boolean> | null>(null);
  const [providerKeyChecking, setProviderKeyChecking] = useState(false);
  const [providerKeyCheckedAt, setProviderKeyCheckedAt] = useState<number | null>(null);
  const [providerKeyError, setProviderKeyError] = useState<string | null>(null);
  const [monthlyModelCosts, setMonthlyModelCosts] = useState<Map<string, number>>(new Map());
  const syncing = syncingTarget !== null;

  const refresh = async (): Promise<void> => {
    setLoading(true);
    try {
      const [{ providers: ps }, { models: ms }, healthRes, costRes] = await Promise.all([
        api.listProviders(),
        api.listModels(),
        api.modelsHealth().catch(() => ({ rows: [] })),
        api.costsDashboardBreakdown('month', 'model').catch(() => ({ data: { rows: [] } })),
      ]);
      setProviders(ps);
      setModels(ms);
      setHealthRows(new Map(healthRes.rows.map((row) => [row.model_id, row])));
      setMonthlyModelCosts(new Map(
        (costRes.data.rows ?? [])
          .filter((row) => row.model_id)
          .map((row) => [row.model_id as string, row.sum_usd ?? 0]),
      ));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    setSelectedProviderId((current) => {
      if (providers.length === 0) return null;
      if (current && providers.some((provider) => provider.id === current)) return current;
      return providers[0]?.id ?? null;
    });
  }, [providers]);

  // Esc closes the page (a11y + matches Settings).
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (!embedded && e.key === 'Escape' && !importDrawer) onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, importDrawer, embedded]);

  const providerById = useMemo(
    () => new Map(providers.map((p) => [p.id, p])),
    [providers],
  );

  const providerStats = useMemo(() => {
    const stats = new Map<string, { total: number; enabled: number; disabled: number }>();
    for (const provider of providers) {
      stats.set(provider.id, { total: 0, enabled: 0, disabled: 0 });
    }
    for (const model of models) {
      if (!model.provider_id) continue;
      const row = stats.get(model.provider_id) ?? { total: 0, enabled: 0, disabled: 0 };
      row.total += 1;
      if (model.enabled) row.enabled += 1;
      else row.disabled += 1;
      stats.set(model.provider_id, row);
    }
    return stats;
  }, [models, providers]);

  const selectedProvider = useMemo(
    () => providers.find((provider) => provider.id === selectedProviderId) ?? null,
    [providers, selectedProviderId],
  );

  const providerInsights = useMemo<ProviderInsight[]>(() => {
    const enabledChatProviders = providers.filter((provider) =>
      provider.enabled && models.some((model) =>
        model.provider_id === provider.id && model.enabled && isChatCapable(model.capability),
      ),
    );
    return providers.map((provider) => {
      const profile = PROVIDER_PROFILES[provider.type];
      const providerModels = models.filter((model) => model.provider_id === provider.id);
      const providerHealthRows = providerModels
        .map((model) => healthRows.get(model.id))
        .filter((row): row is ModelHealthRow => Boolean(row));
      const failureCounts = new Map<string, number>();
      let healthCalls24h = 0;
      let failures24h = 0;
      let weightedFirstTokenSum = 0;
      let weightedFirstTokenCalls = 0;
      for (const row of providerHealthRows) {
        healthCalls24h += row.calls_24h;
        failures24h += row.failures_24h;
        if (row.avg_first_token_ms != null && row.calls_24h > 0) {
          weightedFirstTokenSum += row.avg_first_token_ms * row.calls_24h;
          weightedFirstTokenCalls += row.calls_24h;
        }
        for (const item of row.failure_distribution_24h) {
          failureCounts.set(
            item.classification,
            (failureCounts.get(item.classification) ?? 0) + item.failures,
          );
        }
      }
      const topFailure = Array.from(failureCounts.entries()).sort((a, b) => b[1] - a[1])[0] ?? null;
      const monthlyCostUsd = providerModels.reduce(
        (sum, model) => sum + (monthlyModelCosts.get(model.id) ?? 0),
        0,
      );
      const syncedModels = providerModels.filter((model) => model.price_synced_at != null);
      const freshSyncedCount = syncedModels.filter((model) =>
        (model.price_synced_at ?? 0) >= Date.now() - 3 * 24 * 60 * 60 * 1000,
      ).length;
      const lastSyncedAt = syncedModels.reduce<number | null>(
        (latest, model) => Math.max(latest ?? 0, model.price_synced_at ?? 0) || latest,
        null,
      );
      const keyKnown = providerKeyStatus?.get(provider.id);
      const requiresApiKey = providerNeedsApiKey(provider);
      const keyState: ProviderInsight['keyState'] = !requiresApiKey
        ? 'not_required'
        : !provider.api_key_ref
          ? 'missing'
          : keyKnown === true
            ? 'verified'
            : keyKnown === false
              ? 'missing'
              : 'unchecked';
      const keyStateLabel = keyState === 'not_required'
        ? '无需云端 Key'
        : keyState === 'verified'
          ? 'Key 已确认'
          : keyState === 'unchecked'
            ? 'Key 未复核'
            : provider.api_key_ref
              ? 'Key 缺失'
              : '未配置 Key';
      const isReady = keyState === 'not_required' || keyState === 'verified' || keyState === 'unchecked';
      const isOperational = provider.enabled && isReady;
      const statusLabel = !provider.enabled
        ? '未启用'
        : isOperational
          ? '已启用'
          : '未启用（待补 Key）';
      const capabilities = Array.from(
        new Set(
          providerModels
            .map((model) => CAPABILITY_LABELS[model.capability])
            .filter(Boolean),
        ),
      ).slice(0, 5);
      const fallbackCandidate = profile.preferredFallbackTypes
        .map((type) =>
          enabledChatProviders.find((candidate) =>
            candidate.id !== provider.id && candidate.type === type,
          ) ?? null)
        .find((candidate): candidate is Provider => Boolean(candidate));
      return {
        provider,
        profile,
        managedCount: providerModels.length,
        enabledCount: providerModels.filter((model) => model.enabled).length,
        healthCalls24h,
        failures24h,
        modelsWithFailures: providerHealthRows.filter((row) => row.failures_24h > 0).length,
        avgFirstTokenMs: weightedFirstTokenCalls > 0 ? weightedFirstTokenSum / weightedFirstTokenCalls : null,
        latestFailureLabel: topFailure
          ? `${FAILURE_LABELS[topFailure[0]] ?? topFailure[0]} × ${topFailure[1]}`
          : '近 24h 无明显失败',
        capabilityLabels: capabilities,
        keyStateLabel,
        statusLabel,
        keyState,
        isReady,
        isOperational,
        monthlyCostUsd,
        syncedCount: syncedModels.length,
        freshSyncedCount,
        lastSyncedAt,
        fallbackLabel: fallbackCandidate
          ? `建议 fallback 到 ${fallbackCandidate.name}`
          : profile.fallbackHint,
      };
    }).sort((a, b) => a.profile.rank - b.profile.rank || b.monthlyCostUsd - a.monthlyCostUsd);
  }, [healthRows, models, monthlyModelCosts, providerKeyStatus, providers]);

  const selectedInsight = useMemo(
    () => providerInsights.find((insight) => insight.provider.id === selectedProviderId) ?? null,
    [providerInsights, selectedProviderId],
  );

  const modelsByCap = useMemo(() => {
    const out = new Map<ModelCapability, Model[]>();
    for (const tab of CAPABILITY_TABS) out.set(tab.id, []);
    for (const m of models) {
      const arr = out.get(m.capability as ModelCapability);
      if (arr) arr.push(m);
    }
    // Multimodal models also serve text chat; show them under both tabs so a
    // single vision-capable import gives a usable chat default by itself.
    const mm = out.get('multimodal') ?? [];
    const chat = out.get('chat') ?? [];
    out.set('chat', [
      ...chat,
      ...mm.filter((m) => !chat.some((x) => x.id === m.id)),
    ]);
    return out;
  }, [models]);

  const onSync = async (providerId?: string): Promise<void> => {
    setSyncingTarget(providerId ?? 'all');
    setError(null);
    try {
      const res = await api.catalogSync(providerId);
      const changed = res.diffs.filter((d) => d.change === 'price_changed').length;
      const newCount = res.diffs.filter((d) => d.change === 'new').length;
      setSyncSummary({
        synced_at: res.synced_at,
        total_providers: res.total_providers,
        total_models: res.total_models,
        changed,
        newCount,
        errors: res.errors,
        diffs: res.diffs.filter((d) => d.change !== 'unchanged').slice(0, 50),
      });
      await refresh();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncingTarget(null);
    }
  };

  const onToggleEnabled = async (m: Model): Promise<void> => {
    const nextEnabled = !m.enabled;
    const previousModels = models;
    setModels((current) =>
      current.map((item) => (item.id === m.id ? { ...item, enabled: nextEnabled } : item)),
    );
    try {
      await api.updateModel(m.id, { enabled: nextEnabled });
      onChanged?.();
    } catch (e) {
      setModels(previousModels);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onSetDefault = async (m: Model): Promise<void> => {
    try {
      await api.setDefaultModel(m.id, m.capability as ModelCapability);
      await refresh();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onDelete = async (m: Model): Promise<void> => {
    if (!window.confirm(`删除模型 “${m.display_name}”？`)) return;
    try {
      await api.deleteModel(m.id);
      await refresh();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onDeleteProvider = async (p: Provider): Promise<void> => {
    if (!window.confirm(`删除 Provider “${p.name}”？该 Provider 下的全部模型将一并删除。`)) return;
    try {
      await api.deleteProvider(p.id);
      await refresh();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onMove = async (m: Model, dir: -1 | 1): Promise<void> => {
    const sameCap = (modelsByCap.get(m.capability as ModelCapability) ?? [])
      .filter((x) => x.capability === m.capability)
      .slice()
      .sort((a, b) => a.fallback_order - b.fallback_order);
    const idx = sameCap.findIndex((x) => x.id === m.id);
    if (idx < 0) return;
    const target = idx + dir;
    if (target < 0 || target >= sameCap.length) return;
    const next = sameCap.slice();
    [next[idx], next[target]] = [next[target], next[idx]];
    try {
      await api.reorderModels(m.capability as ModelCapability, next.map((x) => x.id));
      await refresh();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const [editing, setEditing] = useState<Model | null>(null);
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null);

  const onSaveEdit = async (patch: import('@taori/shared').ModelUpdate): Promise<void> => {
    if (!editing) return;
    try {
      await api.updateModel(editing.id, patch);
      setEditing(null);
      await refresh();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onSaveProviderEdit = async (patch: ProviderUpdate): Promise<void> => {
    if (!editingProvider) return;
    try {
      await api.updateProvider(editingProvider.id, patch);
      setEditingProvider(null);
      setProviderKeyStatus(null);
      setProviderKeyCheckedAt(null);
      setProviderKeyError(null);
      await refresh();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onCheckProviderKeys = async (): Promise<void> => {
    setProviderKeyChecking(true);
    setProviderKeyError(null);
    try {
      const res = await api.providerKeyStatus({ confirmKeychain: true });
      setProviderKeyStatus(new Map(res.statuses.map((s) => [s.provider_id, s.key_available])));
      setProviderKeyCheckedAt(Date.now());
    } catch (e) {
      setProviderKeyError(e instanceof Error ? e.message : String(e));
    } finally {
      setProviderKeyChecking(false);
    }
  };

  const [testResult, setTestResult] = useState<{
    providerId: string;
    ok: boolean;
    note?: string | null;
    classification?: string | null;
  } | null>(null);
  const [modelProbe, setModelProbe] = useState<{
    modelId: string;
    status: 'running' | 'done';
    ok?: boolean;
    note?: string;
  } | null>(null);

  const onTestProvider = async (p: Provider): Promise<void> => {
    setTestResult(null);
    const firstModel = models.find((m) => m.provider_id === p.id);
    if (!firstModel) {
      setTestResult({
        providerId: p.id,
        ok: false,
        note: '请先为该 Provider 导入至少一个模型再测试',
      });
      return;
    }
    try {
      const res = await api.testModel(firstModel.id);
      setTestResult({
        providerId: p.id,
        ok: res.ok,
        note: res.note ?? null,
        classification: res.error?.classification ?? null,
      });
    } catch (e) {
      setTestResult({
        providerId: p.id,
        ok: false,
        note: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const onProbeModel = async (m: Model): Promise<void> => {
    setModelProbe({ modelId: m.id, status: 'running' });
    try {
      const res = await api.testModel(m.id);
      const probe = res.tools_probe;
      const note = probe
        ? probe.supported === true
          ? `Tools 支持已确认${probe.updated ? '，已自动开启' : ''}`
          : probe.supported === false
            ? `Tools 不支持已确认${probe.updated ? '，已自动关闭' : ''}`
            : `连通正常，但 Tools 探测不确定：${probe.message ?? probe.classification ?? '未知'}`
        : res.ok
          ? `连通正常：${res.latency_ms ?? 0}ms`
          : res.error?.message ?? res.note ?? '探测失败';
      setModelProbe({
        modelId: m.id,
        status: 'done',
        ok: res.ok && (probe?.supported !== false),
        note,
      });
      await refresh();
      onChanged?.();
    } catch (e) {
      setModelProbe({
        modelId: m.id,
        status: 'done',
        ok: false,
        note: e instanceof Error ? e.message : String(e),
      });
    }
  };

  useEffect(() => {
    setSelectedModelIds(new Set());
  }, [activeTab, modelQuery, selectedProviderId, statusFilter, featureFilter, sortKey]);

  const activeTabModels = (modelsByCap.get(activeTab) ?? [])
    .slice()
    .sort((a, b) => a.fallback_order - b.fallback_order);
  const scopedTabModels = selectedProviderId
    ? activeTabModels.filter((model) => model.provider_id === selectedProviderId)
    : activeTabModels;
  const query = modelQuery.trim().toLowerCase();
  const visibleModels = scopedTabModels.filter((m) => {
    if (statusFilter === 'enabled' && !m.enabled) return false;
    if (statusFilter === 'disabled' && m.enabled) return false;
    if (featureFilter === 'tools' && !m.supports_tools) return false;
    if (featureFilter === 'vision' && !m.supports_vision) return false;
    if (featureFilter === 'default' && m.is_default_for !== activeTab) return false;
    if (featureFilter === 'unknown_price' && primaryPrice(m) !== null) return false;
    if (!query) return true;
    const provider = m.provider_id ? providerById.get(m.provider_id) : null;
    const text = [
      m.alias,
      m.display_name,
      m.model_name,
      provider?.name,
      provider?.type,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return text.includes(query);
  }).slice().sort((a, b) => {
    if (sortKey === 'name') {
      return (a.alias ?? a.display_name ?? a.model_name).localeCompare(b.alias ?? b.display_name ?? b.model_name);
    }
    if (sortKey === 'price_low' || sortKey === 'price_high') {
      const ap = primaryPrice(a);
      const bp = primaryPrice(b);
      const an = ap == null ? Number.POSITIVE_INFINITY : ap;
      const bn = bp == null ? Number.POSITIVE_INFINITY : bp;
      return sortKey === 'price_low' ? an - bn : bn - an;
    }
    if (sortKey === 'context_desc') {
      return (b.context_length ?? -1) - (a.context_length ?? -1);
    }
    return a.fallback_order - b.fallback_order;
  });
  const tab = CAPABILITY_TABS.find((t) => t.id === activeTab)!;
  const activeEnabledCount = scopedTabModels.filter((m) => m.enabled).length;
  const activeDisabledCount = scopedTabModels.length - activeEnabledCount;
  const selectedVisibleIds = visibleModels
    .map((m) => m.id)
    .filter((id) => selectedModelIds.has(id));
  const selectedProviderModels = selectedProviderId
    ? models.filter((model) => model.provider_id === selectedProviderId)
    : [];
  const selectedProviderModelGroups = CAPABILITY_TABS.map((tab) => {
    const scopedModels = selectedProviderModels.filter((model) => model.capability === tab.id);
    return {
      id: tab.id,
      label: CAPABILITY_LABELS[tab.id],
      total: scopedModels.length,
      enabled: scopedModels.filter((model) => model.enabled).length,
    };
  }).filter((item) => item.total > 0);
  const selectedProviderNeedsKey = selectedProvider ? providerNeedsApiKey(selectedProvider) : false;
  const selectedProviderKeyMissing = selectedProvider
    ? selectedProviderNeedsKey &&
      (!selectedProvider.api_key_ref || providerKeyStatus?.get(selectedProvider.id) === false)
    : false;
  const selectedProviderReady = selectedProvider ? !selectedProviderKeyMissing : false;

  const toggleSelectModel = (id: string): void => {
    setSelectedModelIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAllVisible = (): void => {
    setSelectedModelIds((current) => {
      const next = new Set(current);
      const allSelected = visibleModels.length > 0 && visibleModels.every((m) => next.has(m.id));
      for (const model of visibleModels) {
        if (allSelected) next.delete(model.id);
        else next.add(model.id);
      }
      return next;
    });
  };

  const onBulkEnabled = async (enabled: boolean): Promise<void> => {
    const ids = selectedVisibleIds;
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    const previousModels = models;
    setModels((current) =>
      current.map((item) => (idSet.has(item.id) ? { ...item, enabled } : item)),
    );
    setSelectedModelIds(new Set());
    try {
      await Promise.all(ids.map((id) => api.updateModel(id, { enabled })));
      onChanged?.();
    } catch (e) {
      setModels(previousModels);
      setSelectedModelIds(new Set(ids));
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div
      className={`model-center${editing ? ' is-editing' : ''}${embedded ? ' model-center--embedded' : ''}`}
      data-testid="model-center"
    >
      <header className="model-center__header">
        <div>
          <h2>模型中心</h2>
          <p className="hint">按 Provider 与能力管理模型库；先刷新供应商清单，再把常用模型导入并按需启停。</p>
        </div>
        <div className="model-center__header-actions">
          <button
            type="button"
            className="btn-primary"
            onClick={() => void onSync()}
            disabled={syncing}
            data-testid="model-center-sync"
          >
            {syncingTarget === 'all' ? '同步中…' : '🔄 同步价格'}
          </button>
          {!embedded && (
            <button
              type="button"
              className="model-center-action-btn model-center-action-btn--secondary"
              onClick={onClose}
              data-testid="model-center-close"
            >
              关闭
            </button>
          )}
        </div>
      </header>

      {error && <div className="model-center__error">{error}</div>}
      {syncSummary && (
        <SyncResult summary={syncSummary} providerById={providerById} />
      )}

      {/* Provider section — surfaces all configured providers and gives an
          "+ 添加 Provider" entry point that re-runs Onboarding (which has
          presets for OpenRouter, Volcengine Ark, OpenAI, Ollama, etc.). */}
      <section className="model-center__providers" data-testid="model-center-providers">
        <div className="model-center__providers-head">
          <div>
            <h3>Providers</h3>
            <p className="hint">左侧选 Provider，右侧只看当前 Provider 的配置、连接和模型清单。</p>
          </div>
          <div className="model-center__providers-actions">
            <button
              type="button"
              className="model-center-action-btn model-center-action-btn--secondary"
              onClick={() => void onCheckProviderKeys()}
              disabled={providerKeyChecking || providers.length === 0}
              data-testid="provider-key-status-check"
              title="主动读取系统钥匙串，确认 Provider Key 是否仍可用"
            >
              {providerKeyChecking ? '检查中…' : '检查钥匙串状态'}
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={onReopenOnboarding}
              data-testid="model-center-add-provider"
            >
              + 添加 Provider
            </button>
          </div>
        </div>
        {providerKeyCheckedAt && (
          <p className="provider-key-status-summary" data-testid="provider-key-status-summary">
            已检查 {new Date(providerKeyCheckedAt).toLocaleTimeString()} · 缺失{' '}
            {providers.filter((p) => p.api_key_ref && providerKeyStatus?.get(p.id) === false).length} 项
          </p>
        )}
        {providerKeyError && (
          <p className="provider-key-status-summary is-error" data-testid="provider-key-status-error">
            钥匙串检查失败：{providerKeyError}
          </p>
        )}
        {providers.length === 0 ? (
          <p className="hint">尚未配置 Provider，点击上方“+ 添加 Provider”导入。</p>
        ) : (
          <div className="provider-workspace" data-testid="provider-workspace">
            <aside className="provider-nav" aria-label="Provider 列表">
              <ul className="provider-nav__list">
                {providerInsights.map((insight) => {
                  const keyMissing = insight.keyState === 'missing';
                  const keyAvailable = insight.keyState === 'verified';
                  const stats = providerStats.get(insight.provider.id);
                  const dotState = !insight.provider.enabled
                    ? 'off'
                    : !insight.isOperational
                      ? 'bad'
                      : insight.keyState === 'unchecked'
                        ? 'warn'
                        : 'ok';
                  const dotTitle = !insight.provider.enabled
                    ? '未启用'
                    : !insight.isOperational
                      ? insight.statusLabel
                      : insight.keyState === 'unchecked'
                        ? '待校验 Key'
                        : '正常';
                  return (
                    <li key={insight.provider.id}>
                      <button
                        type="button"
                        className={`provider-nav__item ${selectedProviderId === insight.provider.id ? 'is-active' : ''} ${insight.provider.enabled ? '' : 'is-off'} ${!insight.isOperational && insight.provider.enabled ? 'is-unready' : ''} ${keyMissing ? 'has-key-missing' : ''}`}
                        data-testid={`provider-nav-item-${insight.provider.id}`}
                        onClick={() => {
                          setSelectedProviderId(insight.provider.id);
                        }}
                      >
                        <span className="provider-nav__item-row provider-nav__item-row--primary">
                          <span
                            className={`provider-nav__dot is-${dotState}`}
                            aria-hidden="true"
                            title={dotTitle}
                          />
                          <span className="provider-nav__item-name">{insight.provider.name}</span>
                          <span className="provider-nav__item-type">{providerTypeDisplay(insight.provider)}</span>
                        </span>
                        <span className="provider-nav__item-row provider-nav__item-row--meta">
                          <span
                            className="provider-nav__item-count"
                            data-testid={`provider-chip-count-${insight.provider.id}`}
                          >
                            {stats?.total ?? 0} 个 · 启用 {stats?.enabled ?? 0}
                          </span>
                          <span className="provider-nav__sep" aria-hidden="true">·</span>
                          <span className="provider-nav__item-state">{insight.statusLabel}</span>
                        </span>
                        {/* keep legacy hooks for tests but visually hide except when key missing */}
                        <span className="provider-nav__item-badges" hidden>
                          <span className="provider-nav__badge">{insight.profile.category}</span>
                          <span className="provider-nav__badge">
                            {insight.statusLabel}
                          </span>
                          <span className="provider-nav__badge">{insight.keyStateLabel}</span>
                        </span>
                        {keyMissing ? (
                          <span
                            role="button"
                            tabIndex={0}
                            className="provider-nav__key-missing"
                            data-testid={`provider-chip-key-missing-${insight.provider.id}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              setEditingProvider(insight.provider);
                            }}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault();
                                event.stopPropagation();
                                setEditingProvider(insight.provider);
                              }
                            }}
                          >
                            Key 缺失
                          </span>
                        ) : insight.provider.api_key_ref ? (
                          <span
                            className={`provider-chip__key-warn ${keyAvailable ? 'is-ok' : ''}`}
                            data-testid={`provider-chip-key-warn-${insight.provider.id}`}
                          >
                            🔑
                          </span>
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </aside>

            {selectedInsight && selectedProvider && (
              <section className="provider-detail" data-testid={`provider-detail-${selectedProvider.id}`}>
                <header className="provider-detail__head">
                  <div className="provider-detail__summary">
                    <div className="provider-detail__title">
                      <strong>{selectedProvider.name}</strong>
                      <span className="provider-detail__badge">{selectedInsight.profile.category}</span>
                      <span className={`provider-detail__badge ${selectedInsight.isOperational ? 'is-ok' : 'is-warning'}`}>
                        {selectedInsight.statusLabel}
                      </span>
                      <span className={`provider-detail__badge ${selectedInsight.keyState === 'verified' || selectedInsight.keyState === 'not_required' ? 'is-ok' : 'is-warning'}`}>
                        {selectedInsight.keyStateLabel}
                      </span>
                    </div>
                    <p className="provider-detail__focus">{selectedInsight.profile.focus}</p>
                  </div>
                  <div className="provider-detail__actions">
                    <button
                      type="button"
                      className="btn-primary"
                      onClick={() => {
                        if (!selectedProviderReady) {
                          setEditingProvider(selectedProvider);
                          return;
                        }
                        setImportDrawer({
                          capability: 'all',
                          providerId: selectedProvider.id,
                        });
                      }}
                      data-testid={`provider-detail-library-${selectedProvider.id}`}
                      title={selectedProviderReady ? '查询并管理该 Provider 的模型清单' : '请先补齐并确认 API Key'}
                    >
                      {selectedProviderReady ? '查询模型清单' : '先补 API Key'}
                    </button>
                    <button
                      type="button"
                      className="model-center-action-btn model-center-action-btn--secondary"
                      onClick={() => void onSync(selectedProvider.id)}
                      disabled={syncing || !selectedProviderReady}
                      data-testid={`provider-detail-sync-${selectedProvider.id}`}
                    >
                      {syncingTarget === selectedProvider.id ? '同步中…' : '同步价格'}
                    </button>
                    <button
                      type="button"
                      className="model-center-action-btn model-center-action-btn--secondary"
                      onClick={() => void onTestProvider(selectedProvider)}
                      data-testid={`provider-detail-test-${selectedProvider.id}`}
                      title={selectedProviderReady ? '测试与该 Provider 的连接' : '测试当前配置 (会返回 key_missing)'}
                    >
                      测试连接
                    </button>
                    <button
                      type="button"
                      className="model-center-action-btn model-center-action-btn--secondary"
                      onClick={() => {
                        setEditingProvider(selectedProvider);
                      }}
                      data-testid={`provider-menu-edit-${selectedProvider.id}`}
                    >
                      {selectedProviderKeyMissing ? '补 API Key' : '编辑 Provider'}
                    </button>
                    <button
                      type="button"
                      className="model-center-action-btn model-center-action-btn--danger"
                      onClick={() => void onDeleteProvider(selectedProvider)}
                      data-testid={`provider-detail-delete-${selectedProvider.id}`}
                      title="删除该 Provider 及其所有已管理模型，操作不可恢复"
                    >
                      删除
                    </button>
                  </div>
                </header>

                <div className="provider-detail__metrics">
                  <div className="provider-detail__metric">
                    <small>已管理</small>
                    <strong>{selectedInsight.managedCount}</strong>
                    <em>启用 {selectedInsight.enabledCount}</em>
                  </div>
                  <div className="provider-detail__metric">
                    <small>24h 健康</small>
                    <strong>{selectedInsight.failures24h}/{selectedInsight.healthCalls24h || 0}</strong>
                    <em>{selectedInsight.healthCalls24h > 0 ? '失败/调用' : '暂无流量'}</em>
                  </div>
                  <div className="provider-detail__metric">
                    <small>月度花费</small>
                    <strong>{formatUsd(selectedInsight.monthlyCostUsd)}</strong>
                    <em>{formatMetricMs(selectedInsight.avgFirstTokenMs)} 首字</em>
                  </div>
                  <div className="provider-detail__metric">
                    <small>价格同步</small>
                    <strong>{selectedInsight.freshSyncedCount}/{selectedInsight.syncedCount}</strong>
                    <em>
                      {selectedInsight.lastSyncedAt
                        ? `${formatAgo(selectedInsight.lastSyncedAt)} 更新`
                        : '未同步'}
                    </em>
                  </div>
                </div>

                {selectedProviderKeyMissing ? (
                  <div className="provider-detail__callout is-warning" data-testid="provider-detail-key-callout">
                    <strong>先补 API Key，再查询模型清单。</strong>
                    <p>
                      这个 Provider 当前{selectedInsight.keyStateLabel}。补齐 Key 后即可测试连接、刷新模型库，并选择要启用的模型。
                    </p>
                  </div>
                ) : selectedInsight.managedCount === 0 ? (
                  <div className="provider-detail__callout" data-testid="provider-detail-empty-callout">
                    <strong>这个 Provider 还没有已管理模型。</strong>
                    <p>先点击“查询模型清单”，再从候选模型里选择需要启用的模型即可。</p>
                  </div>
                ) : null}

                <div className="provider-detail__capabilities" data-testid="provider-detail-capabilities">
                  {selectedProviderModelGroups.length > 0 ? selectedProviderModelGroups.map((group) => (
                    <span key={group.id}>
                      {group.label} {group.enabled}/{group.total}
                    </span>
                  )) : <span>尚未导入模型</span>}
                </div>

                <details
                  className="provider-detail__fold"
                  data-testid={`provider-detail-insights-${selectedProvider.id}`}
                >
                  <summary>展开运营洞察</summary>
                  <dl className="provider-detail__fold-grid">
                    <div>
                      <dt>错误语义</dt>
                      <dd>{selectedInsight.latestFailureLabel}；{selectedInsight.profile.errorHint}</dd>
                    </div>
                    <div>
                      <dt>价格提示</dt>
                      <dd>{selectedInsight.profile.pricingHint}</dd>
                    </div>
                    <div className="provider-detail__fold-span">
                      <dt>默认 fallback</dt>
                      <dd>{selectedInsight.fallbackLabel}</dd>
                    </div>
                  </dl>
                </details>

                {testResult && testResult.providerId === selectedProvider.id && (
                  <p
                    className={`provider-detail__test-result ${testResult.ok ? 'ok' : 'err'}`}
                    data-testid={`provider-detail-test-result-${selectedProvider.id}`}
                  >
                    {testResult.ok ? '✓' : '✗'}
                    {testResult.note ? ` ${testResult.note}` : ''}
                    {testResult.classification ? ` (${testResult.classification})` : ''}
                  </p>
                )}
              </section>
            )}
          </div>
        )}
      </section>

      <nav className="model-center__tabs" role="tablist">
        {CAPABILITY_TABS.map((t) => {
          const count = (modelsByCap.get(t.id) ?? []).filter((model) =>
            !selectedProviderId || model.provider_id === selectedProviderId,
          ).length;
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={activeTab === t.id}
              className={activeTab === t.id ? 'tab tab--active' : 'tab'}
              onClick={() => setActiveTab(t.id)}
              data-testid={`model-center-tab-${t.id}`}
            >
              <span className="tab__label">{t.label}</span>
              <span className="tab__count">{count}</span>
            </button>
          );
        })}
      </nav>

      <section className="model-center__matrix">
        <div className="model-center__matrix-head">
          <div>
            <h3>{tab.label}</h3>
            <p className="hint">
              {selectedProvider
                ? `${selectedProvider.name} · ${tab.hint} · 已管理 ${scopedTabModels.length} 个，启用 ${activeEnabledCount} 个，停用 ${activeDisabledCount} 个`
                : `${tab.hint} · 已管理 ${scopedTabModels.length} 个，启用 ${activeEnabledCount} 个，停用 ${activeDisabledCount} 个`}
            </p>
          </div>
          <button
            type="button"
            className="model-center-action-btn model-center-action-btn--secondary"
            onClick={() =>
              setImportDrawer({
                capability: activeTab,
                providerId: selectedProviderId ?? providers[0]?.id ?? null,
              })
            }
            disabled={providers.length === 0 || !selectedProviderReady}
            data-testid="model-center-import"
            title={
              providers.length === 0
                ? '请先添加 Provider'
                : !selectedProviderReady
                  ? '请先补齐并确认当前 Provider 的 API Key'
                  : '从当前 Provider 导入模型'
            }
          >
            + 导入模型
          </button>
        </div>
        <div className="model-center__filters" data-testid="model-center-filters">
          <label>
            搜索
            <input
              type="search"
              value={modelQuery}
              onChange={(e) => setModelQuery(e.target.value)}
              placeholder="模型名、别名…"
              data-testid="model-center-search"
            />
          </label>
          <label>
            状态
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as 'all' | 'enabled' | 'disabled')}
              data-testid="model-center-status-filter"
            >
              <option value="all">全部状态</option>
              <option value="enabled">只看启用</option>
              <option value="disabled">只看停用</option>
            </select>
          </label>
          <label>
            特性
            <select
              value={featureFilter}
              onChange={(e) => setFeatureFilter(e.target.value as ModelFeatureFilter)}
              data-testid="model-center-feature-filter"
            >
              <option value="all">全部特性</option>
              <option value="tools">支持工具调用</option>
              <option value="vision">支持视觉输入</option>
              <option value="default">当前默认模型</option>
              <option value="unknown_price">价格未知</option>
            </select>
          </label>
          <label>
            排序
            <select
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as ModelSortKey)}
              data-testid="model-center-sort"
            >
              <option value="priority">兜底优先级</option>
              <option value="name">模型名称</option>
              <option value="price_low">价格从低到高</option>
              <option value="price_high">价格从高到低</option>
              <option value="context_desc">上下文从大到小</option>
            </select>
          </label>
          <div className="model-center__bulk" data-testid="model-center-bulk-actions">
            <span>已选 {selectedVisibleIds.length} 个</span>
            <button
              type="button"
              disabled={selectedVisibleIds.length === 0}
              onClick={() => void onBulkEnabled(true)}
              data-testid="model-center-bulk-enable"
            >
              批量启用
            </button>
            <button
              type="button"
              disabled={selectedVisibleIds.length === 0}
              onClick={() => void onBulkEnabled(false)}
              data-testid="model-center-bulk-disable"
            >
              批量停用
            </button>
          </div>
        </div>
        {loading ? (
          <p className="hint">加载中…</p>
        ) : scopedTabModels.length === 0 ? (
          <p className="hint">
            当前 Provider 下还没有 <strong>{tab.label}</strong> 模型。可以点击右上“+ 导入模型”刷新该 Provider 的模型库。
          </p>
        ) : visibleModels.length === 0 ? (
          <p className="hint">
            当前筛选下没有 <strong>{tab.label}</strong> 模型。请调整搜索或状态筛选。
          </p>
        ) : (
          <div className="model-matrix-scroll">
            <table className="model-matrix" data-testid="model-matrix">
              <thead>
                <tr>
                  <th className="model-matrix__select">
                    <input
                      type="checkbox"
                      checked={visibleModels.length > 0 && visibleModels.every((m) => selectedModelIds.has(m.id))}
                      onChange={toggleSelectAllVisible}
                      aria-label="选择当前筛选下全部模型"
                      data-testid="model-center-select-all"
                    />
                  </th>
                  <th>模型</th>
                  <th>Provider</th>
                  <th>价格（USD/1M tok 或单次）</th>
                  <th>复杂价格</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {visibleModels.map((m) => {
                const prov = m.provider_id ? providerById.get(m.provider_id) : undefined;
                const isDefault = m.is_default_for === activeTab;
                const priceCell =
                  activeTab === 'image'
                    ? `每张 ${formatUsd(m.price_per_image)}`
                    : activeTab === 'video'
                      ? `每秒 ${formatUsd(m.price_per_video_second)}`
                      : `输入 ${formatUsd(m.price_input_per_1m)} · 输出 ${formatUsd(m.price_output_per_1m)}`;
                const sameCapList = visibleModels.filter(
                  (x) => x.capability === m.capability,
                );
                const idxInCap = sameCapList.findIndex((x) => x.id === m.id);
                const isFirstInCap = idxInCap === 0;
                const isLastInCap = idxInCap === sameCapList.length - 1;
                return (
                  <Fragment key={m.id}>
                    <tr data-testid={`model-row-${m.id}`}>
                      <td className="model-matrix__select">
                        <input
                          type="checkbox"
                          checked={selectedModelIds.has(m.id)}
                          onChange={() => toggleSelectModel(m.id)}
                          aria-label={`选择 ${m.display_name}`}
                          data-testid={`model-select-${m.id}`}
                        />
                      </td>
                      <td>
                        <div className="model-cell-name">
                          <strong>{m.alias ?? m.display_name ?? m.model_name}</strong>
                          {isDefault && <span className="badge badge--default">默认</span>}
                          {m.demoted && (
                            <span
                              className="badge badge--demoted"
                              title="该模型被自动降级（连续失败）"
                              data-testid={`model-demoted-${m.id}`}
                            >
                              <span className="badge__icon" aria-hidden="true">⚠</span>
                              <span>降级</span>
                            </span>
                          )}
                        </div>
                        <div className="model-cell-id">{m.model_name}</div>
                      </td>
                      <td>
                        {prov ? (
                          <span className="model-cell-provider">
                            {prov.name} · <em>{providerTypeDisplay(prov)}</em>
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>{priceCell}</td>
                      <td>
                        {m.pricing_meta ? (
                          <span className="badge badge--price_changed" title={m.pricing_meta.notes ?? '已配置复杂价格规则'}>
                            pricing_meta
                          </span>
                        ) : null}
                      </td>
                      <td>
                        <label
                          className={`switch switch-modern ${m.enabled ? 'switch-modern--on' : 'switch-modern--off'}`}
                          title={m.enabled ? '点击停用该模型' : '点击启用该模型'}
                        >
                          <input
                            type="checkbox"
                            checked={m.enabled}
                            onChange={() => void onToggleEnabled(m)}
                            data-testid={`model-row-enabled-${m.id}`}
                          />
                          <span className="switch-modern__track" aria-hidden="true">
                            <span className="switch-modern__thumb" />
                          </span>
                          <span className="switch-modern__label">{m.enabled ? '启用' : '禁用'}</span>
                        </label>
                      </td>
                      <td>
                        <div className="model-cell-actions">
                          <button
                            type="button"
                            className="model-cell-actions__icon-btn"
                            onClick={() => void onMove(m, -1)}
                            disabled={isFirstInCap}
                            data-testid={`model-row-up-${m.id}`}
                            title="上移（兜底优先级 +1）"
                            aria-label="上移"
                          >
                            ▲
                          </button>
                          <button
                            type="button"
                            className="model-cell-actions__icon-btn"
                            onClick={() => void onMove(m, 1)}
                            disabled={isLastInCap}
                            data-testid={`model-row-down-${m.id}`}
                            title="下移（兜底优先级 -1）"
                            aria-label="下移"
                          >
                            ▼
                          </button>
                          <button
                            type="button"
                            className="model-cell-actions__primary"
                            onClick={() => void onSetDefault(m)}
                            disabled={isDefault || !m.enabled}
                            data-testid={`model-row-default-${m.id}`}
                            title={!m.enabled ? '停用模型不能设为默认' : undefined}
                          >
                            {isDefault ? '默认中' : m.enabled ? '默认' : '停用中'}
                          </button>
                          <button
                            type="button"
                            className="model-cell-actions__ghost"
                            onClick={() =>
                              setExpandedModelId((current) => (current === m.id ? null : m.id))
                            }
                            data-testid={`model-health-toggle-${m.id}`}
                          >
                            {expandedModelId === m.id ? '收起' : '健康'}
                          </button>
                          {(m.capability === 'chat' || m.capability === 'multimodal') && (
                            <button
                              type="button"
                              className="model-cell-actions__ghost"
                              onClick={() => void onProbeModel(m)}
                              disabled={modelProbe?.modelId === m.id && modelProbe.status === 'running'}
                              data-testid={`model-tools-probe-${m.id}`}
                              title="真实请求探测该模型是否接受 OpenAI tools 参数"
                            >
                              {modelProbe?.modelId === m.id && modelProbe.status === 'running'
                                ? '探测中'
                                : 'Tools'}
                            </button>
                          )}
                          <button
                            type="button"
                            className="model-cell-actions__icon-btn"
                            onClick={() => setEditing(m)}
                            data-testid={`model-edit-${m.id}`}
                            aria-label="编辑模型"
                            title="编辑模型（重命名 / 改价格 / 改能力）"
                          >
                            ✎
                          </button>
                          <button
                            type="button"
                            className="model-cell-actions__icon-btn model-cell-actions__danger"
                            onClick={() => void onDelete(m)}
                            data-testid={`model-row-delete-${m.id}`}
                            aria-label="删除模型"
                            title="删除模型"
                          >
                            🗑
                          </button>
                        </div>
                      </td>
                    </tr>
                    {modelProbe?.modelId === m.id && modelProbe.status === 'done' && (
                      <tr className="model-health-row" data-testid={`model-tools-probe-result-${m.id}`}>
                        <td colSpan={7}>
                          <div className={`model-probe-result ${modelProbe.ok ? 'ok' : 'bad'}`}>
                            {modelProbe.note}
                          </div>
                        </td>
                      </tr>
                    )}
                    {expandedModelId === m.id && (
                      <tr className="model-health-row" data-testid={`model-health-panel-${m.id}`}>
                        <td colSpan={7}>
                          <ModelHealthPanel health={healthRows.get(m.id) ?? null} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {importDrawer && (
        <ImportDrawer
          providers={providers}
          existingModels={models}
          initialCapability={importDrawer.capability}
          initialProviderId={importDrawer.providerId}
          onClose={() => setImportDrawer(null)}
          onImported={async () => {
            setImportDrawer(null);
            await refresh();
            onChanged?.();
          }}
          onModelsChanged={async () => {
            await refresh();
            onChanged?.();
          }}
          onProviderSynced={async (providerId) => {
            await onSync(providerId);
          }}
        />
      )}
      {editingProvider && (
        <EditProviderDialog
          provider={editingProvider}
          onCancel={() => setEditingProvider(null)}
          onSave={(patch) => void onSaveProviderEdit(patch)}
          keyMissing={providerKeyStatus?.get(editingProvider.id) === false}
        />
      )}
      {editing && (
        <EditModelDialog
          model={editing}
          onCancel={() => setEditing(null)}
          onSave={(patch) => void onSaveEdit(patch)}
        />
      )}
    </div>
  );
}

function ModelHealthPanel({
  health,
}: {
  health: ModelHealthRow | null;
}): JSX.Element {
  const row = health ?? {
    model_id: '',
    calls_24h: 0,
    failures_24h: 0,
    avg_first_token_ms: null,
    avg_duration_ms: null,
    last_failure_at: null,
    last_failure_classification: null,
    failure_distribution_24h: [],
    failure_trend_24h: [],
  };

  const lastFailureText = row.last_failure_classification
    ? `${FAILURE_LABELS[row.last_failure_classification] ?? row.last_failure_classification} · ${formatAgo(row.last_failure_at)}`
    : '—';
  const topDistribution = row.failure_distribution_24h.slice(0, 4);

  return (
    <div className="model-health-panel">
      <div className="model-health-panel__cards">
        <article className="model-health-card">
          <span className="model-health-card__label">最近 24h 调用</span>
          <strong data-testid="model-health-calls">{row.calls_24h}</strong>
        </article>
        <article className="model-health-card">
          <span className="model-health-card__label">最近 24h 失败</span>
          <strong data-testid="model-health-failures">{row.failures_24h}</strong>
        </article>
        <article className="model-health-card">
          <span className="model-health-card__label">平均首字延迟</span>
          <strong data-testid="model-health-ttfb">{formatMetricMs(row.avg_first_token_ms)}</strong>
        </article>
        <article className="model-health-card">
          <span className="model-health-card__label">平均总耗时</span>
          <strong>{formatMetricMs(row.avg_duration_ms)}</strong>
        </article>
      </div>
      <div className="model-health-trend" data-testid="model-health-trend">
        <div className="model-health-trend__head">
          <span className="model-health-panel__footer-label">最近 24h 失败趋势</span>
          <strong>{row.failures_24h > 0 ? `${row.failures_24h} 次失败` : '暂无失败'}</strong>
        </div>
        <FailureTrendSparkline trend={row.failure_trend_24h} />
        <div className="model-health-trend__labels">
          <span>{row.failure_trend_24h[0]?.label ?? '—'}</span>
          <span>{row.failure_trend_24h.at(-1)?.label ?? '现在'}</span>
        </div>
      </div>
      <div className="model-health-distribution" data-testid="model-health-distribution">
        <span className="model-health-panel__footer-label">失败分类分布</span>
        <div className="model-health-distribution__chips">
          {topDistribution.length > 0 ? topDistribution.map((item) => (
            <span
              key={item.classification}
              className="model-health-distribution__chip"
            >
              {FAILURE_LABELS[item.classification] ?? item.classification} {item.failures}
            </span>
          )) : (
            <span className="model-health-distribution__empty">最近 24h 没有失败记录</span>
          )}
        </div>
      </div>
      <div className="model-health-panel__footer">
        <span className="model-health-panel__footer-label">最近失败分类</span>
        <strong data-testid="model-health-last-failure">{lastFailureText}</strong>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Sync result panel — explicit feedback so users see "what changed"
// ----------------------------------------------------------------------------
function SyncResult({
  summary,
  providerById,
}: {
  summary: SyncSummary;
  providerById: Map<string, Provider>;
}): JSX.Element {
  return (
    <div className="model-center__sync-summary" data-testid="model-center-sync-summary">
      <div className="sync-summary__head">
        ✓ 已同步 {summary.total_providers} 个 Provider · 上游共 {summary.total_models} 个模型
        {summary.changed > 0 && <strong> · {summary.changed} 个价格更新</strong>}
        {summary.newCount > 0 && <strong> · {summary.newCount} 个新模型</strong>}
        {summary.errors.length > 0 && (
          <span className="model-center__sync-errors">
            {' '}· {summary.errors.length} 个 Provider 同步失败
          </span>
        )}
      </div>
      {summary.diffs.length > 0 && (
        <details className="sync-summary__diffs">
          <summary>查看变化（{summary.diffs.length}）</summary>
          <ul>
            {summary.diffs.map((d, i) => {
              const prov = providerById.get(d.provider_id);
              return (
                <li key={`${d.provider_id}-${d.model_name}-${i}`}>
                  <span className={`badge badge--${d.change}`}>
                    {d.change === 'new' ? '新' : '价'}
                  </span>{' '}
                  {prov?.name ?? d.provider_id} · {d.display_name ?? d.model_name}
                  <span className="hint"> ({d.model_name})</span>
                </li>
              );
            })}
          </ul>
        </details>
      )}
      {summary.errors.length > 0 && (
        <details className="sync-summary__errors">
          <summary>查看失败原因（{summary.errors.length}）</summary>
          <ul>
            {summary.errors.map((e, i) => {
              const prov = providerById.get(e.provider_id);
              return (
                <li key={`${e.provider_id}-${i}`}>
                  <strong>{prov?.name ?? e.provider_id}</strong>: {e.message}
                </li>
              );
            })}
          </ul>
        </details>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Import drawer — discover models from a Provider and import the picked ones.
// ----------------------------------------------------------------------------
function ImportDrawer({
  providers,
  existingModels,
  initialCapability,
  initialProviderId,
  onClose,
  onImported,
  onModelsChanged,
  onProviderSynced,
}: {
  providers: Provider[];
  existingModels: Model[];
  initialCapability: ImportCapabilityFilter;
  initialProviderId: string | null;
  onClose: () => void;
  onImported: () => Promise<void>;
  onModelsChanged: () => Promise<void>;
  onProviderSynced: (providerId: string) => Promise<void>;
}): JSX.Element {
  const [providerId, setProviderId] = useState<string | null>(initialProviderId);
  const [capability, setCapability] = useState<ImportCapabilityFilter>(initialCapability);
  const [discovered, setDiscovered] = useState<DiscoveredModel[]>([]);
  const [filter, setFilter] = useState('');
  const [libraryStatus, setLibraryStatus] = useState<'all' | 'unmanaged' | 'enabled' | 'disabled'>('all');
  const [discovering, setDiscovering] = useState(false);
  const [importing, setImporting] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [err, setErr] = useState<string | null>(null);
  const [importEnabled, setImportEnabled] = useState(true);
  const [syncingManaged, setSyncingManaged] = useState(false);

  const discover = async (): Promise<void> => {
    if (!providerId) return;
    setDiscovering(true);
    setErr(null);
    setPicked(new Set());
    setDiscovered([]);
    try {
      const res = await api.discoverModels(providerId);
      setDiscovered(res.models);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setDiscovering(false);
    }
  };

  // Auto-discover when provider changes.
  useEffect(() => {
    if (!providerId) return;
    let cancelled = false;
    setDiscovering(true);
    setErr(null);
    setPicked(new Set());
    setDiscovered([]);
    api
      .discoverModels(providerId)
      .then((r) => {
        if (cancelled) return;
        setDiscovered(r.models);
      })
      .catch((e) => {
        if (cancelled) return;
        setErr(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setDiscovering(false);
      });
    return () => {
      cancelled = true;
    };
  }, [providerId]);

  const existingByName = useMemo(
    () =>
      new Map(
        existingModels
          .filter((m) => m.provider_id === providerId)
          .map((m) => [m.model_name, m]),
      ),
    [existingModels, providerId],
  );

  const filtered = useMemo(() => {
    const f = filter.trim().toLowerCase();
    // Discovery is always provider-wide; this only filters the visible library.
    // Multimodal also shows under chat to match the matrix view.
    const capMatch = (m: DiscoveredModel) => {
      if (capability === 'all') return true;
      if (capability === 'chat') return m.capability === 'chat' || m.capability === 'multimodal';
      return m.capability === capability;
    };
    return discovered
      .filter(capMatch)
      .filter((m) => {
        const existing = existingByName.get(m.model_name);
        if (libraryStatus === 'unmanaged') return !existing;
        if (libraryStatus === 'enabled') return existing?.enabled === true;
        if (libraryStatus === 'disabled') return existing?.enabled === false;
        return true;
      })
      .filter((m) =>
        f === ''
          ? true
          : m.model_name.toLowerCase().includes(f) ||
            (m.display_name ?? '').toLowerCase().includes(f),
      );
  }, [discovered, filter, capability, existingByName, libraryStatus]);

  const managedDiffs = useMemo(
    () =>
      discovered
        .map((m) => managedDiff(existingByName.get(m.model_name), m))
        .filter((diff): diff is ManagedModelDiff => diff !== null),
    [discovered, existingByName],
  );
  const changedManagedCount = managedDiffs.length;

  const toggle = (name: string): void => {
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const onImport = async (): Promise<void> => {
    if (!providerId || picked.size === 0) return;
    setImporting(true);
    setErr(null);
    try {
      const toImport = discovered.filter((m) => picked.has(m.model_name));
      for (const m of toImport) {
        await api.createModel({
          provider_id: providerId,
          model_name: m.model_name,
          display_name: m.display_name ?? m.model_name,
          capability: m.capability,
          price_input_per_1m: m.price_input_per_1m ?? null,
          price_output_per_1m: m.price_output_per_1m ?? null,
          price_per_image: m.price_per_image ?? null,
          price_per_video_second: m.price_per_video_second ?? null,
          pricing_meta: m.pricing_meta ?? null,
          context_length: m.context_length ?? null,
          supports_vision: m.supports_vision ?? false,
          supports_tools: m.supports_tools ?? isChatCapable(m.capability),
          modalities: m.modalities ?? undefined,
          enabled: importEnabled,
        });
      }
      await onImported();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  };

  const onToggleExisting = async (model: Model): Promise<void> => {
    setErr(null);
    try {
      await api.updateModel(model.id, { enabled: !model.enabled });
      await onModelsChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const onSyncManaged = async (): Promise<void> => {
    if (!providerId) return;
    setErr(null);
    setSyncingManaged(true);
    try {
      await onProviderSynced(providerId);
      await discover();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncingManaged(false);
    }
  };

  return (
    <div
      className="import-drawer-overlay"
      role="dialog"
      aria-modal="true"
      data-testid="import-drawer"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="import-drawer">
        <header className="import-drawer__head">
          <h3>导入模型</h3>
          <button type="button" onClick={onClose} aria-label="关闭">✕</button>
        </header>

        {changedManagedCount > 0 && (
          <div className="import-drawer__sync" data-testid="import-drawer-managed-sync">
            <div>
              <strong>发现 {changedManagedCount} 个已管理模型可同步</strong>
              <p className="hint">只更新价格、能力、上下文、视觉/工具支持，不会改别名、默认、启停和排序。</p>
              <details className="import-drawer__diff-preview" data-testid="import-drawer-diff-preview">
                <summary>查看变更预览</summary>
                <ul>
                  {managedDiffs.slice(0, 20).map((diff) => (
                    <li key={diff.model.id}>
                      <span>{diff.model.display_name ?? diff.model.model_name}</span>
                      <em>{diff.changes.join('；')}</em>
                    </li>
                  ))}
                </ul>
                {managedDiffs.length > 20 && (
                  <p className="hint">还有 {managedDiffs.length - 20} 个模型未展开显示。</p>
                )}
              </details>
            </div>
            <button
              type="button"
              className="model-center-action-btn model-center-action-btn--secondary"
              onClick={() => void onSyncManaged()}
              disabled={!providerId || syncingManaged}
              data-testid="import-drawer-sync-managed"
            >
              {syncingManaged ? '同步中…' : '同步已管理模型'}
            </button>
          </div>
        )}

        <div className="import-drawer__filters">
          <label>
            Provider
            <select
              value={providerId ?? ''}
              onChange={(e) => setProviderId(e.target.value || null)}
              data-testid="import-drawer-provider"
            >
              {providers.length === 0 && <option value="">（无）</option>}
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}（{p.type}）
                </option>
              ))}
            </select>
          </label>
          <label>
            展示能力
            <select
              value={capability}
              onChange={(e) => setCapability(e.target.value as ImportCapabilityFilter)}
              data-testid="import-drawer-capability"
            >
              <option value="all">全部能力</option>
              {CAPABILITY_TABS.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            状态
            <select
              value={libraryStatus}
              onChange={(e) => setLibraryStatus(e.target.value as 'all' | 'unmanaged' | 'enabled' | 'disabled')}
              data-testid="import-drawer-status"
            >
              <option value="all">全部候选</option>
              <option value="unmanaged">只看未管理</option>
              <option value="enabled">只看已启用</option>
              <option value="disabled">只看已停用</option>
            </select>
          </label>
          <label>
            搜索
            <input
              type="search"
              placeholder="model_name 或 display_name…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              data-testid="import-drawer-filter"
            />
          </label>
          <button
            type="button"
            className="model-center-action-btn model-center-action-btn--secondary"
            onClick={() => void discover()}
            disabled={!providerId || discovering}
            data-testid="import-drawer-refresh"
          >
            {discovering ? '刷新中…' : '刷新全部清单'}
          </button>
        </div>

        <p className="hint" data-testid="import-drawer-counts">
          刷新会拉取该 Provider 的全部能力清单；当前展示 {filtered.length} / 已刷新 {discovered.length} 个候选。
        </p>

        {discovering ? (
          <p className="hint">发现中…（首次可能 2–5 秒）</p>
        ) : err ? (
          <p className="err" data-testid="import-drawer-err">{err}</p>
        ) : filtered.length === 0 ? (
          <p className="hint">
            该 Provider 在所选能力下没有可用模型；切换能力或搜索其它关键字试试。
          </p>
        ) : (
          <ul className="import-drawer__list" data-testid="import-drawer-list">
            {filtered.map((m) => {
              const existing = existingByName.get(m.model_name);
              const isExisting = Boolean(existing);
              const isPicked = picked.has(m.model_name);
              const diff = managedDiff(existing, m);
              const hasManagedDiff = diff !== null;
              const priceHint = discoveredPrice(m);
              const managedState = existing
                ? existing.enabled
                  ? 'enabled'
                  : 'disabled'
                : 'unmanaged';
              return (
                <li
                  key={m.model_name}
                  className={isExisting ? 'is-existing' : ''}
                  data-managed-state={managedState}
                  data-testid={`import-drawer-row-${m.model_name}`}
                >
                  <label>
                    <input
                      type="checkbox"
                      disabled={isExisting}
                      checked={isPicked}
                      onChange={() => toggle(m.model_name)}
                      data-testid={`import-drawer-pick-${m.model_name}`}
                    />
                    <span className="import-row__name">
                      {m.display_name ?? m.model_name}
                      {m.supports_vision && <span title="支持视觉"> 👁</span>}
                    </span>
                    <span className="import-row__id">{m.model_name}</span>
                    <span className="import-row__price">
                      {m.capability === 'image'
                        ? `每张 ${formatUsd(m.price_per_image ?? null)}`
                        : m.capability === 'video'
                          ? `每秒 ${formatUsd(m.price_per_video_second ?? null)}`
                          : `输入 ${formatUsd(m.price_input_per_1m ?? null)} · 输出 ${formatUsd(m.price_output_per_1m ?? null)}`}
                      {priceHint == null ? ' · 价格未知' : ''}
                    </span>
                    {existing ? (
                      <>
                        <span className={`badge ${existing.enabled ? 'badge--enabled' : 'badge--disabled'}`}>
                          {existing.enabled ? '已启用' : '已停用'}
                        </span>
                        {hasManagedDiff && (
                          <span
                            className="badge badge--price_changed"
                            data-testid={`import-drawer-diff-${existing.id}`}
                            title={diff.changes.join('；')}
                          >
                            可同步
                          </span>
                        )}
                        {diff && <span className="import-row__diff">{diff.changes[0]}</span>}
                        <button
                          type="button"
                          className="import-row__toggle"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            void onToggleExisting(existing);
                          }}
                          data-testid={`import-drawer-toggle-${existing.id}`}
                        >
                          {existing.enabled ? '停用' : '启用'}
                        </button>
                      </>
                    ) : (
                      <span className="badge badge--unmanaged">未管理</span>
                    )}
                  </label>
                </li>
              );
            })}
          </ul>
        )}

        <footer className="import-drawer__foot">
          <label className="field-inline">
            <input
              type="checkbox"
              checked={importEnabled}
              onChange={(e) => setImportEnabled(e.target.checked)}
              data-testid="import-drawer-import-enabled"
            />
            <span>导入后立即启用</span>
          </label>
          <span className="hint">
            已选 {picked.size} 项 / 当前展示 {filtered.length} 个候选
          </span>
          <button
            type="button"
            className="btn-primary"
            disabled={picked.size === 0 || importing}
            onClick={() => void onImport()}
            data-testid="import-drawer-confirm"
          >
            {importing ? '导入中…' : `导入 ${picked.size} 个模型`}
          </button>
        </footer>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// EditProviderDialog — provider metadata, endpoint, key refresh and enablement.
// ----------------------------------------------------------------------------
function EditProviderDialog({
  provider,
  onCancel,
  onSave,
  keyMissing = false,
}: {
  provider: Provider;
  onCancel: () => void;
  onSave: (patch: ProviderUpdate) => void;
  keyMissing?: boolean;
}): JSX.Element {
  const [name, setName] = useState(provider.name);
  const [baseUrl, setBaseUrl] = useState(provider.base_url);
  const [apiKey, setApiKey] = useState('');
  const [enabled, setEnabled] = useState(provider.enabled);

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    const patch: ProviderUpdate = {
      name: name.trim() || provider.name,
      base_url: baseUrl.trim() || provider.base_url,
      enabled,
    };
    if (apiKey.trim()) {
      patch.api_key = apiKey.trim();
    }
    onSave(patch);
  };

  return (
    <div className="modal-backdrop" onClick={onCancel} data-testid="provider-editor-backdrop">
      <div
        className="modal-card provider-editor"
        onClick={(e) => e.stopPropagation()}
        data-testid="provider-editor"
        role="dialog"
        aria-modal="true"
        aria-label="编辑 Provider"
      >
        <header className="modal-card__head">
          <div>
            <h3>{keyMissing ? '重新填写 Provider Key' : '编辑 Provider'}</h3>
            <p className="hint">
              {keyMissing
                ? '系统钥匙串中找不到该 Provider 的 API Key，保存新 Key 后会重新写入钥匙串。'
                : providerTypeDisplay(provider)}
            </p>
          </div>
          <button type="button" onClick={onCancel} aria-label="关闭">
            ✕
          </button>
        </header>
        <form onSubmit={submit} className="model-editor__body">
          <label className="field">
            <span>名称</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              data-testid="provider-editor-name"
            />
          </label>
          <label className="field">
            <span>Base URL</span>
            <input
              type="url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              data-testid="provider-editor-base-url"
            />
          </label>
          <label className="field">
            <span>{provider.type === 'ollama' ? 'API Key（Ollama 本地无需填写）' : 'API Key（留空则保持当前 Key）'}</span>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={
                keyMissing
                  ? 'Key 缺失，请输入新 Key'
                  : provider.api_key_ref
                    ? '已配置，输入新 Key 可替换'
                    : provider.type === 'ollama'
                      ? '留空即可使用本地 Ollama'
                      : '未配置，请输入 Key'
              }
              data-testid="provider-editor-api-key"
            />
          </label>
          <label className="field-inline">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              data-testid="provider-editor-enabled"
            />
            <span>启用该 Provider（关闭后不参与全局价格同步，已导入模型仍可管理）</span>
          </label>
          <footer className="model-editor__foot">
            <button type="button" onClick={onCancel} data-testid="provider-editor-cancel">
              取消
            </button>
            <button type="submit" className="btn-primary" data-testid="provider-editor-save">
              保存
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// EditModelDialog — manual edit for alias / capability / pricing.
//
// Pricing fields shown depend on the (possibly-changed) capability:
//   chat / multimodal / embedding → input + output per 1M tokens
//   image                          → per image
//   video                          → per second
//   asr / tts                      → per call (fallback)
// `price_per_call` is always editable as a "其他计费" fallback.
//
// When the user changes capability away from the original, we also clear
// `is_default_for` (because the existing default association no longer makes
// sense, e.g. a chat model relabelled as image must not stay the chat default).
// ----------------------------------------------------------------------------

function EditModelDialog(props: {
  model: Model;
  onCancel: () => void;
  onSave: (patch: import('@taori/shared').ModelUpdate) => void;
}): JSX.Element {
  const { model, onCancel, onSave } = props;
  const [alias, setAlias] = useState(model.alias ?? '');
  const [displayName, setDisplayName] = useState(model.display_name);
  const [capability, setCapability] = useState<ModelCapability>(
    model.capability as ModelCapability,
  );
  const [supportsVision, setSupportsVision] = useState(model.supports_vision);
  const [supportsTools, setSupportsTools] = useState(model.supports_tools);
  const [thinkingMode, setThinkingMode] = useState<'inherit' | 'enabled' | 'disabled'>(
    model.thinking_enabled == null ? 'inherit' : model.thinking_enabled ? 'enabled' : 'disabled',
  );
  const [pIn, setPIn] = useState<string>(model.price_input_per_1m?.toString() ?? '');
  const [pOut, setPOut] = useState<string>(model.price_output_per_1m?.toString() ?? '');
  const [pImage, setPImage] = useState<string>(model.price_per_image?.toString() ?? '');
  const [pVideo, setPVideo] = useState<string>(
    model.price_per_video_second?.toString() ?? '',
  );
  const [pCall, setPCall] = useState<string>(model.price_per_call?.toString() ?? '');
  const [currency, setCurrency] = useState<string>(model.price_currency ?? 'USD');
  const [pricingMetaText, setPricingMetaText] = useState<string>(
    model.pricing_meta ? JSON.stringify(model.pricing_meta, null, 2) : '',
  );
  const [pricingMetaError, setPricingMetaError] = useState<string | null>(null);

  const parseNum = (s: string): number | null => {
    const t = s.trim();
    if (t === '') return null;
    const n = Number(t);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    let pricingMeta: import('@taori/shared').PricingMeta | null = null;
    const pricingMetaRaw = pricingMetaText.trim();
    if (pricingMetaRaw) {
      try {
        const parsed = JSON.parse(pricingMetaRaw) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          setPricingMetaError('pricing_meta 必须是 JSON object。');
          return;
        }
        const obj = parsed as Record<string, unknown>;
        if (obj.version !== undefined && obj.version !== 1) {
          setPricingMetaError('version 当前只支持 1。');
          return;
        }
        if (typeof obj.unit !== 'string') {
          setPricingMetaError('pricing_meta.unit 必填，例如 image / video_second / call。');
          return;
        }
        if (obj.tiers !== undefined && !Array.isArray(obj.tiers)) {
          setPricingMetaError('pricing_meta.tiers 必须是数组。');
          return;
        }
        pricingMeta = {
          ...(obj as import('@taori/shared').PricingMeta),
          version: 1,
        };
      } catch (err) {
        setPricingMetaError(err instanceof Error ? err.message : String(err));
        return;
      }
    }
    setPricingMetaError(null);
    const patch: import('@taori/shared').ModelUpdate = {
      alias: alias.trim() || model.alias || model.display_name,
      display_name: displayName.trim() || model.display_name,
      capability,
      supports_vision: supportsVision,
      supports_tools: supportsTools,
      price_input_per_1m: parseNum(pIn),
      price_output_per_1m: parseNum(pOut),
      price_per_image: parseNum(pImage),
      price_per_video_second: parseNum(pVideo),
      price_per_call: parseNum(pCall),
      price_currency: currency.trim() || 'USD',
      pricing_meta: pricingMeta,
      thinking_enabled:
        capability === 'chat' || capability === 'multimodal'
          ? (thinkingMode === 'inherit' ? null : thinkingMode === 'enabled')
          : null,
    };
    if (capability !== model.capability && model.is_default_for) {
      patch.is_default_for = null;
    }
    onSave(patch);
  };

  const isToken = capability === 'chat' || capability === 'multimodal' || capability === 'embedding';
  const isImage = capability === 'image';
  const isVideo = capability === 'video';
  const isChatLike = capability === 'chat' || capability === 'multimodal';

  return (
    <div className="modal-backdrop" onClick={onCancel} data-testid="model-editor-backdrop">
      <div
        className="modal-card model-editor"
        onClick={(e) => e.stopPropagation()}
        data-testid="model-editor"
        role="dialog"
        aria-modal="true"
        aria-label="编辑模型"
      >
        <header className="modal-card__head">
          <div>
            <h3>编辑模型</h3>
            <p className="hint">{model.model_name}</p>
          </div>
          <button type="button" onClick={onCancel} aria-label="关闭">
            ✕
          </button>
        </header>
        <form onSubmit={submit} className="model-editor__body">
          <label className="field">
            <span>别名（用于切换器显示）</span>
            <input
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
              data-testid="model-editor-alias"
            />
          </label>
          <label className="field">
            <span>展示名</span>
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              data-testid="model-editor-display-name"
            />
          </label>
          <label className="field">
            <span>能力（修正错误识别的模型类型）</span>
            <select
              value={capability}
              onChange={(e) => setCapability(e.target.value as ModelCapability)}
              data-testid="model-editor-capability"
            >
              {CAPABILITY_TABS.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          {capability !== model.capability && model.is_default_for && (
            <p className="field-warn" data-testid="model-editor-cap-warn">
              ⚠ 能力已变更，原"默认 {model.is_default_for}"绑定将被解除。
            </p>
          )}
          <div className="field-row">
            <label className="field-inline">
              <input
                type="checkbox"
                checked={supportsVision}
                onChange={(e) => setSupportsVision(e.target.checked)}
                data-testid="model-editor-supports-vision"
              />
              <span>支持视觉</span>
            </label>
            <label className="field-inline">
              <input
                type="checkbox"
                checked={supportsTools}
                onChange={(e) => setSupportsTools(e.target.checked)}
                data-testid="model-editor-supports-tools"
              />
              <span>支持工具调用</span>
            </label>
          </div>
          <label className="field">
            <span>思考 / 推理</span>
            <select
              value={isChatLike ? thinkingMode : 'inherit'}
              onChange={(e) => setThinkingMode(e.target.value as 'inherit' | 'enabled' | 'disabled')}
              disabled={!isChatLike}
              data-testid="model-editor-thinking"
            >
              <option value="inherit">跟随全局</option>
              <option value="enabled">总是开启</option>
              <option value="disabled">总是关闭</option>
            </select>
          </label>
          <p className="hint">
            {isChatLike
              ? '单模型设置会覆盖全局默认；不同 provider 的 thinking 控制方式可能不同，系统会自动选择兼容方式。'
              : '当前仅聊天 / 多模态模型支持 thinking 配置；切换到其他能力时会自动改为跟随全局。'}
          </p>

          <fieldset className="pricing">
            <legend>价格（留空表示未知，将不计入成本估算）</legend>
            {isToken && (
              <>
                <label className="field">
                  <span>输入 / 1M tokens</span>
                  <input
                    inputMode="decimal"
                    value={pIn}
                    onChange={(e) => setPIn(e.target.value)}
                    placeholder="例如 0.5"
                    data-testid="model-editor-price-input"
                  />
                </label>
                <label className="field">
                  <span>输出 / 1M tokens</span>
                  <input
                    inputMode="decimal"
                    value={pOut}
                    onChange={(e) => setPOut(e.target.value)}
                    placeholder="例如 1.5"
                    data-testid="model-editor-price-output"
                  />
                </label>
              </>
            )}
            {isImage && (
              <label className="field">
                <span>每张图价格</span>
                <input
                  inputMode="decimal"
                  value={pImage}
                  onChange={(e) => setPImage(e.target.value)}
                  placeholder="例如 0.04"
                  data-testid="model-editor-price-image"
                />
              </label>
            )}
            {isVideo && (
              <label className="field">
                <span>每秒视频价格</span>
                <input
                  inputMode="decimal"
                  value={pVideo}
                  onChange={(e) => setPVideo(e.target.value)}
                  placeholder="例如 0.10"
                  data-testid="model-editor-price-video"
                />
              </label>
            )}
            <label className="field">
              <span>每次调用价格（其他计费 / asr / tts 等）</span>
              <input
                inputMode="decimal"
                value={pCall}
                onChange={(e) => setPCall(e.target.value)}
                placeholder="例如 0.002"
                data-testid="model-editor-price-call"
              />
            </label>
            <label className="field">
              <span>币种</span>
              <input
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                placeholder="USD"
                data-testid="model-editor-currency"
                style={{ maxWidth: 120 }}
              />
            </label>
            <label className="field">
              <span>pricing_meta（复杂分级规则 JSON）</span>
              <textarea
                value={pricingMetaText}
                onChange={(e) => setPricingMetaText(e.target.value)}
                rows={8}
                spellCheck={false}
                placeholder={'{"version":1,"unit":"image","tiers":[{"label":"1024x1024","match":{"size":"1024x1024"},"price_usd":0.04}]}'}
                data-testid="model-editor-pricing-meta"
              />
            </label>
            {pricingMetaError && (
              <p className="field-warn" data-testid="model-editor-pricing-meta-error">
                {pricingMetaError}
              </p>
            )}
            <p className="hint">
              pricing_meta 用于记录分辨率、时长、质量档位等复杂价格；当前成本估算仍优先使用上方基础价格字段。
            </p>
          </fieldset>

          <footer className="model-editor__foot">
            <button
              type="button"
              onClick={onCancel}
              data-testid="model-editor-cancel"
            >
              取消
            </button>
            <button
              type="submit"
              className="btn-primary"
              data-testid="model-editor-save"
            >
              保存
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
