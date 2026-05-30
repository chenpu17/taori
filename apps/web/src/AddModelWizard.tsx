import { useEffect, useMemo, useRef, useState } from 'react';
import type { DiscoveredModel, Model, Provider, ProviderType } from '@taori/shared';
import { Icon } from './Icon';
import {
  createModel,
  createProvider,
  discoverProvider,
  type DiscoveryResponse,
} from './api';

/**
 * AddModelWizard —— 把"添加一个模型"压成一条用户路径：
 *   Step 1 «选服务商»：使用已有 Provider，或从预设清单 / 自定义一键新建
 *   Step 2 «连接»：仅在新建 Provider 时出现，填 Key（或本地无需 Key）+ 测试连接
 *   Step 3 «挑模型»：自动 discover；列表里没有时始终可手动填 model_name
 *
 * 设计动机（修复 5 个心智断裂）：
 *   - 用户脑子里只有"我想加个模型"，不该被迫先理解 "Provider" 的存在
 *   - 任何添加路径都聚成一个 + 按钮，再不出现"手动 / 发现 / 卡上按钮"三入口
 *   - 预设清单（OpenRouter / DeepSeek / 火山方舟 / 通义百炼 / 月之暗面 Kimi / 华为云 / 本地 Ollama / 本地 LM Studio）
 *     带 icon + 一句话推介，新人 30 秒接入
 */

export interface PresetProvider {
  /** Stable key used by the wizard's internal state. */
  key: string;
  /** Sidecar ProviderType — for built-ins use the dedicated enum; for OpenAI-compatible 国内云走 custom + base_url。 */
  type: ProviderType;
  /** Display name written to DB as Provider.name */
  name: string;
  /** Default base URL for this preset's OpenAI-compatible endpoint */
  baseUrl: string;
  /** Single Chinese sentence explaining what this is good for */
  tagline: string;
  /** Whether this preset needs an API Key (false for local ollama / lmstudio) */
  needsKey: boolean;
  /** Single-line tip about where to grab the API key */
  keyHint?: string;
  /** Two-letter visual tag for the chip in the empty state */
  glyph: string;
  /** Subtle background tint for the preset card */
  tint: string;
}

export const PRESET_PROVIDERS: PresetProvider[] = [
  {
    key: 'openrouter',
    type: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    tagline: '一个 Key 聚合上百个模型，最适合新手入门和多模型对比。',
    needsKey: true,
    keyHint: 'openrouter.ai/keys',
    glyph: 'OR',
    tint: '#C26A4A',
  },
  {
    key: 'deepseek',
    type: 'deepseek',
    name: 'DeepSeek 官方',
    baseUrl: 'https://api.deepseek.com/v1',
    tagline: '官方直连，性价比标杆，DeepSeek-V3 / R1 推理首选。',
    needsKey: true,
    keyHint: 'platform.deepseek.com',
    glyph: 'DS',
    tint: '#5A7BA8',
  },
  {
    key: 'volcengine_ark',
    type: 'volcengine_ark',
    name: '火山方舟（豆包）',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    tagline: '字节跳动豆包系列：Doubao chat / vision / Seed image / Wan video 一键开通。',
    needsKey: true,
    keyHint: 'console.volcengine.com/ark',
    glyph: '豆',
    tint: '#C25E3A',
  },
  {
    key: 'tongyi',
    type: 'custom',
    name: '通义百炼（DashScope）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    tagline: '阿里通义千问全家族（Qwen2.5 / QwQ / VL）OpenAI 兼容端口，国内速度最优。',
    needsKey: true,
    keyHint: 'dashscope.console.aliyun.com',
    glyph: '通',
    tint: '#7A8E6E',
  },
  {
    key: 'moonshot',
    type: 'custom',
    name: '月之暗面（Kimi）',
    baseUrl: 'https://api.moonshot.cn/v1',
    tagline: 'Moonshot Kimi 长文本之王，最长 200K 上下文。',
    needsKey: true,
    keyHint: 'platform.moonshot.cn',
    glyph: 'K',
    tint: '#6E6259',
  },
  {
    key: 'huawei_maas',
    type: 'huawei_maas',
    name: '华为云 ModelArts',
    baseUrl: 'https://maas-cn-southwest-2.modelarts-maas.com/v1',
    tagline: '华为云 MaaS：盘古系列 + 主流开源模型托管，企业合规友好。',
    needsKey: true,
    keyHint: 'console.huaweicloud.com/modelarts',
    glyph: '盘',
    tint: '#8B6BAE',
  },
  {
    key: 'ollama',
    type: 'ollama',
    name: '本地 Ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    tagline: '完全本地推理：零成本、零隐私顾虑。需要先在本机跑 `ollama serve`。',
    needsKey: false,
    glyph: '本',
    tint: '#C58B3A',
  },
  {
    key: 'lmstudio',
    type: 'custom',
    name: '本地 LM Studio',
    baseUrl: 'http://127.0.0.1:1234/v1',
    tagline: 'LM Studio 桌面端的 OpenAI 兼容服务，桌面 GGUF 推理首选。',
    needsKey: false,
    glyph: 'LM',
    tint: '#5A7BA8',
  },
];

interface AddModelWizardProps {
  providers: Provider[];
  existingModels: Model[];
  onClose: () => void;
  onDone: (createdModelIds: string[]) => Promise<void>;
  onToast: (message: string) => void;
  onError: (message: string) => void;
  /** Optional: pre-select an existing provider (e.g. wizard entered from a Provider card). */
  initialProviderId?: string | null;
}

type Step = 'pick-provider' | 'connect' | 'pick-models';
type Mode = 'use-existing' | 'preset' | 'custom';

interface ProviderDraft {
  mode: Mode;
  existingProviderId: string | null;
  preset: PresetProvider | null;
  customName: string;
  customBaseUrl: string;
  customType: ProviderType;
  apiKey: string;
}

const EMPTY_DRAFT: ProviderDraft = {
  mode: 'preset',
  existingProviderId: null,
  preset: null,
  customName: '',
  customBaseUrl: '',
  customType: 'custom',
  apiKey: '',
};

function pricePerMillion(value: number | null | undefined): string {
  if (value == null) return '—';
  if (value === 0) return '免费';
  if (value < 0.01) return '< $0.01';
  return `$${value.toFixed(2)}`;
}

function formatContext(context: number | null | undefined): string {
  if (!context) return '';
  if (context >= 1_000_000) return `${(context / 1_000_000).toFixed(1)}M`;
  if (context >= 1_000) return `${Math.round(context / 1000)}K`;
  return String(context);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function AddModelWizard(props: AddModelWizardProps): JSX.Element {
  const initial = useMemo<ProviderDraft>(() => {
    if (props.initialProviderId) {
      return { ...EMPTY_DRAFT, mode: 'use-existing', existingProviderId: props.initialProviderId };
    }
    return EMPTY_DRAFT;
  }, [props.initialProviderId]);

  const [step, setStep] = useState<Step>(props.initialProviderId ? 'pick-models' : 'pick-provider');
  const [draft, setDraft] = useState<ProviderDraft>(initial);
  const [workingProviderId, setWorkingProviderId] = useState<string | null>(props.initialProviderId ?? null);
  const [busy, setBusy] = useState(false);

  // ── pick-models state ────────────────────────────────────────────────────
  const [discovery, setDiscovery] = useState<DiscoveryResponse | null>(null);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [discoveryFilter, setDiscoveryFilter] = useState('');
  const [selectedNames, setSelectedNames] = useState<Set<string>>(new Set());
  const [manualForm, setManualForm] = useState({ model_name: '', display_name: '' });
  const didMountDiscoveryFilter = useRef(false);

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

  function reset(): void {
    setStep(props.initialProviderId ? 'pick-models' : 'pick-provider');
    setDraft(initial);
    setWorkingProviderId(props.initialProviderId ?? null);
    setDiscovery(null);
    setDiscoveryError(null);
    setDiscoveryFilter('');
    setSelectedNames(new Set());
    setManualForm({ model_name: '', display_name: '' });
  }

  async function commitProviderAndProceed(): Promise<void> {
    if (draft.mode === 'use-existing') {
      if (!draft.existingProviderId) {
        props.onError('请选择一个已配置的服务商。');
        return;
      }
      setWorkingProviderId(draft.existingProviderId);
      await beginDiscovery(draft.existingProviderId);
      return;
    }

    const spec =
      draft.mode === 'preset' && draft.preset
        ? {
            name: draft.preset.name,
            type: draft.preset.type,
            base_url: draft.preset.baseUrl,
            api_key: draft.preset.needsKey ? draft.apiKey.trim() || undefined : undefined,
            needsKey: draft.preset.needsKey,
          }
        : {
            name: draft.customName.trim(),
            type: draft.customType,
            base_url: draft.customBaseUrl.trim(),
            api_key: draft.apiKey.trim() || undefined,
            needsKey: true,
          };

    if (!spec.name || !spec.base_url) {
      props.onError('请填写服务商名称和 Base URL。');
      return;
    }
    if (spec.needsKey && !spec.api_key) {
      props.onError('请填写 API Key（Key 仅写入本机 Keystore，不留在前端）。');
      return;
    }
    setBusy(true);
    try {
      const created = await createProvider({
        name: spec.name,
        type: spec.type,
        base_url: spec.base_url,
        api_key: spec.api_key,
      });
      setWorkingProviderId(created.id);
      props.onToast(`已接入 ${spec.name}。`);
      await beginDiscovery(created.id);
    } catch (error) {
      props.onError(describeError(error));
    } finally {
      setBusy(false);
    }
  }

  async function beginDiscovery(providerId: string): Promise<void> {
    setStep('pick-models');
    setBusy(true);
    setDiscoveryError(null);
    try {
      const response = await discoverProvider(providerId);
      setDiscovery(response);
      // Pre-select the recommended chat model if any (and not yet added)
      const existing = new Set(
        props.existingModels.filter((m) => m.provider_id === providerId).map((m) => m.model_name),
      );
      const next = new Set<string>();
      if (response.recommended.chat && !existing.has(response.recommended.chat)) {
        next.add(response.recommended.chat);
      }
      setSelectedNames(next);
    } catch (error) {
      setDiscovery(null);
      setDiscoveryError(describeError(error));
    } finally {
      setBusy(false);
    }
  }

  async function finishModels(): Promise<void> {
    if (!workingProviderId) return;
    const selected = discovery?.models.filter((m) => selectedNames.has(m.model_name)) ?? [];
    const manualName = manualForm.model_name.trim();
    const manualDisplayName = manualForm.display_name.trim() || manualName;

    if (selected.length === 0 && !manualName) {
      props.onError('请勾选一个模型，或手动填写 model_name。');
      return;
    }
    if (manualName && existingForWorking.has(manualName)) {
      props.onError('这个模型已经添加过了。');
      return;
    }
    if (manualName && selectedNames.has(manualName)) {
      props.onError('手动填写的模型已经在上方勾选了。');
      return;
    }

    setBusy(true);
    const createdIds: string[] = [];
    const failures: string[] = [];
    try {
      for (const item of selected) {
        try {
          const created = await createModel({
            provider_id: workingProviderId,
            model_name: item.model_name,
            display_name: item.display_name,
            capability: item.capability,
            price_input_per_1m: item.price_input_per_1m,
            price_output_per_1m: item.price_output_per_1m,
            context_length: item.context_length,
            supports_vision: item.supports_vision,
            supports_tools: item.supports_tools,
            modalities: item.modalities,
          });
          createdIds.push(created.id);
        } catch (error) {
          failures.push(`${item.display_name}: ${describeError(error)}`);
        }
      }

      if (manualName) {
        try {
          const created = await createModel({
            provider_id: workingProviderId,
            model_name: manualName,
            display_name: manualDisplayName,
            capability: 'chat',
          });
          createdIds.push(created.id);
        } catch (error) {
          failures.push(`${manualDisplayName}: ${describeError(error)}`);
        }
      }

      if (failures.length === 0) {
        props.onToast(`已添加 ${createdIds.length} 个模型。`);
      } else {
        const total = selected.length + (manualName ? 1 : 0);
        props.onError(`${createdIds.length}/${total} 已添加，部分失败：${failures.join('; ')}`);
      }
      await props.onDone(createdIds);
      props.onClose();
    } finally {
      setBusy(false);
    }
  }

  // ── render ────────────────────────────────────────────────────────────────
  const filteredDiscovery = useMemo(() => {
    if (!discovery) return [];
    const q = discoveryFilter.trim().toLowerCase();
    if (!q) return discovery.models;
    return discovery.models.filter(
      (m) =>
        m.model_name.toLowerCase().includes(q) || m.display_name.toLowerCase().includes(q),
    );
  }, [discovery, discoveryFilter]);

  useEffect(() => {
    if (!didMountDiscoveryFilter.current) {
      didMountDiscoveryFilter.current = true;
      return;
    }
    setSelectedNames(new Set());
  }, [discoveryFilter]);

  const existingForWorking = useMemo(() => {
    if (!workingProviderId) return new Set<string>();
    return new Set(
      props.existingModels.filter((m) => m.provider_id === workingProviderId).map((m) => m.model_name),
    );
  }, [props.existingModels, workingProviderId]);

  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal wizard" onClick={(e) => e.stopPropagation()} data-testid="add-model-wizard">
        <div className="modal-head">
          <div className="title">添加模型</div>
          <span className="sub">
            <span className={step === 'pick-provider' ? 'wstep active' : 'wstep'}>1·选服务商</span>
            <span className={step === 'connect' ? 'wstep active' : 'wstep'}>2·连接</span>
            <span className={step === 'pick-models' ? 'wstep active' : 'wstep'}>3·挑模型</span>
          </span>
          <button type="button" className="icon-btn" onClick={props.onClose} title="关闭">
            <Icon name="close" size={15} />
          </button>
        </div>

        <div className="modal-body wizard-body">
          {step === 'pick-provider' && (
            <PickProviderStep
              providers={props.providers}
              draft={draft}
              setDraft={setDraft}
            />
          )}

          {step === 'connect' && (
            <ConnectStep draft={draft} setDraft={setDraft} />
          )}

          {step === 'pick-models' && (
            <PickModelsStep
              discovery={discovery}
              discoveryError={discoveryError}
              filter={discoveryFilter}
              setFilter={setDiscoveryFilter}
              filtered={filteredDiscovery}
              existing={existingForWorking}
              selectedNames={selectedNames}
              toggle={(name) => {
                setSelectedNames((current) => {
                  const next = new Set(current);
                  if (next.has(name)) next.delete(name);
                  else next.add(name);
                  return next;
                });
              }}
              selectAll={() => {
                const next = new Set<string>();
                for (const m of filteredDiscovery) {
                  if (!existingForWorking.has(m.model_name)) next.add(m.model_name);
                }
                setSelectedNames(next);
              }}
              clearAll={() => setSelectedNames(new Set())}
              manualForm={manualForm}
              setManualForm={setManualForm}
              busy={busy}
            />
          )}
        </div>

        <div className="modal-foot">
          <span className="muted">{footMessage(step, draft, discovery, selectedNames.size)}</span>
          <span className="spacer" />
          {step !== 'pick-provider' && (
            <button
              type="button"
              className="btn-quiet"
              onClick={() => {
                reset();
              }}
              data-testid="wizard-restart"
            >
              重新开始
            </button>
          )}
          <button type="button" className="btn-quiet" onClick={props.onClose} data-testid="wizard-cancel">
            取消
          </button>
          {step === 'pick-provider' && (
            <button
              type="button"
              className="btn-primary"
              disabled={busy || !canAdvanceFromPickProvider(draft)}
              onClick={() => {
                if (draft.mode === 'use-existing') {
                  void commitProviderAndProceed();
                } else {
                  setStep('connect');
                }
              }}
              data-testid="wizard-next"
            >
              下一步 →
            </button>
          )}
          {step === 'connect' && (
            <>
              <button
                type="button"
                className="btn-quiet"
                onClick={() => setStep('pick-provider')}
                data-testid="wizard-back"
              >
                ← 上一步
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={busy}
                onClick={() => void commitProviderAndProceed()}
                data-testid="wizard-connect"
              >
                {busy ? '连接中…' : '连接并发现模型 →'}
              </button>
            </>
          )}
          {step === 'pick-models' && (
            <>
              <button
                type="button"
                className="btn-primary"
                disabled={busy || (selectedNames.size === 0 && !manualForm.model_name.trim())}
                onClick={() => {
                  void finishModels();
                }}
                data-testid="wizard-finish"
              >
                {busy ? '添加中…' : finishButtonLabel(selectedNames.size, manualForm.model_name)}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function canAdvanceFromPickProvider(draft: ProviderDraft): boolean {
  if (draft.mode === 'use-existing') return Boolean(draft.existingProviderId);
  if (draft.mode === 'preset') return Boolean(draft.preset);
  if (draft.mode === 'custom') return true;
  return false;
}

function footMessage(
  step: Step,
  draft: ProviderDraft,
  discovery: DiscoveryResponse | null,
  selectedCount: number,
): string {
  if (step === 'pick-provider') {
    if (draft.mode === 'use-existing') return '直接使用已配置的服务商，跳过填 Key。';
    if (draft.mode === 'preset' && draft.preset) return `下一步将填写 ${draft.preset.name} 的 API Key。`;
    return '从预设清单中选一家最常用的，或在最后选「自定义」填任意 OpenAI 兼容端口。';
  }
  if (step === 'connect') return 'API Key 仅写入本机 Keystore，不留在前端，也不会写日志。';
  if (step === 'pick-models') {
    if (discovery) return `已选 ${selectedCount} / 可见 ${discovery.models.length}。被勾选的会一次性写入本地数据库。`;
    return '也可以直接填一个列表里没有的具体 model_name。';
  }
  return '';
}

function finishButtonLabel(selectedCount: number, manualName: string): string {
  const hasManual = manualName.trim().length > 0;
  if (selectedCount > 0 && hasManual) return `添加 ${selectedCount + 1} 个模型`;
  if (selectedCount > 0) return `添加 ${selectedCount} 个模型`;
  return '添加手动填写的模型';
}

// ── Step 1 ────────────────────────────────────────────────────────────────
function PickProviderStep(props: {
  providers: Provider[];
  draft: ProviderDraft;
  setDraft: (next: ProviderDraft | ((prev: ProviderDraft) => ProviderDraft)) => void;
}): JSX.Element {
  const { providers, draft, setDraft } = props;
  return (
    <div className="wizard-step">
      {providers.length > 0 && (
        <section className="wizard-section">
          <div className="wizard-section-h">使用已配置的服务商</div>
          <div className="preset-grid">
            {providers.map((provider) => {
              const active = draft.mode === 'use-existing' && draft.existingProviderId === provider.id;
              return (
                <button
                  type="button"
                  key={provider.id}
                  className={`preset-card ${active ? 'active' : ''}`}
                  onClick={() => setDraft({ ...draft, mode: 'use-existing', existingProviderId: provider.id, preset: null })}
                  data-testid={`wizard-existing-${provider.id}`}
                >
                  <div className="preset-glyph" style={{ background: 'color-mix(in oklab, var(--accent) 14%, transparent)', color: 'var(--accent)' }}>
                    {provider.name.charAt(0).toUpperCase()}
                  </div>
                  <div className="preset-body">
                    <div className="preset-title">{provider.name}</div>
                    <div className="preset-sub">{provider.base_url}</div>
                  </div>
                </button>
              );
            })}
          </div>
        </section>
      )}

      <section className="wizard-section">
        <div className="wizard-section-h">{providers.length > 0 ? '接入新服务商' : '选一个服务商开始'}</div>
        <div className="preset-grid">
          {PRESET_PROVIDERS.map((preset) => {
            const active = draft.mode === 'preset' && draft.preset?.key === preset.key;
            return (
              <button
                type="button"
                key={preset.key}
                className={`preset-card ${active ? 'active' : ''}`}
                onClick={() => setDraft({ ...draft, mode: 'preset', preset, existingProviderId: null })}
                data-testid={`wizard-preset-${preset.key}`}
              >
                <div className="preset-glyph" style={{ background: `color-mix(in oklab, ${preset.tint} 14%, transparent)`, color: preset.tint }}>
                  {preset.glyph}
                </div>
                <div className="preset-body">
                  <div className="preset-title">
                    {preset.name}
                    {!preset.needsKey && <span className="preset-pill">无需 Key</span>}
                  </div>
                  <div className="preset-sub">{preset.tagline}</div>
                </div>
              </button>
            );
          })}
          <button
            type="button"
            className={`preset-card ${draft.mode === 'custom' ? 'active' : ''}`}
            onClick={() => setDraft({ ...draft, mode: 'custom', preset: null, existingProviderId: null })}
            data-testid="wizard-preset-custom"
          >
            <div className="preset-glyph" style={{ background: 'color-mix(in oklab, var(--ink-mute) 14%, transparent)', color: 'var(--ink)' }}>
              +
            </div>
            <div className="preset-body">
              <div className="preset-title">自定义 OpenAI 兼容端口</div>
              <div className="preset-sub">自托管 vLLM / OneAPI / NewAPI / 任意 OpenAI 兼容服务都走这里。</div>
            </div>
          </button>
        </div>
      </section>
    </div>
  );
}

// ── Step 2 ────────────────────────────────────────────────────────────────
function ConnectStep(props: {
  draft: ProviderDraft;
  setDraft: (next: ProviderDraft | ((prev: ProviderDraft) => ProviderDraft)) => void;
}): JSX.Element {
  const { draft, setDraft } = props;
  const preset = draft.preset;
  const isCustom = draft.mode === 'custom';

  return (
    <div className="wizard-step">
      <section className="wizard-section">
        <div className="wizard-section-h">
          {preset ? `连接 ${preset.name}` : '连接自定义端口'}
        </div>
        {preset && (
          <p className="muted" style={{ marginBottom: 12 }}>{preset.tagline}</p>
        )}

        <div className="form-grid" style={{ gridTemplateColumns: '1fr' }}>
          {isCustom && (
            <>
              <input
                placeholder="服务商名称（如 我的自托管）"
                value={draft.customName}
                onChange={(e) => setDraft({ ...draft, customName: e.target.value })}
                data-testid="wizard-custom-name"
              />
              <input
                placeholder="Base URL（如 https://your-api.com/v1）"
                value={draft.customBaseUrl}
                onChange={(e) => setDraft({ ...draft, customBaseUrl: e.target.value })}
                data-testid="wizard-custom-base-url"
              />
            </>
          )}

          {preset && (
            <div className="kv-row">
              <span className="muted">Base URL</span>
              <code>{preset.baseUrl}</code>
            </div>
          )}

          {(preset?.needsKey ?? true) && (
            <>
              <input
                type="password"
                placeholder="API Key（仅写入本机 Keystore）"
                value={draft.apiKey}
                onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
                data-testid="wizard-api-key"
                autoFocus
              />
              {preset?.keyHint && (
                <div className="muted" style={{ fontSize: 12 }}>
                  申请地址：<code>{preset.keyHint}</code>
                </div>
              )}
            </>
          )}

          {preset && !preset.needsKey && (
            <div className="status-banner">
              这是本机服务，不需要 API Key。点「连接并发现模型」时将尝试访问 <code>{preset.baseUrl}</code>。
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

// ── Step 3 ────────────────────────────────────────────────────────────────
function PickModelsStep(props: {
  discovery: DiscoveryResponse | null;
  discoveryError: string | null;
  filter: string;
  setFilter: (value: string) => void;
  filtered: DiscoveredModel[];
  existing: Set<string>;
  selectedNames: Set<string>;
  toggle: (name: string) => void;
  selectAll: () => void;
  clearAll: () => void;
  manualForm: { model_name: string; display_name: string };
  setManualForm: (
    next:
      | { model_name: string; display_name: string }
      | ((prev: { model_name: string; display_name: string }) => { model_name: string; display_name: string }),
  ) => void;
  busy: boolean;
}): JSX.Element {
  const recommended = props.discovery?.recommended.chat;

  if (props.busy && !props.discovery) {
    return (
      <div className="wizard-step">
        <p className="muted">正在向服务商请求模型清单…</p>
      </div>
    );
  }

  // 发现失败 / 不支持 → 只显示手动模式
  if (!props.discovery || props.discoveryError) {
    return (
      <div className="wizard-step">
        {props.discoveryError && (
          <div className="status-banner" data-testid="wizard-discover-error">
            自动发现失败：{props.discoveryError}
            <br />
            没关系，可以直接填写一个具体的 model_name。
          </div>
        )}
        <ManualModelFields
          title="手动填写模型"
          manualForm={props.manualForm}
          setManualForm={props.setManualForm}
          autoFocus
        />
      </div>
    );
  }

  return (
    <div className="wizard-step">
      <div className="discovery-toolbar">
        <input
          placeholder="按名称过滤…"
          value={props.filter}
          onChange={(e) => props.setFilter(e.target.value)}
          data-testid="wizard-discovery-filter"
        />
        <button type="button" className="btn-quiet" onClick={props.selectAll}>全选当前列表</button>
        <button type="button" className="btn-quiet" onClick={props.clearAll}>清空已选</button>
      </div>

      {props.filtered.length === 0 ? (
        <div className="discovery-empty">
          {props.filter.trim() ? '没有匹配的模型。' : '该服务商当前没有返回任何模型。'}
        </div>
      ) : (
        <div className="discovery-list">
          {props.filtered.map((model) => {
            const exists = props.existing.has(model.model_name);
            const checked = props.selectedNames.has(model.model_name);
            const isRec = model.model_name === recommended;
            return (
              <div
                role="button"
                tabIndex={0}
                key={model.model_name}
                className={`discovery-row ${checked ? 'checked' : ''}`}
                onClick={() => {
                  if (!exists) props.toggle(model.model_name);
                }}
                onKeyDown={(event) => {
                  if ((event.key === 'Enter' || event.key === ' ') && !exists) {
                    event.preventDefault();
                    props.toggle(model.model_name);
                  }
                }}
                style={exists ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
                data-testid={`wizard-discovery-row-${model.model_name}`}
              >
                <span className="check-square">
                  {checked && <Icon name="check" size={11} stroke={2.6} />}
                </span>
                <div className="info">
                  <div className="name">
                    {model.display_name}
                    {isRec && <span className="badge-rec">推荐 chat</span>}
                    {exists && <span className="muted">（已添加）</span>}
                  </div>
                  <div className="meta">
                    {model.model_name}
                    {model.context_length ? ` · ${formatContext(model.context_length)}` : ''}
                    {model.supports_vision ? ' · 视觉' : ''}
                    {model.supports_tools ? ' · 工具' : ''}
                  </div>
                </div>
                <div className="price">
                  <div>输入 {pricePerMillion(model.price_input_per_1m)}/1M</div>
                  <div>输出 {pricePerMillion(model.price_output_per_1m)}/1M</div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <ManualModelFields
        title="列表里没有？手动填写"
        manualForm={props.manualForm}
        setManualForm={props.setManualForm}
      />
    </div>
  );
}

function ManualModelFields(props: {
  title: string;
  manualForm: { model_name: string; display_name: string };
  setManualForm: (
    next:
      | { model_name: string; display_name: string }
      | ((prev: { model_name: string; display_name: string }) => { model_name: string; display_name: string }),
  ) => void;
  autoFocus?: boolean;
}): JSX.Element {
  return (
    <section className="wizard-section">
      <div className="wizard-section-h">{props.title}</div>
      <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <input
          placeholder="model_name（如 deepseek-chat / qwen2.5:14b）"
          value={props.manualForm.model_name}
          onChange={(e) => props.setManualForm({ ...props.manualForm, model_name: e.target.value })}
          data-testid="wizard-manual-model-name"
          autoFocus={props.autoFocus}
        />
        <input
          placeholder="显示名称（可选）"
          value={props.manualForm.display_name}
          onChange={(e) => props.setManualForm({ ...props.manualForm, display_name: e.target.value })}
          data-testid="wizard-manual-display-name"
        />
      </div>
    </section>
  );
}
