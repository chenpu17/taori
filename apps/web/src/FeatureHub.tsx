import { useEffect, useMemo, useRef, useState } from 'react';
import type { Model, OrchestrationAnnotation, Provider } from '@taori/shared';
import { Icon } from './Icon';
import {
  adoptQuickCompareOutput,
  cancelResearchSession,
  createMcpServer,
  createResearchSession,
  createRoundtable,
  deleteMcpServer,
  exportResearchSession,
  exportRoundtable,
  getFileData,
  getMcpRuntime,
  getResearchSession,
  getRoundtable,
  invokeTool,
  listEffectiveTools,
  listMcpServers,
  listResearchSessions,
  listToolHealth,
  listTools,
  loopbackRoundtable,
  pauseResearchSession,
  refreshMcpServer,
  resumeResearchSession,
  reviseResearchPlan,
  restartMcpServer,
  searchFiles,
  setSessionToolEnabled,
  setToolEnabled,
  startResearchSession,
  streamQuickCompare,
  streamQuickCompareRetry,
  streamRoundtableRound,
  streamRoundtableSummarize,
  type Conversation,
  type EffectiveTool,
  type FileSearchResult,
  type McpServer,
  type QuickCompareAnnotation,
  type QuickCompareExecutionMode,
  type QuickCompareOutput,
  type QuickComparePreviewReason,
  type QuickCompareRun,
  type ResearchDetail,
  type ResearchPlan,
  type ResearchSession,
  type Roundtable,
  type RoundtableAnnotation,
  type RoundtableMessage,
  type Tool,
  type ToolHealthRow,
} from './api';
import { renderMarkdown } from './markdown';
import { CostPanel } from './feature/CostPanel';
import { TemplatesPanel } from './feature/TemplatesPanel';
import { MemoryPanel } from './feature/MemoryPanel';

export type FeatureTab =
  | 'compare'
  | 'roundtable'
  | 'research'
  | 'cost'
  | 'templates'
  | 'memory'
  | 'files'
  | 'tools';

interface FeatureToolTrace {
  key: string;
  target: string;
  tool: string;
  label: string;
  event: 'start' | 'finish';
  ok?: boolean;
  duration_ms?: number;
}

type FeatureOrchestration = Omit<OrchestrationAnnotation, 'type'> & {
  type: 'orchestration' | 'qc.orchestration' | 'rt.orchestration';
};

interface QuickCompareOutputView extends QuickCompareOutput {
  execution_mode?: QuickCompareExecutionMode;
  preview_reason?: QuickComparePreviewReason | null;
}

interface FeatureHubProps {
  initialTab?: FeatureTab;
  providers: Provider[];
  models: Model[];
  conversations: Conversation[];
  activeConversationId: string | null;
  onOpenConversation: (id: string) => void;
  onToast: (message: string) => void;
  onError: (message: string) => void;
  quickCompareModelIds: string[];
  onQuickCompareModelIdsChange: (ids: string[]) => void;
  onInsertComposer?: (text: string) => void;
  initialPrompt?: string | null;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function modelLabel(model: Model | undefined | null): string {
  if (!model) return '未知模型';
  return model.alias ?? model.display_name ?? model.model_name;
}

function providerLabelFor(model: Model | undefined | null, providers: Provider[]): string {
  if (!model) return '未知服务商';
  return providers.find((provider) => provider.id === model.provider_id)?.name ?? model.provider_id ?? '未知服务商';
}

function modelSourceLabel(model: Model | undefined | null, providers: Provider[]): string {
  if (!model) return '未知服务商';
  return `${providerLabelFor(model, providers)} · ${model.model_name}`;
}

function normalizeCompareModelName(model: Model): string {
  return (model.display_name ?? model.alias ?? model.model_name)
    .toLowerCase()
    .replace(/[\s_:/.-]+/g, '')
    .trim();
}

function canUseForQuickCompare(model: Model, providers: Provider[], now: number): boolean {
  if (!model.enabled) return false;
  if (!(model.capability === 'chat' || model.capability === 'multimodal')) return false;
  if (!model.provider_id) return false;
  if (model.demoted) return false;
  if (model.disabled_until != null && model.disabled_until > now) return false;
  return providers.find((provider) => provider.id === model.provider_id)?.enabled === true;
}

function sameStringList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function formatUsd(value: number | null | undefined): string {
  if (value == null) return '未计费';
  if (value === 0) return '$0.00';
  if (value < 0.01) return '<$0.01';
  return `$${value.toFixed(value < 1 ? 4 : 2)}`;
}

function previewReasonLabel(reason: QuickComparePreviewReason | null | undefined): string {
  if (reason === 'provider_missing') return '模型缺少服务商配置';
  if (reason === 'api_key_missing') return '未配置或无法读取 API Key';
  if (reason === 'keystore_read_failed') return '读取本机 Keychain 失败';
  return '未满足真实调用条件';
}

function quickCompareErrorMessage(output: QuickCompareOutputView, model: Model | undefined, providers: Provider[]): string {
  const source = providerLabelFor(model, providers);
  const toolHint = output.tool_names.length > 0
    ? `本次同时携带 ${output.tool_names.length} 个工具，若连续失败，可以重试或临时关闭该模型的工具能力。`
    : '可以稍后重试，或换一个同源模型再试。';
  if (output.error_classification === 'rate_limit') {
    return `${source} 返回限流。${toolHint}`;
  }
  if (output.error_classification === 'quota') {
    return `${source} 返回额度或余额不足。请检查服务商控制台后再试。`;
  }
  if (output.error_classification === 'auth') {
    return `${source} 认证失败。请检查 API Key 或服务商权限。`;
  }
  if (output.error_classification === 'network') {
    return `${source} 网络请求失败。请稍后重试。`;
  }
  if (output.error_classification === 'config_error') {
    return `${source} 返回配置错误。请检查模型名、Base URL 或工具能力配置。`;
  }
  return output.error_message
    ? `${output.error_classification ?? 'unknown'}：${output.error_message}`
    : '候选输出失败。';
}

function compareStatusLabel(output: QuickCompareOutputView): string {
  if (output.execution_mode === 'local_preview') return '本地预览';
  if (output.status === 'complete') return '已完成';
  if (output.status === 'streaming') return '生成中';
  if (output.status === 'failed') {
    if (output.error_classification === 'rate_limit') return '限流失败';
    if (output.error_classification === 'quota') return '额度失败';
    if (output.error_classification === 'auth') return '认证失败';
    return '失败';
  }
  if (output.status === 'cancelled') return '已取消';
  return '等待中';
}

function firstDefined<T>(items: T[]): T | undefined {
  return items.find((item) => item != null);
}

function toolFriendlyName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes('web_search')) return '联网搜索';
  if (lower.includes('web_fetch')) return '读取网页';
  if (lower.includes('file_search')) return '文件搜索';
  if (lower.includes('file_read')) return '读取文件';
  if (lower.includes('image')) return '图像工具';
  if (lower.includes('mcp')) return name.replace(/^mcp\./, 'MCP · ');
  return name.replace(/^builtin\./, '').replace(/_/g, ' ');
}

function toolCategory(name: string, capability: string): 'search' | 'file' | 'media' | 'other' {
  const text = `${name} ${capability}`.toLowerCase();
  if (text.includes('search') || text.includes('fetch') || text.includes('web')) return 'search';
  if (text.includes('file') || text.includes('document')) return 'file';
  if (text.includes('image') || text.includes('vision')) return 'media';
  return 'other';
}

function toolCategoryLabel(category: ReturnType<typeof toolCategory>): string {
  if (category === 'search') return '搜索与网页';
  if (category === 'file') return '文件与本地上下文';
  if (category === 'media') return '图像与多模态';
  return '其他工具';
}

function toolStatusLabel(enabled: boolean): string {
  return enabled ? '已启用' : '已关闭';
}

export function FeatureHub(props: FeatureHubProps): JSX.Element {
  const [tab, setTab] = useState<FeatureTab>(props.initialTab ?? 'compare');
  useEffect(() => {
    setTab(props.initialTab ?? 'compare');
  }, [props.initialTab]);

  const tabGroups: Array<{ label: string; tabs: Array<{ id: FeatureTab; label: string; icon: Parameters<typeof Icon>[0]['name']; note: string }> }> = [
    {
      label: '做决策',
      tabs: [
        { id: 'compare', label: '快速对比', icon: 'panel', note: '同题多答' },
        { id: 'roundtable', label: '圆桌', icon: 'sparkle', note: '共识与分歧' },
      ],
    },
    {
      label: '做研究',
      tabs: [
        { id: 'research', label: '深度研究', icon: 'book', note: '计划到报告' },
        { id: 'files', label: '文件', icon: 'folder', note: '本地上下文' },
      ],
    },
    {
      label: '个性化',
      tabs: [
        { id: 'templates', label: '模板 / 人格', icon: 'pen', note: '常用提示' },
        { id: 'memory', label: '记忆', icon: 'palette', note: '偏好可控' },
      ],
    },
    {
      label: '系统',
      tabs: [
        { id: 'cost', label: '成本', icon: 'flame', note: '每分钱可见' },
        { id: 'tools', label: '工具管理', icon: 'bolt', note: '内置工具 / MCP' },
      ],
    },
  ];
  return (
    <>
      <div className="topbar with-border">
        <div className="topbar-title">能力中心</div>
      </div>
      <div className="feature-shell scroll">
        <div className="feature-tabs" role="tablist" aria-label="P1 能力">
          {tabGroups.map((group) => (
            <div className="feature-tab-group" key={group.label}>
              <div className="feature-tab-group-label">{group.label}</div>
              <div className="feature-tab-group-buttons">
                {group.tabs.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="tab"
                    aria-selected={tab === item.id}
                    aria-controls={`feature-panel-${item.id}`}
                    className={tab === item.id ? 'active' : ''}
                    onClick={() => setTab(item.id)}
                    data-testid={`feature-tab-${item.id}`}
                  >
                    <Icon name={item.icon} size={14} />
                    <span>
                      <strong>{item.label}</strong>
                      <small>{item.note}</small>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
        {tab === 'compare' && <QuickComparePanel {...props} panelId="feature-panel-compare" />}
        {tab === 'roundtable' && <RoundtablePanel {...props} panelId="feature-panel-roundtable" />}
        {tab === 'research' && <ResearchPanel {...props} panelId="feature-panel-research" />}
        {tab === 'cost' && <CostPanel panelId="feature-panel-cost" />}
        {tab === 'templates' && (
          <TemplatesPanel
            panelId="feature-panel-templates"
            onUsePromptTemplate={props.onInsertComposer}
          />
        )}
        {tab === 'memory' && (
          <MemoryPanel
            panelId="feature-panel-memory"
            activeConversationId={props.activeConversationId}
          />
        )}
        {tab === 'files' && <FilesPanel {...props} panelId="feature-panel-files" />}
        {tab === 'tools' && <ToolsPanel {...props} panelId="feature-panel-tools" />}
      </div>
    </>
  );
}

function panelProps(panelId?: string): { id?: string; role: 'tabpanel' } {
  return { id: panelId, role: 'tabpanel' };
}

function ToolTraceList({ traces }: { traces: FeatureToolTrace[] }): JSX.Element {
  return (
    <div className="feature-list compact">
      {traces.map((trace) => (
        <div className="feature-list-row" key={trace.key}>
          <strong>{trace.target} · {trace.label || trace.tool}</strong>
          <span>
            {trace.event}
            {trace.ok != null ? ` · ${trace.ok ? 'ok' : 'failed'}` : ''}
            {trace.duration_ms != null ? ` · ${trace.duration_ms}ms` : ''}
          </span>
        </div>
      ))}
    </div>
  );
}

function orchestrationReasonText(reason: FeatureOrchestration['reason']): string {
  switch (reason) {
    case 'explicit_search':
      return '明确要求搜索，已自动联网';
    case 'freshness_required':
      return '依赖最新信息，已自动联网';
    case 'evidence_required':
      return '需要来源依据，已自动联网';
    case 'high_stakes_current':
      return '涉及报名、政策或高风险时效信息，已自动联网';
    case 'deep_research_candidate':
      return '适合深度研究，已补充网页上下文';
    case 'local_context_available':
      return '已优先考虑本地上下文';
    default:
      return '按输入内容自动选择能力';
  }
}

function OrchestrationNotice({ plan }: { plan: FeatureOrchestration }): JSX.Element {
  const detailParts: string[] = [];
  if (plan.external_info === 'web_search_fetch') detailParts.push('搜索并预读网页');
  else if (plan.external_info === 'web_search') detailParts.push('搜索网页');
  else if (plan.external_info === 'deep_research_suggest') detailParts.push('建议深度研究');
  if (plan.search_tool_name) detailParts.push(plan.search_tool_name);
  if (plan.query_count > 0) detailParts.push(`${plan.query_count} 个查询`);
  if (plan.fetch_top_k > 0) detailParts.push(`预读 ${plan.fetch_top_k} 条`);
  if (plan.cite_required) detailParts.push('要求引用来源');
  return (
    <div className="orchestration-notice feature-orchestration" data-testid="feature-orchestration-notice">
      <Icon name="search" size={13} />
      <span>{orchestrationReasonText(plan.reason)}</span>
      {detailParts.length > 0 && <em>{detailParts.join(' · ')}</em>}
    </div>
  );
}

function stopAbortController(controller: AbortController): () => void {
  return () => controller.abort();
}

function QuickComparePanel(props: FeatureHubProps & { panelId?: string }): JSX.Element {
  const chatModels = useMemo(
    () => {
      const now = Date.now();
      return props.models.filter((model) => canUseForQuickCompare(model, props.providers, now));
    },
    [props.models, props.providers],
  );
  const modelById = useMemo(() => new Map(chatModels.map((model) => [model.id, model])), [chatModels]);
  const defaultSlotIds = useMemo(() => chatModels.slice(0, 3).map((m) => m.id), [chatModels]);
  const distinctProviderSlotIds = useMemo(() => {
    const ids: string[] = [];
    const providerKeys = new Set<string>();
    for (const model of chatModels) {
      const key = model.provider_id ?? `unknown:${model.id}`;
      if (providerKeys.has(key)) continue;
      providerKeys.add(key);
      ids.push(model.id);
      if (ids.length >= 3) break;
    }
    for (const model of chatModels) {
      if (ids.length >= 3) break;
      if (!ids.includes(model.id)) ids.push(model.id);
    }
    return ids;
  }, [chatModels]);
  const duplicateNameSlotIds = useMemo(() => {
    const groups = new Map<string, Model[]>();
    for (const model of chatModels) {
      const key = normalizeCompareModelName(model);
      groups.set(key, [...(groups.get(key) ?? []), model]);
    }
    const duplicateGroup = [...groups.values()]
      .filter((group) => group.length >= 2)
      .sort((a, b) => b.length - a.length)[0];
    if (!duplicateGroup) return [];
    const ids: string[] = [];
    const providerKeys = new Set<string>();
    for (const model of duplicateGroup) {
      const key = model.provider_id ?? `unknown:${model.id}`;
      if (providerKeys.has(key)) continue;
      providerKeys.add(key);
      ids.push(model.id);
      if (ids.length >= 3) break;
    }
    return ids;
  }, [chatModels]);
  const [prompt, setPrompt] = useState(props.initialPrompt?.trim() || '比较三种实现方案的取舍。');
  const initialSelectedIds = useMemo(() => {
    const remembered = props.quickCompareModelIds.filter((id) => modelById.has(id)).slice(0, 3);
    const fill = defaultSlotIds.filter((id) => !remembered.includes(id)).slice(0, 3 - remembered.length);
    return [...remembered, ...fill];
  }, [defaultSlotIds, modelById, props.quickCompareModelIds]);
  const [selectedIds, setSelectedIds] = useState<string[]>(initialSelectedIds);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [toolsEnabled, setToolsEnabled] = useState(false);
  const [compare, setCompare] = useState<QuickCompareRun | null>(null);
  const [outputs, setOutputs] = useState<QuickCompareOutputView[]>([]);
  const [toolTraces, setToolTraces] = useState<FeatureToolTrace[]>([]);
  const [orchestration, setOrchestration] = useState<FeatureOrchestration | null>(null);
  const [running, setRunning] = useState(false);
  const pendingDeltaRef = useRef<QuickCompareAnnotation[]>([]);
  const deltaFrameRef = useRef<number | null>(null);
  const streamStopRef = useRef<(() => void) | null>(null);
  const streamTokenRef = useRef(0);
  const availableSlotCount = Math.min(3, Math.max(2, chatModels.length));
  const selectedModels = selectedIds.map((id) => modelById.get(id)).filter((model): model is Model => Boolean(model));
  const visibleSlotIds = Array.from({ length: availableSlotCount }, (_, index) => selectedIds[index] ?? '');
  const completedOutputs = outputs.filter((output) => output.status === 'complete');
  const fastestOutput = firstDefined([...completedOutputs].sort((a, b) => (a.duration_ms ?? Number.POSITIVE_INFINITY) - (b.duration_ms ?? Number.POSITIVE_INFINITY)));
  const longestOutput = firstDefined([...completedOutputs].sort((a, b) => b.content.length - a.content.length));
  const failedOutputs = outputs.filter((output) => output.status === 'failed');
  const estimatedIntensity = toolsEnabled || selectedModels.length >= 3 ? '中' : '低';

  useEffect(() => {
    setSelectedIds((current) => {
      const base = current.length > 0 ? current : initialSelectedIds;
      const valid = base.filter((id) => modelById.has(id)).slice(0, 3);
      const fill = defaultSlotIds.filter((id) => !valid.includes(id)).slice(0, 3 - valid.length);
      const next = [...valid, ...fill];
      return sameStringList(current, next) ? current : next;
    });
  }, [defaultSlotIds, initialSelectedIds, modelById]);

  useEffect(() => {
    if (selectedIds.length < 2) return;
    if (!sameStringList(selectedIds, props.quickCompareModelIds)) {
      props.onQuickCompareModelIdsChange(selectedIds);
    }
  }, [props.onQuickCompareModelIdsChange, props.quickCompareModelIds, selectedIds]);

  function applySelection(modelIds: string[]): void {
    const next = [...new Set(modelIds.filter((id) => modelById.has(id)))].slice(0, 3);
    setSelectedIds(next);
    props.onQuickCompareModelIdsChange(next);
  }

  function presetReason(kind: 'default' | 'providers' | 'sameName'): string {
    if (kind === 'providers') return '跨服务商可以避开单家限流，也更容易看出回答风格差异。';
    if (kind === 'sameName') return '同名模型适合比较不同平台的稳定性、延迟和计费表现。';
    return '默认组合优先选择当前可用模型，适合快速得到多个候选答案。';
  }

  function updateSlot(slotIndex: number, modelId: string): void {
    const next = [...selectedIds];
    next[slotIndex] = modelId;
    applySelection(next);
  }

  function removeSlot(slotIndex: number): void {
    applySelection(selectedIds.filter((_, index) => index !== slotIndex));
  }

  function updateFromAnnotations(items: QuickCompareAnnotation[]): void {
    setOutputs((current) => {
      let next = [...current];
      for (const item of items) {
        if (item.type === 'qc.meta') {
          setCompare({
            id: item.compare_id,
            conversation_id: item.conversation_id,
            source_user_message_id: null,
            run_id: item.run_id,
            status: 'running',
            model_ids: item.model_ids,
            adopted_output_id: null,
            created_at: Date.now(),
            updated_at: Date.now(),
          });
        } else if (item.type === 'qc.participant_start') {
          const existing = next.find((output) => output.id === item.output_id);
          if (!existing) {
            next.push({
              id: item.output_id,
              compare_id: compare?.id ?? 'pending',
              participant_index: item.index,
              model_id: item.model_id,
              provider_id: item.provider_id ?? null,
              tool_names: item.tool_names ?? [],
              content: '',
              status: 'streaming',
              error_classification: null,
              error_message: null,
              cost_record_id: null,
              first_token_ms: null,
              duration_ms: null,
              created_at: Date.now(),
              updated_at: Date.now(),
              execution_mode: item.execution_mode,
              preview_reason: item.preview_reason ?? null,
            });
          } else {
            next = next.map((output) => output.id === item.output_id ? {
              ...output,
              participant_index: item.index,
              model_id: item.model_id,
              provider_id: item.provider_id ?? output.provider_id,
              tool_names: item.tool_names ?? [],
              content: '',
              status: 'streaming',
              error_classification: null,
              error_message: null,
              cost_record_id: null,
              first_token_ms: null,
              duration_ms: null,
              updated_at: Date.now(),
              execution_mode: item.execution_mode,
              preview_reason: item.preview_reason ?? null,
            } : output);
          }
        } else if (item.type === 'qc.participant_delta') {
          next = next.map((output) =>
            output.id === item.output_id
              ? { ...output, content: `${output.content}${item.text_chunk}`, status: 'streaming' }
              : output,
          );
        } else if (item.type === 'qc.participant_done') {
          next = next.map((output) =>
            output.id === item.output_id
              ? {
                  ...output,
                  content: item.content || output.content,
                  status: 'complete',
                  cost_record_id: item.cost_record_id,
                  first_token_ms: item.first_token_ms ?? null,
                  duration_ms: item.duration_ms ?? null,
                  execution_mode: item.execution_mode ?? output.execution_mode,
                  preview_reason: item.preview_reason ?? output.preview_reason ?? null,
                }
              : output,
          );
        } else if (item.type === 'qc.participant_failed') {
          next = next.map((output) =>
            output.id === item.output_id
              ? {
                  ...output,
                  status: 'failed',
                  error_classification: item.classification,
                  error_message: item.message,
                }
              : output,
          );
        } else if (item.type === 'qc.tool_trace') {
          const key = `${item.output_id}:${item.call_id}:${item.event}`;
          setToolTraces((current) => [
            {
              key,
              target: `候选 ${item.index + 1}`,
              tool: item.tool,
              label: item.label,
              event: item.event,
              ok: item.ok,
              duration_ms: item.duration_ms,
            },
            ...current.filter((trace) => trace.key !== key),
          ].slice(0, 8));
        } else if (item.type === 'qc.orchestration') {
          setOrchestration({ ...item, type: 'qc.orchestration' });
        } else if (item.type === 'qc.done') {
          setCompare((currentCompare) => currentCompare ? {
            ...currentCompare,
            status: item.failed_output_ids.length > 0 ? 'partial_failed' : 'completed',
            updated_at: Date.now(),
          } : currentCompare);
        }
      }
      return next.sort((a, b) => a.participant_index - b.participant_index);
    });
  }

  function isCurrentStream(token: number): boolean {
    return streamTokenRef.current === token;
  }

  function stopActiveStream(): void {
    streamTokenRef.current += 1;
    streamStopRef.current?.();
    streamStopRef.current = null;
    cancelPendingDeltas();
  }

  function flushPendingDeltas(): void {
    if (deltaFrameRef.current != null) {
      window.cancelAnimationFrame(deltaFrameRef.current);
      deltaFrameRef.current = null;
    }
    const items = pendingDeltaRef.current;
    pendingDeltaRef.current = [];
    if (items.length > 0) updateFromAnnotations(items);
  }

  function cancelPendingDeltas(): void {
    if (deltaFrameRef.current != null) {
      window.cancelAnimationFrame(deltaFrameRef.current);
      deltaFrameRef.current = null;
    }
    pendingDeltaRef.current = [];
  }

  function updateFromStreamAnnotations(items: QuickCompareAnnotation[]): void {
    const deltas = items.filter((item) => item.type === 'qc.participant_delta');
    const immediate = items.filter((item) => item.type !== 'qc.participant_delta');
    if (immediate.length > 0) {
      flushPendingDeltas();
      updateFromAnnotations(immediate);
    }
    if (deltas.length === 0) return;
    pendingDeltaRef.current = [...pendingDeltaRef.current, ...deltas];
    if (deltaFrameRef.current == null) {
      deltaFrameRef.current = window.requestAnimationFrame(flushPendingDeltas);
    }
  }

  useEffect(() => () => {
    stopActiveStream();
  }, []);

  async function start(): Promise<void> {
    const ids = selectedIds.filter((id) => modelById.has(id)).slice(0, 3);
    if (ids.length < 2) {
      props.onError('Quick Compare 至少需要两个聊天模型。');
      return;
    }
    stopActiveStream();
    const streamToken = streamTokenRef.current + 1;
    streamTokenRef.current = streamToken;
    const abortController = new AbortController();
    streamStopRef.current = stopAbortController(abortController);
    setRunning(true);
    setCompare(null);
    setOutputs([]);
    setToolTraces([]);
    setOrchestration(null);
    try {
      const stop = await streamQuickCompare(
        {
          conversation_id: props.activeConversationId ?? undefined,
          participant_configs: ids.map((modelId) => ({
            model_id: modelId,
            tool_names: toolsEnabled ? undefined : [],
          })),
          messages: [{ role: 'user', content: prompt.trim() }],
          confirmed_cost: true,
        },
        {
          onAnnotation: (items) => {
            if (isCurrentStream(streamToken)) updateFromStreamAnnotations(items);
          },
          onDone: () => {
            if (!isCurrentStream(streamToken)) return;
            flushPendingDeltas();
            streamStopRef.current = null;
            setRunning(false);
            props.onToast('Quick Compare 已完成。');
          },
          onError: (error) => {
            if (!isCurrentStream(streamToken)) return;
            cancelPendingDeltas();
            streamStopRef.current = null;
            setRunning(false);
            props.onError(describeError(error));
          },
        },
        { signal: abortController.signal },
      );
      if (isCurrentStream(streamToken)) streamStopRef.current = stop;
      else stop();
    } catch (error) {
      if (!isCurrentStream(streamToken)) return;
      streamStopRef.current = null;
      setRunning(false);
      props.onError(describeError(error));
    }
  }

  async function adopt(output: QuickCompareOutput): Promise<void> {
    if (!compare) return;
    stopActiveStream();
    setRunning(false);
    try {
      const result = await adoptQuickCompareOutput(compare.id, output.id);
      props.onToast('已采纳候选回复。');
      props.onOpenConversation(result.conversation_id);
    } catch (error) {
      props.onError(describeError(error));
    }
  }

  async function retry(output: QuickCompareOutput): Promise<void> {
    if (!compare) return;
    stopActiveStream();
    const streamToken = streamTokenRef.current + 1;
    streamTokenRef.current = streamToken;
    const abortController = new AbortController();
    streamStopRef.current = stopAbortController(abortController);
    setRunning(true);
    try {
      const stop = await streamQuickCompareRetry(
        compare.id,
        { output_id: output.id, confirmed_cost: true },
        {
          onAnnotation: (items) => {
            if (isCurrentStream(streamToken)) updateFromStreamAnnotations(items);
          },
          onDone: () => {
            if (!isCurrentStream(streamToken)) return;
            flushPendingDeltas();
            streamStopRef.current = null;
            setRunning(false);
            props.onToast('候选已重试。');
          },
          onError: (error) => {
            if (!isCurrentStream(streamToken)) return;
            cancelPendingDeltas();
            streamStopRef.current = null;
            setRunning(false);
            props.onError(describeError(error));
          },
        },
        { signal: abortController.signal },
      );
      if (isCurrentStream(streamToken)) streamStopRef.current = stop;
      else stop();
    } catch (error) {
      if (!isCurrentStream(streamToken)) return;
      streamStopRef.current = null;
      setRunning(false);
      props.onError(describeError(error));
    }
  }

  return (
    <section className="feature-panel" data-testid="quick-compare-panel" {...panelProps(props.panelId)}>
      <div className="feature-header">
        <div>
          <h2>快速对比</h2>
          <p>把同一个问题交给几个模型，直接比较速度、稳定性和回答质量。</p>
        </div>
        <button type="button" className="btn-primary" onClick={() => void start()} disabled={running || selectedModels.length < 2} data-testid="quick-compare-start">
          {running ? '对比中' : '开始对比'}
        </button>
      </div>
      <div className="compare-composer">
        <textarea className="feature-textarea" value={prompt} onChange={(event) => setPrompt(event.target.value)} data-testid="quick-compare-prompt" />
        <div className="compare-run-preview" data-testid="quick-compare-run-preview">
          <div>
            <span className="summary-label">预计强度</span>
            <strong>{estimatedIntensity}</strong>
          </div>
          <div>
            <span className="summary-label">将调用</span>
            <strong>{selectedModels.length || 0} 个模型 · 1 轮</strong>
          </div>
          <div>
            <span className="summary-label">成本提醒</span>
            <strong>{toolsEnabled ? '可能更高' : '较可控'}</strong>
          </div>
        </div>
        <div className="compare-options">
          <label className="compare-toggle">
            <input
              type="checkbox"
              checked={toolsEnabled}
              onChange={(event) => setToolsEnabled(event.currentTarget.checked)}
              data-testid="quick-compare-tools-toggle"
            />
            <span>
              <strong>联网 / 工具</strong>
              <small>{toolsEnabled ? '开启：模型可调用当前会话工具' : '关闭：只比较纯回答，失败更少'}</small>
            </span>
          </label>
          <span className="compare-helper">最多选择 3 个模型；工具开启时，部分服务商可能更容易限流。</span>
        </div>
      </div>
      <div className="compare-picker" data-testid="quick-compare-picker">
        <div className="compare-picker-main">
          <div>
            <strong>对比模型</strong>
            <span>{selectedModels.length}/3 · {selectedModels.map((model) => modelLabel(model)).join('、') || '未选择'}</span>
          </div>
          <button
            type="button"
            className="btn-primary"
            onClick={() => setPickerOpen(true)}
            disabled={running || chatModels.length < 2}
            data-testid="quick-compare-open-picker"
          >
            选择模型
          </button>
        </div>
        <div className="compare-strategies" aria-label="推荐组合">
          <button
            type="button"
            className="strategy-chip"
            onClick={() => {
              applySelection(defaultSlotIds);
              props.onToast(presetReason('default'));
            }}
            disabled={running || defaultSlotIds.length < 2}
          >
            稳妥组合
          </button>
          <button
            type="button"
            className="strategy-chip"
            onClick={() => {
              applySelection(distinctProviderSlotIds);
              props.onToast(presetReason('providers'));
            }}
            disabled={running || distinctProviderSlotIds.length < 2}
          >
            跨服务商
          </button>
          <button
            type="button"
            className="strategy-chip"
            onClick={() => {
              applySelection(duplicateNameSlotIds);
              props.onToast(presetReason('sameName'));
            }}
            disabled={running || duplicateNameSlotIds.length < 2}
          >
            同名模型
          </button>
        </div>
      </div>
      {pickerOpen && (
        <QuickCompareModelPickerDialog
          models={chatModels}
          providers={props.providers}
          selectedIds={selectedIds}
          presetIds={{
            default: defaultSlotIds,
            providers: distinctProviderSlotIds,
            sameName: duplicateNameSlotIds,
          }}
          onApply={(ids) => {
            applySelection(ids);
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
      <div className="compare-slots" data-testid="quick-compare-slots">
        {visibleSlotIds.map((modelId, index) => {
          const model = modelById.get(modelId);
          return (
            <div className="compare-slot" key={`slot-${index}`} data-testid={`quick-compare-slot-${index}`}>
              <div className="compare-slot-label">模型 {index + 1}</div>
              <select
                value={modelId}
                onChange={(event) => updateSlot(index, event.currentTarget.value)}
                disabled={running}
                aria-label={`选择对比模型 ${index + 1}`}
              >
                <option value="" disabled>选择模型</option>
                {chatModels.map((candidate) => (
                  <option
                    key={candidate.id}
                    value={candidate.id}
                    disabled={selectedIds.includes(candidate.id) && candidate.id !== modelId}
                  >
                    {providerLabelFor(candidate, props.providers)} · {modelLabel(candidate)}
                  </option>
                ))}
              </select>
              <div className="compare-slot-meta" title={modelSourceLabel(model, props.providers)}>
                {model ? modelSourceLabel(model, props.providers) : '未选择'}
              </div>
              {index >= 2 && selectedModels.length > 2 && (
                <button type="button" className="btn-quiet compare-slot-remove" onClick={() => removeSlot(index)} disabled={running}>
                  移除
                </button>
              )}
            </div>
          );
        })}
      </div>
      {outputs.length > 0 && (
        <div className="compare-summary" data-testid="quick-compare-summary">
          <div>
            <span className="summary-label">最快</span>
            <strong>{fastestOutput ? modelLabel(modelById.get(fastestOutput.model_id)) : '等待结果'}</strong>
          </div>
          <div>
            <span className="summary-label">内容最充分</span>
            <strong>{longestOutput ? modelLabel(modelById.get(longestOutput.model_id)) : '等待结果'}</strong>
          </div>
          <div>
            <span className="summary-label">失败</span>
            <strong>{failedOutputs.length > 0 ? `${failedOutputs.length} 个候选` : '无'}</strong>
          </div>
        </div>
      )}
      {orchestration && <OrchestrationNotice plan={orchestration} />}
      {toolTraces.length > 0 && (
        <div className="feature-card" data-testid="quick-compare-tool-traces">
          <h3>工具调用</h3>
          <ToolTraceList traces={toolTraces} />
        </div>
      )}
      <div className="compare-grid">
        {outputs.map((output) => {
          const model = chatModels.find((item) => item.id === output.model_id);
          const canAdopt = output.status === 'complete' && output.content.trim().length > 0 && !output.error_message;
          return (
            <article className="compare-card" key={output.id} data-testid={`quick-compare-output-${output.participant_index}`}>
              <div className="compare-head">
                {
                  <div className="compare-model-title">
                    <strong>{modelLabel(model)}</strong>
                    <span>{modelSourceLabel(model, props.providers)}</span>
                  </div>
                }
                <span className={`status-chip ${output.execution_mode === 'local_preview' ? 'preview' : output.status}`}>
                  {compareStatusLabel(output)}
                </span>
              </div>
              {output.execution_mode === 'local_preview' && (
                <p className="compare-notice">
                  未联网调用模型：{previewReasonLabel(output.preview_reason)}
                </p>
              )}
              {output.error_message ? (
                <p className="err">{quickCompareErrorMessage(output, model, props.providers)}</p>
              ) : output.status === 'streaming' ? (
                <pre className="streaming-plain cursor-blink">{output.content || '等待输出…'}</pre>
              ) : (
                renderMarkdown(output.content || '等待输出…')
              )}
              <div className="compare-meta">
                <span>{output.execution_mode === 'local_preview' ? '执行：本地预览' : '执行：真实调用'}</span>
                {output.first_token_ms != null && <span>首字 {output.first_token_ms}ms</span>}
                {output.duration_ms != null && <span>总耗时 {output.duration_ms}ms</span>}
                {output.tool_names.length > 0 && <span>工具 {output.tool_names.length}</span>}
              </div>
              <div className="inline-toolbar">
                {output.status === 'failed' && output.tool_names.length > 0 && toolsEnabled && (
                  <button
                    type="button"
                    className="btn-quiet"
                    onClick={() => {
                      setToolsEnabled(false);
                      void retry(output);
                    }}
                  >
                    关闭工具重试
                  </button>
                )}
                <button
                  type="button"
                  className="btn-quiet"
                  onClick={() => void adopt(output)}
                  disabled={!canAdopt}
                  data-testid={`quick-compare-adopt-${output.participant_index}`}
                >
                  采纳
                </button>
                <button type="button" className="btn-quiet" onClick={() => void retry(output)} data-testid={`quick-compare-retry-${output.participant_index}`}>
                  重试
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function QuickCompareModelPickerDialog(props: {
  models: Model[];
  providers: Provider[];
  selectedIds: string[];
  presetIds: {
    default: string[];
    providers: string[];
    sameName: string[];
  };
  onApply: (ids: string[]) => void;
  onClose: () => void;
}): JSX.Element {
  const [draftIds, setDraftIds] = useState<string[]>(() => props.selectedIds.filter((id) => props.models.some((model) => model.id === id)).slice(0, 3));
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        props.onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [props.onClose]);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const normalizedQuery = query.trim().toLowerCase();
  const visibleModels = useMemo(
    () => props.models.filter((model) => {
      if (!normalizedQuery) return true;
      const haystack = [
        modelLabel(model),
        model.model_name,
        providerLabelFor(model, props.providers),
      ].join(' ').toLowerCase();
      return haystack.includes(normalizedQuery);
    }),
    [normalizedQuery, props.models, props.providers],
  );

  function applyDraft(ids: string[]): void {
    const valid = ids.filter((id) => props.models.some((model) => model.id === id)).slice(0, 3);
    setDraftIds([...new Set(valid)]);
  }

  function toggleModel(modelId: string): void {
    setDraftIds((current) => {
      if (current.includes(modelId)) return current.filter((id) => id !== modelId);
      if (current.length >= 3) return current;
      return [...current, modelId];
    });
  }

  return (
    <div className="modal-backdrop" onMouseDown={props.onClose}>
      <div
        className="modal compare-model-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="quick-compare-model-picker-title"
        onMouseDown={(event) => event.stopPropagation()}
        data-testid="quick-compare-model-dialog"
      >
        <div className="modal-head">
          <div>
            <div className="title" id="quick-compare-model-picker-title">选择对比模型</div>
            <div className="sub">勾选 2-3 个模型；同名模型会显示服务商来源。</div>
          </div>
          <button type="button" className="icon-btn" onClick={props.onClose} title="关闭">
            <Icon name="close" size={15} />
          </button>
        </div>
        <div className="modal-body compare-model-dialog-body">
          <div className="compare-dialog-toolbar">
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder="搜索模型或服务商"
              aria-label="搜索模型或服务商"
              data-testid="quick-compare-model-search"
            />
            <div className="compare-dialog-presets" aria-label="快速组合">
              <button type="button" className="btn-quiet" onClick={() => applyDraft(props.presetIds.default)} data-testid="quick-compare-preset-default">
                默认组合
              </button>
              <button type="button" className="btn-quiet" onClick={() => applyDraft(props.presetIds.providers)} data-testid="quick-compare-preset-providers">
                跨服务商
              </button>
              <button
                type="button"
                className="btn-quiet"
                onClick={() => applyDraft(props.presetIds.sameName)}
                disabled={props.presetIds.sameName.length < 2}
                data-testid="quick-compare-preset-same-name"
              >
                同名模型
              </button>
            </div>
          </div>
          <div className="compare-dialog-count" data-testid="quick-compare-model-count">
            已选 {draftIds.length}/3
          </div>
          <div className="compare-model-list">
            {visibleModels.map((model) => {
              const checked = draftIds.includes(model.id);
              const disabled = !checked && draftIds.length >= 3;
              return (
                <label className={`compare-model-option${checked ? ' active' : ''}`} key={model.id}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={disabled}
                    onChange={() => toggleModel(model.id)}
                  />
                  <span className="compare-model-option-main">
                    <strong>{modelLabel(model)}</strong>
                    <span>{providerLabelFor(model, props.providers)} · {model.model_name}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn-quiet" onClick={props.onClose}>
            取消
          </button>
          <span className="spacer" />
          <button
            type="button"
            className="btn-primary"
            onClick={() => props.onApply(draftIds)}
            disabled={draftIds.length < 2}
            data-testid="quick-compare-apply-models"
          >
            应用选择
          </button>
        </div>
      </div>
    </div>
  );
}

function RoundtablePanel(props: FeatureHubProps & { panelId?: string }): JSX.Element {
  const [topic, setTopic] = useState(props.initialPrompt?.trim() || '这个产品下一步该优先做什么？');
  const [mode, setMode] = useState<'auto' | 'fast' | 'deep'>('auto');
  const [roundtable, setRoundtable] = useState<Roundtable | null>(null);
  const [messages, setMessages] = useState<RoundtableMessage[]>([]);
  const [summaryText, setSummaryText] = useState('');
  const [toolTraces, setToolTraces] = useState<FeatureToolTrace[]>([]);
  const [orchestration, setOrchestration] = useState<FeatureOrchestration | null>(null);
  const [running, setRunning] = useState(false);
  const pendingRoundtableRef = useRef<RoundtableAnnotation[]>([]);
  const roundtableFrameRef = useRef<number | null>(null);
  const streamStopRef = useRef<(() => void) | null>(null);
  const streamTokenRef = useRef(0);

  function applyAnnotations(items: RoundtableAnnotation[]): void {
    let activeRound = roundtable?.current_round ? roundtable.current_round + 1 : 1;
    for (const item of items) {
      if (item.type === 'rt.meta') {
        activeRound = item.round;
        setRoundtable((current) => current ? { ...current, id: item.roundtable_id, conversation_id: item.conversation_id, current_round: item.round } : current);
      } else if (item.type === 'rt.round_start') {
        activeRound = item.round;
      } else if (item.type === 'rt.participant_delta') {
        const round = activeRound;
        setMessages((current) => {
          const found = current.find((message) => message.round === round && message.participant_index === item.participant_index);
          if (!found) {
            return [
              ...current,
              {
                id: `local_rt_${round}_${item.participant_index}`,
                roundtable_id: roundtable?.id ?? 'pending',
                round,
                participant_index: item.participant_index,
                model_id: item.model_id,
                content: item.text_chunk,
                status: 'streaming',
                classification: null,
                error_message: null,
                visible_to_others: true,
                created_at: Date.now(),
                updated_at: Date.now(),
              },
            ];
          }
          return current.map((message) =>
            message.round === round && message.participant_index === item.participant_index
              ? { ...message, content: `${message.content}${item.text_chunk}`, status: 'streaming' }
              : message,
          );
        });
      } else if (item.type === 'rt.participant_done') {
        const round = activeRound;
        setMessages((current) =>
          current.map((message) =>
            message.round === round && message.participant_index === item.participant_index
              ? { ...message, content: item.content, status: 'complete' }
              : message,
          ),
        );
      } else if (item.type === 'rt.participant_failed') {
        const round = activeRound;
        setMessages((current) =>
          current.map((message) =>
            message.round === round && message.participant_index === item.participant_index
              ? { ...message, status: 'failed', classification: item.classification, error_message: item.message }
            : message,
          ),
        );
      } else if (item.type === 'rt.tool_trace') {
        const key = `${item.round}:${item.participant_index}:${item.call_id}:${item.event}`;
        setToolTraces((current) => [
          {
            key,
            target: `第 ${item.round} 轮 · 参与者 ${item.participant_index + 1}`,
            tool: item.tool,
            label: item.label,
            event: item.event,
            ok: item.ok,
            duration_ms: item.duration_ms,
          },
          ...current.filter((trace) => trace.key !== key),
        ].slice(0, 8));
      } else if (item.type === 'rt.orchestration') {
        setOrchestration({ ...item, type: 'rt.orchestration' });
      } else if (item.type === 'rt.summary_delta') {
        setSummaryText((current) => `${current}${item.text_chunk}`);
      } else if (item.type === 'rt.summary_done') {
        setSummaryText(item.summary.recommended_decision);
      }
    }
  }

  function isCurrentStream(token: number): boolean {
    return streamTokenRef.current === token;
  }

  function stopActiveStream(): void {
    streamTokenRef.current += 1;
    streamStopRef.current?.();
    streamStopRef.current = null;
    cancelPendingRoundtable();
  }

  function flushPendingRoundtable(): void {
    if (roundtableFrameRef.current != null) {
      window.cancelAnimationFrame(roundtableFrameRef.current);
      roundtableFrameRef.current = null;
    }
    const items = pendingRoundtableRef.current;
    pendingRoundtableRef.current = [];
    if (items.length > 0) applyAnnotations(items);
  }

  function cancelPendingRoundtable(): void {
    if (roundtableFrameRef.current != null) {
      window.cancelAnimationFrame(roundtableFrameRef.current);
      roundtableFrameRef.current = null;
    }
    pendingRoundtableRef.current = [];
  }

  function applyStreamAnnotations(items: RoundtableAnnotation[]): void {
    const deltas = items.filter((item) => item.type === 'rt.participant_delta' || item.type === 'rt.summary_delta');
    const immediate = items.filter((item) => item.type !== 'rt.participant_delta' && item.type !== 'rt.summary_delta');
    if (immediate.length > 0) {
      flushPendingRoundtable();
      applyAnnotations(immediate);
    }
    if (deltas.length === 0) return;
    pendingRoundtableRef.current = [...pendingRoundtableRef.current, ...deltas];
    if (roundtableFrameRef.current == null) {
      roundtableFrameRef.current = window.requestAnimationFrame(flushPendingRoundtable);
    }
  }

  useEffect(() => () => {
    stopActiveStream();
  }, []);

  async function create(): Promise<void> {
    stopActiveStream();
    setRunning(true);
    try {
      const created = await createRoundtable({
        origin_conversation_id: props.activeConversationId ?? undefined,
        topic,
        mode,
      });
      setRoundtable({
        ...created,
        summary: null,
        updated_at: created.created_at,
        completed_at: null,
      });
      setMessages([]);
      setSummaryText('');
      setToolTraces([]);
      setOrchestration(null);
      props.onToast('圆桌已创建。');
    } catch (error) {
      props.onError(describeError(error));
    } finally {
      setRunning(false);
    }
  }

  async function runRound(): Promise<void> {
    if (!roundtable) return;
    stopActiveStream();
    const streamToken = streamTokenRef.current + 1;
    streamTokenRef.current = streamToken;
    const abortController = new AbortController();
    streamStopRef.current = stopAbortController(abortController);
    setRunning(true);
    try {
      const stop = await streamRoundtableRound(roundtable.id, {
        onAnnotation: (items) => {
          if (isCurrentStream(streamToken)) applyStreamAnnotations(items);
        },
        onDone: () => {
          if (!isCurrentStream(streamToken)) return;
          flushPendingRoundtable();
          streamStopRef.current = null;
          setRunning(false);
          void getRoundtable(roundtable.id).then((detail) => {
            if (!isCurrentStream(streamToken)) return;
            setRoundtable(detail.roundtable);
            setMessages(detail.messages);
          }).catch(() => undefined);
        },
        onError: (error) => {
          if (!isCurrentStream(streamToken)) return;
          cancelPendingRoundtable();
          streamStopRef.current = null;
          setRunning(false);
          props.onError(describeError(error));
        },
      }, { signal: abortController.signal });
      if (isCurrentStream(streamToken)) streamStopRef.current = stop;
      else stop();
    } catch (error) {
      if (!isCurrentStream(streamToken)) return;
      streamStopRef.current = null;
      setRunning(false);
      props.onError(describeError(error));
    }
  }

  async function summarize(): Promise<void> {
    if (!roundtable) return;
    stopActiveStream();
    const streamToken = streamTokenRef.current + 1;
    streamTokenRef.current = streamToken;
    const abortController = new AbortController();
    streamStopRef.current = stopAbortController(abortController);
    setRunning(true);
    try {
      const stop = await streamRoundtableSummarize(roundtable.id, {
        onAnnotation: (items) => {
          if (isCurrentStream(streamToken)) applyStreamAnnotations(items);
        },
        onDone: () => {
          if (!isCurrentStream(streamToken)) return;
          flushPendingRoundtable();
          streamStopRef.current = null;
          setRunning(false);
          props.onToast('圆桌总结已生成。');
        },
        onError: (error) => {
          if (!isCurrentStream(streamToken)) return;
          cancelPendingRoundtable();
          streamStopRef.current = null;
          setRunning(false);
          props.onError(describeError(error));
        },
      }, { signal: abortController.signal });
      if (isCurrentStream(streamToken)) streamStopRef.current = stop;
      else stop();
    } catch (error) {
      if (!isCurrentStream(streamToken)) return;
      streamStopRef.current = null;
      setRunning(false);
      props.onError(describeError(error));
    }
  }

  return (
    <section className="feature-panel" data-testid="roundtable-panel" {...panelProps(props.panelId)}>
      <div className="feature-header">
        <div>
          <h2>多模型圆桌</h2>
          <p>把重要问题拆给多个角色与模型，沉淀共识、分歧、风险和建议。</p>
        </div>
        <button type="button" className="btn-primary" onClick={() => void create()} disabled={running} data-testid="roundtable-create">
          创建圆桌
        </button>
      </div>
      <textarea className="feature-textarea" value={topic} onChange={(event) => setTopic(event.target.value)} data-testid="roundtable-topic" />
      <div className="segmented">
        {(['auto', 'fast', 'deep'] as const).map((item) => (
          <button key={item} type="button" className={mode === item ? 'active' : ''} onClick={() => setMode(item)}>
            {item}
          </button>
        ))}
      </div>
      {roundtable && (
        <div className="feature-card" data-testid="roundtable-detail">
          <div className="feature-row">
            <strong>{roundtable.topic}</strong>
            <span className={`status-chip ${roundtable.status}`}>{roundtable.status}</span>
          </div>
          <div className="participant-list">
            {roundtable.participants.map((participant, index) => (
              <span key={`${participant.model_id}-${index}`} className="tag">{participant.role_label} · {participant.display_name}</span>
            ))}
          </div>
          <div className="inline-toolbar">
            <button type="button" className="btn-quiet" onClick={() => void runRound()} disabled={running} data-testid="roundtable-run-round">启动下一轮</button>
            <button type="button" className="btn-quiet" onClick={() => void summarize()} disabled={running} data-testid="roundtable-summarize">生成总结</button>
            <button
              type="button"
              className="btn-quiet"
              onClick={() => {
                void loopbackRoundtable(roundtable.id).then((result) => {
                  props.onToast('圆桌结论已回填。');
                  props.onOpenConversation(result.conversation_id);
                }).catch((error) => props.onError(describeError(error)));
              }}
              data-testid="roundtable-loopback"
            >
              回填到对话
            </button>
            <button
              type="button"
              className="btn-quiet"
              onClick={() => void exportRoundtable(roundtable.id).then(() => props.onToast('圆桌已导出。')).catch((error) => props.onError(describeError(error)))}
              data-testid="roundtable-export"
            >
              导出
            </button>
          </div>
        </div>
      )}
      {messages.length > 0 && (
        <div className="round-grid">
          {messages.map((message) => (
            <article className="feature-card" key={message.id} data-testid={`roundtable-message-${message.participant_index}`}>
              <div className="feature-row">
                <strong>参与者 {message.participant_index + 1}</strong>
                <span className={`status-chip ${message.status}`}>{message.status}</span>
              </div>
              {message.error_message ? (
                <p className="err">{message.error_message}</p>
              ) : message.status === 'streaming' ? (
                <pre className="streaming-plain cursor-blink">{message.content || '等待输出…'}</pre>
              ) : (
                renderMarkdown(message.content)
              )}
            </article>
          ))}
        </div>
      )}
      {orchestration && <OrchestrationNotice plan={orchestration} />}
      {toolTraces.length > 0 && (
        <div className="feature-card" data-testid="roundtable-tool-traces">
          <h3>工具调用</h3>
          <ToolTraceList traces={toolTraces} />
        </div>
      )}
      {summaryText && (
        <div className="feature-card" data-testid="roundtable-summary">
          {running ? <pre className="streaming-plain cursor-blink">{summaryText}</pre> : renderMarkdown(summaryText)}
        </div>
      )}
    </section>
  );
}

function ResearchPanel(props: FeatureHubProps & { panelId?: string }): JSX.Element {
  const [title, setTitle] = useState('AI 助手市场趋势');
  const [objective, setObjective] = useState(props.initialPrompt?.trim() || '研究桌面 AI 助手在 2026 年的机会、风险和代表产品。');
  const [sessions, setSessions] = useState<ResearchSession[]>([]);
  const [detail, setDetail] = useState<ResearchDetail | null>(null);
  const [feedback, setFeedback] = useState('聚焦个人开发者和 BYOK 用户。');

  async function refreshList(): Promise<void> {
    try {
      setSessions(await listResearchSessions());
    } catch (error) {
      props.onError(describeError(error));
    }
  }

  async function create(): Promise<void> {
    try {
      const session = await createResearchSession({
        conversation_id: props.activeConversationId,
        title,
        objective,
        output_kind: 'report',
        budget_mode: 'balanced',
      });
      const next = await getResearchSession(session.id).catch(() => ({ session, tasks: [], sources: [], claims: [] }));
      setDetail(next);
      await refreshList();
      props.onToast('研究任务已创建。');
    } catch (error) {
      props.onError(describeError(error));
    }
  }

  async function load(id: string): Promise<void> {
    try {
      setDetail(await getResearchSession(id));
    } catch (error) {
      props.onError(describeError(error));
    }
  }

  return (
    <section className="feature-panel" data-testid="research-panel" {...panelProps(props.panelId)}>
      <div className="feature-header">
        <div>
          <h2>深度研究</h2>
          <p>从范围澄清、计划预览、执行进度到报告导出，保留研究过程可见性。</p>
        </div>
        <div className="inline-toolbar">
          <button type="button" className="btn-quiet" onClick={() => void refreshList()} data-testid="research-refresh">刷新</button>
          <button type="button" className="btn-primary" onClick={() => void create()} data-testid="research-create">创建研究</button>
        </div>
      </div>
      <div className="form-grid two">
        <input value={title} onChange={(event) => setTitle(event.target.value)} data-testid="research-title" />
        <textarea value={objective} onChange={(event) => setObjective(event.target.value)} data-testid="research-objective" />
      </div>
      {sessions.length > 0 && (
        <div className="feature-list">
          {sessions.map((session) => (
            <button key={session.id} type="button" onClick={() => void load(session.id)}>
              {session.title}
              <span>{session.status} · {session.stage}</span>
            </button>
          ))}
        </div>
      )}
      {detail && (
        <div className="feature-card" data-testid="research-detail">
          <div className="feature-row">
            <strong>{detail.session.title}</strong>
            <span className={`status-chip ${detail.session.status}`}>{detail.session.status} · {detail.session.stage}</span>
          </div>
          <p>{detail.session.objective}</p>
          {detail.session.plan && <ResearchPlanView plan={detail.session.plan} />}
          {detail.session.plan_messages?.map((message, index) => (
            <p key={`${message.ts}-${index}`} className="muted">{message.role}：{message.content}</p>
          ))}
          <div className="inline-toolbar">
            <input value={feedback} onChange={(event) => setFeedback(event.target.value)} data-testid="research-feedback" />
            <button type="button" className="btn-quiet" onClick={() => void reviseResearchPlan(detail.session.id, feedback).then(setDetail).catch((error) => props.onError(describeError(error)))} data-testid="research-revise">修订计划</button>
            <button type="button" className="btn-quiet" onClick={() => void startResearchSession(detail.session.id).then(setDetail).catch((error) => props.onError(describeError(error)))} data-testid="research-start">启动</button>
            <button type="button" className="btn-quiet" onClick={() => void pauseResearchSession(detail.session.id).then(setDetail).catch((error) => props.onError(describeError(error)))} data-testid="research-pause">暂停</button>
            <button type="button" className="btn-quiet" onClick={() => void resumeResearchSession(detail.session.id).then(setDetail).catch((error) => props.onError(describeError(error)))} data-testid="research-resume">恢复</button>
            <button type="button" className="btn-quiet" onClick={() => void cancelResearchSession(detail.session.id).then(setDetail).catch((error) => props.onError(describeError(error)))} data-testid="research-cancel">取消</button>
            <button type="button" className="btn-quiet" onClick={() => void exportResearchSession(detail.session.id).then(() => props.onToast('研究已导出。')).catch((error) => props.onError(describeError(error)))} data-testid="research-export">导出</button>
          </div>
          <div className="research-metrics">
            <span>{detail.tasks.length} 个任务</span>
            <span>{detail.sources.length} 个来源</span>
            <span>{detail.claims.length} 条论断</span>
            <span>{formatUsd(detail.session.budget_spent_usd)}</span>
          </div>
          {detail.session.draft_markdown && <div className="research-draft">{renderMarkdown(detail.session.draft_markdown)}</div>}
        </div>
      )}
    </section>
  );
}

function ResearchPlanView({ plan }: { plan: ResearchPlan }): JSX.Element {
  return (
    <div className="research-plan" data-testid="research-plan">
      <strong>{plan.summary}</strong>
      <div className="feature-checks">
        {plan.key_questions.map((question) => <span key={question.id} className="tag">{question.question}</span>)}
      </div>
      <div className="feature-checks">
        {plan.stages.map((stage) => <span key={stage.id} className="tag alt">{stage.title}</span>)}
      </div>
    </div>
  );
}

function FilesPanel(props: FeatureHubProps & { panelId?: string }): JSX.Element {
  const [query, setQuery] = useState('hawthorn');
  const [fileId, setFileId] = useState('');
  const [results, setResults] = useState<FileSearchResult[]>([]);
  const [fileData, setFileData] = useState<string | null>(null);

  async function search(): Promise<void> {
    try {
      const next = await searchFiles({
        query,
        conversation_id: props.activeConversationId ?? undefined,
        file_ids: fileId.trim() ? [fileId.trim()] : undefined,
        limit: 8,
        include_content: true,
      });
      setResults(next);
      props.onToast('文件搜索完成。');
    } catch (error) {
      props.onError(describeError(error));
    }
  }

  return (
    <section className="feature-panel" data-testid="files-panel" {...panelProps(props.panelId)}>
      <div className="feature-header">
        <div>
          <h2>文件与本地上下文</h2>
          <p>搜索会话附件或指定文件 chunk，确认回答使用了哪些本地上下文。</p>
        </div>
        <button type="button" className="btn-primary" onClick={() => void search()} data-testid="file-search-run">搜索</button>
      </div>
      <div className="form-grid two">
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索词" data-testid="file-search-query" />
        <input value={fileId} onChange={(event) => setFileId(event.target.value)} placeholder="可选 file_id" data-testid="file-data-id" />
      </div>
      <div className="feature-list">
        {results.map((result) => (
          <button key={result.chunk_id} type="button" onClick={() => setFileId(result.file_id)} data-testid="file-search-result">
            {result.file_name ?? result.file_id}
            <span>{result.snippet}</span>
          </button>
        ))}
      </div>
      <div className="inline-toolbar">
        <button
          type="button"
          className="btn-quiet"
          onClick={() => {
            if (!fileId.trim()) return;
            void getFileData(fileId.trim()).then((result) => {
              setFileData(`${result.content_type} · ${result.size_bytes} bytes · ${result.data_b64.slice(0, 32)}`);
            }).catch((error) => props.onError(describeError(error)));
          }}
          data-testid="file-data-load"
        >
          读取文件数据
        </button>
      </div>
      {fileData && <div className="feature-card" data-testid="file-data-preview">{fileData}</div>}
    </section>
  );
}

function ToolsPanel(props: FeatureHubProps & { panelId?: string }): JSX.Element {
  const [tools, setTools] = useState<Tool[]>([]);
  const [effectiveTools, setEffectiveTools] = useState<EffectiveTool[]>([]);
  const [health, setHealth] = useState<ToolHealthRow[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [mcpName, setMcpName] = useState('Local notes MCP');
  const [mcpCommand, setMcpCommand] = useState('node');
  const [invokeInput, setInvokeInput] = useState('{"prompt":"blue poster"}');
  const [invokeResult, setInvokeResult] = useState('');
  const [debugOpen, setDebugOpen] = useState(false);

  async function refresh(): Promise<void> {
    setLoading(true);
    try {
      const [toolRows, effectiveRows, healthRows, servers] = await Promise.all([
        listTools(),
        listEffectiveTools(props.activeConversationId),
        listToolHealth(),
        listMcpServers(),
      ]);
      setTools(toolRows);
      setEffectiveTools(effectiveRows);
      setHealth(healthRows);
      setMcpServers(servers);
      setLoaded(true);
    } catch (error) {
      props.onError(describeError(error));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, [props.activeConversationId]);

  async function addMcp(): Promise<void> {
    try {
      const server = await createMcpServer({ name: mcpName, command: mcpCommand, args: [], enabled: true });
      setMcpServers((current) => [...current, server]);
      props.onToast('MCP Server 已添加。');
    } catch (error) {
      props.onError(describeError(error));
    }
  }

  const healthByTool = new Map(health.map((row) => [row.tool_name, row]));
  const displayTools = effectiveTools.length > 0 ? effectiveTools : tools;
  const enabledCount = displayTools.filter((tool) => ('effective_enabled' in tool ? tool.effective_enabled : tool.enabled)).length;
  const mcpToolCount = mcpServers.reduce((sum, server) => sum + server.tools_count, 0);
  const groupedTools = displayTools.reduce(
    (groups, tool) => {
      const category = toolCategory(tool.name, tool.capability);
      groups[category].push(tool);
      return groups;
    },
    { search: [], file: [], media: [], other: [] } as Record<'search' | 'file' | 'media' | 'other', Array<Tool | EffectiveTool>>,
  );

  return (
    <section className="feature-panel" data-testid="tools-panel" {...panelProps(props.panelId)}>
      <div className="feature-header">
        <div>
          <h2>工具管理</h2>
          <p>决定 AI 可以使用哪些能力：搜索网页、读取文件、调用本地 MCP。支持工具调用的模型才会实际使用这些工具。</p>
        </div>
        <button type="button" className="btn-primary" onClick={() => void refresh()} disabled={loading} data-testid="tools-refresh">
          {loading ? '正在加载' : '刷新工具'}
        </button>
      </div>

      <div className="tool-overview">
        <div>
          <span className="summary-label">全局可用</span>
          <strong>{loading && displayTools.length === 0 ? '加载中' : `${enabledCount}/${displayTools.length}`}</strong>
        </div>
        <div>
          <span className="summary-label">当前会话</span>
          <strong>{props.activeConversationId ? '可单独覆盖' : '未进入会话'}</strong>
        </div>
        <div>
          <span className="summary-label">MCP</span>
          <strong>{mcpServers.length} 个 Server · {mcpToolCount} 个工具</strong>
        </div>
      </div>

      <div className="tool-scope-note">
        <Icon name="bolt" size={14} />
        <span>全局开关影响之后的任务；会话覆盖只影响当前对话。Quick Compare 和圆桌也会遵守这里的工具状态。</span>
      </div>

      {loaded && displayTools.length === 0 && (
        <div className="feature-card tool-empty" data-testid="tools-empty">
          <strong>未发现可用工具</strong>
          <p>当前后端没有返回内置工具或 MCP 工具。你可以先刷新，或在下方添加 MCP Server 后重新加载。</p>
        </div>
      )}

      {(['search', 'file', 'media', 'other'] as const).map((category) => {
        const items = groupedTools[category];
        if (items.length === 0) return null;
        return (
          <section className="tool-section" key={category}>
            <div className="tool-section-head">
              <h3>{toolCategoryLabel(category)}</h3>
              <span>{items.length} 个能力</span>
            </div>
            <div className="tool-grid">
              {items.map((tool) => {
                const effective = 'effective_enabled' in tool ? tool.effective_enabled : tool.enabled;
                const row = healthByTool.get(tool.name);
                const hasSessionOverride = 'session_enabled' in tool && tool.session_enabled != null;
                return (
                  <article className="tool-card" key={tool.name} data-testid={`tool-row-${tool.name}`}>
                    <div className="tool-card-head">
                      <div>
                        <strong>{toolFriendlyName(tool.name)}</strong>
                        <code>{tool.name}</code>
                      </div>
                      <span className={`status-chip ${effective ? 'complete' : 'failed'}`}>
                        {toolStatusLabel(effective)}
                        <span className="sr-only">{effective ? ' enabled' : ' disabled'}</span>
                      </span>
                    </div>
                    <p>{tool.description}</p>
                    <div className="tool-meta-row">
                      <span>{tool.source === 'builtin' ? '内置工具' : tool.source}</span>
                      <span>{tool.capability}</span>
                      {row ? (
                        <span>{row.calls_24h} 次调用 · {row.failures_24h} 次失败</span>
                      ) : (
                        <span>暂无健康记录</span>
                      )}
                      {hasSessionOverride && <span className="tool-override">本会话已覆盖</span>}
                    </div>
                    <div className="tool-actions">
                      <button type="button" className="btn-quiet" onClick={() => void setToolEnabled(tool.name, !tool.enabled).then(() => refresh())}>
                        {tool.enabled ? '全局关闭' : '全局开启'}
                      </button>
                      {props.activeConversationId && (
                        <button
                          type="button"
                          className="btn-quiet"
                          onClick={() => void setSessionToolEnabled(tool.name, props.activeConversationId!, effective ? false : true).then(() => refresh())}
                          data-testid={`tool-session-toggle-${tool.name}`}
                        >
                          {effective ? '本会话关闭' : '本会话开启'}
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn-quiet debug-action"
                        onClick={() => {
                          setDebugOpen(true);
                          let parsed: unknown = {};
                          try {
                            parsed = JSON.parse(invokeInput);
                          } catch {
                            parsed = { text: invokeInput };
                          }
                          void invokeTool({ name: tool.name, input: parsed, conversation_id: props.activeConversationId }).then((result) => {
                            setInvokeResult(JSON.stringify(result, null, 2));
                          }).catch((error) => props.onError(describeError(error)));
                        }}
                        data-testid={`tool-invoke-${tool.name}`}
                      >
                        调试调用
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        );
      })}

      <div className="mcp-panel feature-card">
        <div className="mcp-panel-head">
          <div>
            <h3>高级 MCP</h3>
            <p>接入本机 MCP Server，让支持工具调用的模型使用你的本地服务。</p>
          </div>
          <span className="status-chip preview">高级</span>
        </div>
        <div className="mcp-presets" aria-label="MCP 预设">
          <button type="button" className="preset-pill soft" onClick={() => setMcpName('Local files MCP')}>本地文件</button>
          <button type="button" className="preset-pill soft" onClick={() => setMcpName('GitHub MCP')}>GitHub</button>
          <button type="button" className="preset-pill soft" onClick={() => setMcpName('Notion MCP')}>Notion</button>
          <button type="button" className="preset-pill soft" onClick={() => setMcpName('Custom MCP')}>自定义</button>
        </div>
        <div className="form-grid two">
          <label>
            <span>MCP 名称</span>
            <input value={mcpName} onChange={(event) => setMcpName(event.target.value)} data-testid="mcp-name" />
          </label>
          <label>
            <span>启动命令</span>
            <input value={mcpCommand} onChange={(event) => setMcpCommand(event.target.value)} data-testid="mcp-command" />
          </label>
        </div>
        <div className="inline-toolbar">
          <button type="button" className="btn-quiet" onClick={() => void addMcp()} data-testid="mcp-create">添加 MCP</button>
        </div>
        <div className="feature-list">
          {mcpServers.map((server) => (
            <div key={server.id} className="feature-list-row" data-testid={`mcp-server-${server.id}`}>
              <strong>{server.name}</strong>
              <span>{server.health_status} · {server.tools_count} 个工具</span>
              <span className="inline-toolbar">
                <button type="button" className="btn-quiet" onClick={() => void refreshMcpServer(server.id).then(() => refresh())} data-testid={`mcp-refresh-${server.id}`}>刷新</button>
                <button type="button" className="btn-quiet" onClick={() => void restartMcpServer(server.id).then(() => refresh())} data-testid={`mcp-restart-${server.id}`}>重启</button>
                <button type="button" className="btn-quiet" onClick={() => void getMcpRuntime(server.id).then((runtime) => setInvokeResult(JSON.stringify(runtime, null, 2)))} data-testid={`mcp-runtime-${server.id}`}>运行时</button>
                <button type="button" className="btn-quiet" onClick={() => void deleteMcpServer(server.id).then(() => refresh())} data-testid={`mcp-delete-${server.id}`}>删除</button>
              </span>
            </div>
          ))}
        </div>
      </div>

      <details className="tool-debug" open={debugOpen} onToggle={(event) => setDebugOpen(event.currentTarget.open)}>
        <summary>调试工具调用</summary>
        <p>这里用于开发和排查工具输入输出；日常使用时，模型会在对话、对比或圆桌中自动调用工具。</p>
        <textarea className="feature-textarea small" value={invokeInput} onChange={(event) => setInvokeInput(event.target.value)} data-testid="tool-invoke-input" />
        {invokeResult && <pre className="feature-pre" data-testid="tool-invoke-result">{invokeResult}</pre>}
      </details>
    </section>
  );
}
