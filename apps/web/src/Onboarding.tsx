/**
 * Onboarding flow.
 *
 * Single-screen, multi-step (visual only): user supplies provider type +
 * API key → we test → on success we create the provider, run model
 * discovery, and seed a recommended chat model as the default.
 *
 * Implements DoD step 2 from the M1 spec: "通过 onboarding 用 OpenRouter Key
 * 配好默认模型". Designed so a Renderer-only test (Playwright) can drive it
 * end-to-end against a mocked sidecar.
 */

import { useState } from 'react';
import {
  DEFAULT_OPENROUTER_BASE_URL,
  DEFAULT_DEEPSEEK_BASE_URL,
  DEFAULT_PACKYAPI_BASE_URL,
  DEFAULT_SILICONFLOW_BASE_URL,
  isChatCapable,
  priceTier,
  PRICE_TIER_LABEL,
} from '@taori/shared';
import type { ProviderType } from '@taori/shared';
import { api } from './api.js';
import {
  CUSTOM_COMPAT_PROVIDER_TEMPLATES,
  type CompatProviderTemplate,
} from './providerLabels.js';

interface OnboardingProps {
  onDone: () => void;
  onSkip?: () => void;
}

type Step = 'enter-key' | 'testing' | 'discovering' | 'pick-model' | 'saving';
type CompatProviderId = CompatProviderTemplate['id'];
type OnboardingProviderChoice = ProviderType | CompatProviderId;

const PROVIDER_PRESETS: Partial<
  Record<ProviderType, { label: string; default_base_url: string; help: string }>
> = {
  openrouter: {
    label: 'OpenRouter（推荐）',
    default_base_url: DEFAULT_OPENROUTER_BASE_URL,
    help: '一个 Key 接入数百模型，价格透明。',
  },
  openai: {
    label: 'OpenAI',
    default_base_url: 'https://api.openai.com/v1',
    help: '官方 OpenAI 接口（GPT-4o / GPT-4o mini）。',
  },
  anthropic: {
    label: 'Anthropic',
    default_base_url: 'https://api.anthropic.com',
    help: 'Claude 系列。M1 仅支持基础测试。',
  },
  ollama: {
    label: 'Ollama（本地）',
    default_base_url: 'http://127.0.0.1:11434/v1',
    help: '本地模型，无需 Key。',
  },
  volcengine_ark: {
    label: '火山方舟（豆包 / SeeDream / SeeDance / Wan）',
    default_base_url: 'https://ark.cn-beijing.volces.com/api/v3',
    help: '一个 Key 解锁文本、多模态、文生图、文生视频。',
  },
  huawei_maas: {
    label: '华为云 MaaS（盘古 / DeepSeek / Kimi / Qwen）',
    default_base_url: 'https://api.modelarts-maas.com/openai/v1',
    help: '华为云 ModelArts MaaS，兼容 OpenAI Chat Completions。',
  },
  deepseek: {
    label: 'DeepSeek 官方',
    default_base_url: DEFAULT_DEEPSEEK_BASE_URL,
    help: 'DeepSeek 官方 OpenAI 兼容接口，支持 deepseek-v4-flash / deepseek-v4-pro。',
  },
  packyapi: {
    label: 'PackyAPI / PackyCode（GPT Image 2）',
    default_base_url: DEFAULT_PACKYAPI_BASE_URL,
    help: 'OpenAI 兼容图像生成端点，默认导入 gpt-image-2。',
  },
  siliconflow: {
    label: '硅基流动 SiliconFlow',
    default_base_url: DEFAULT_SILICONFLOW_BASE_URL,
    help: 'OpenAI 兼容聊天、多模态与图像生成服务。',
  },
  custom: {
    label: '自定义（OpenAI 兼容）',
    default_base_url: '',
    help: '任何兼容 OpenAI Chat Completions 的端点。',
  },
};

const PROVIDER_GUIDES: Partial<
  Record<
    ProviderType,
    {
      category: string;
      bestFor: string;
      fallback: string;
      examples?: string[];
    }
  >
> = {
  deepseek: {
    category: '国内直连',
    bestFor: '适合作为主力中文推理 / 编码入口。',
    fallback: '推荐把硅基流动或 OpenRouter 放在后面做兜底。',
  },
  siliconflow: {
    category: '国内聚合',
    bestFor: '适合统一接入多家国产模型，承担扩展面与 fallback。',
    fallback: '高频主任务建议仍保留一个官方直连作为第一顺位。',
  },
  volcengine_ark: {
    category: '国内直连',
    bestFor: '适合豆包、视觉、生图和视频一体化接入。',
    fallback: '建议搭配硅基流动或 OpenRouter 做视觉 / 图像备用出口。',
  },
  huawei_maas: {
    category: '国内直连',
    bestFor: '适合企业云接入和兼容 OpenAI 的稳态出口。',
    fallback: '企业网络或区域不稳时，建议同时保留公网聚合备份。',
  },
  openrouter: {
    category: '海外聚合',
    bestFor: '适合广覆盖试模型、做价格对照、承担海外 fallback。',
    fallback: '中文主力建议另配国内直连模型，减少延迟和本地化落差。',
  },
  ollama: {
    category: '本地',
    bestFor: '适合离线 / 内网兜底，不依赖外部账单。',
    fallback: '更适合做最后一道 fallback，不建议一上来承担关键主任务。',
  },
  packyapi: {
    category: '专用图像',
    bestFor: '适合作为固定生图出口，承担图像专用工作流。',
    fallback: '建议同时保留火山或硅基流动，避免单点图像出口。',
  },
  custom: {
    category: '兼容接入',
    bestFor: '适合接通义、Kimi、智谱、MiniMax 等 OpenAI 兼容端点。',
    fallback: '推荐把兼容端点放在明确主力 provider 后面，用作定向补位。',
    examples: ['阿里云百炼', '智谱', 'MiniMax', 'Kimi'],
  },
};

const PROVIDER_STACK_RECIPES: Partial<
  Record<
    ProviderType,
    {
      title: string;
      primary: string;
      fallback: string;
      note: string;
    }[]
  >
> = {
  deepseek: [
    {
      title: '中文主力 + 海外兜底',
      primary: 'DeepSeek 官方',
      fallback: 'OpenRouter',
      note: '主链路保持低延迟和中文体验，复杂场景再切到海外广覆盖模型。',
    },
    {
      title: '中文主力 + 国产扩展面',
      primary: 'DeepSeek 官方',
      fallback: '硅基流动',
      note: '适合想把国内直连放前面，同时保留更多模型和多模态出口的组合。',
    },
  ],
  siliconflow: [
    {
      title: '国产聚合 + 官方主力',
      primary: 'DeepSeek 官方',
      fallback: '硅基流动',
      note: '把官方模型留给高频主任务，再用聚合承担扩展、失败重试和多样化试验。',
    },
  ],
  openrouter: [
    {
      title: '广覆盖试模 + 中文主力',
      primary: 'DeepSeek 官方 / 火山方舟',
      fallback: 'OpenRouter',
      note: '先用国内直连扛主路径，再用 OpenRouter 做比价、试模和海外兜底。',
    },
  ],
  volcengine_ark: [
    {
      title: '视觉生产 + 聊天兜底',
      primary: '火山方舟',
      fallback: '硅基流动 / OpenRouter',
      note: '适合把视觉、多模态和图像工作流留在火山体系，同时保留备用出口。',
    },
  ],
  ollama: [
    {
      title: '本地保底 + 云端主力',
      primary: 'DeepSeek 官方 / OpenRouter',
      fallback: 'Ollama',
      note: '更适合把 Ollama 放在最后一道保底，而不是一开始承担全部任务。',
    },
  ],
  custom: [
    {
      title: '兼容端点补位栈',
      primary: 'DeepSeek 官方 / OpenRouter',
      fallback: '通义 / Kimi / 智谱（兼容端点）',
      note: '兼容端点更适合做特定场景补位；可直接选阿里云百炼、智谱、MiniMax、Kimi 模板自动填充 Base URL。',
    },
  ],
};

function defaultProviderName(type: ProviderType): string {
  const presetLabel = PROVIDER_PRESETS[type]?.label ?? type;
  return presetLabel.replace(/（.+?）/g, '').trim() || '自定义 Provider';
}

function findCompatTemplate(choice: OnboardingProviderChoice): CompatProviderTemplate | null {
  return CUSTOM_COMPAT_PROVIDER_TEMPLATES.find((template) => template.id === choice) ?? null;
}

function defaultProviderNameForChoice(choice: OnboardingProviderChoice, type: ProviderType): string {
  return findCompatTemplate(choice)?.providerName ?? defaultProviderName(type);
}

export function Onboarding({ onDone, onSkip }: OnboardingProps): JSX.Element {
  const [type, setType] = useState<ProviderType>('openrouter');
  const [providerChoice, setProviderChoice] = useState<OnboardingProviderChoice>('openrouter');
  const [providerName, setProviderName] = useState(defaultProviderName('openrouter'));
  const [providerNameTouched, setProviderNameTouched] = useState(false);
  const [baseUrl, setBaseUrl] = useState(
    PROVIDER_PRESETS.openrouter?.default_base_url ?? '',
  );
  const [apiKey, setApiKey] = useState('');
  const [step, setStep] = useState<Step>('enter-key');
  const [error, setError] = useState<string | null>(null);
  const [discovery, setDiscovery] = useState<{
    provider_id: string;
    chat: string | null;
    vision: string | null;
    candidates: {
      model_name: string;
      display_name: string;
      capability: import('@taori/shared').ModelCapability;
      supports_vision: boolean;
      supports_tools: boolean;
      price_input_per_1m: number | null;
      price_output_per_1m: number | null;
      price_per_image: number | null;
      price_per_video_second: number | null;
    }[];
  } | null>(null);
  const [chosen, setChosen] = useState<string>('');
  // MC-1: multi-import for OpenRouter (and other providers with many models).
  // We default-check up to 3 lower/mid-tier chat models so the user gets a
  // useful starting set without having to pick by hand.
  const [chosenSet, setChosenSet] = useState<Set<string>>(new Set());

  const onTypeChange = (t: ProviderType, nextChoice: OnboardingProviderChoice = t): void => {
    const previousDefault = defaultProviderNameForChoice(providerChoice, type);
    setProviderChoice(nextChoice);
    setType(t);
    const preset = PROVIDER_PRESETS[t];
    if (preset) setBaseUrl(preset.default_base_url);
    if (!providerNameTouched || providerName.trim() === previousDefault) {
      setProviderName(defaultProviderNameForChoice(nextChoice, t));
      setProviderNameTouched(false);
    }
  };

  const applyCompatTemplate = (template: (typeof CUSTOM_COMPAT_PROVIDER_TEMPLATES)[number]): void => {
    setProviderChoice(template.id);
    if (type !== 'custom') {
      setType('custom');
    }
    setBaseUrl(template.baseUrl);
    setProviderName(template.providerName);
    setProviderNameTouched(true);
  };

  const submitKey = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    const trimmedProviderName = providerName.trim();
    if (!trimmedProviderName) {
      setError('请输入供应商名称');
      return;
    }
    const trimmedApiKey = apiKey.trim();
    const requiresApiKey = type !== 'ollama';
    if (requiresApiKey && !trimmedApiKey) {
      setError('请输入 API Key');
      return;
    }
    setStep('testing');
    try {
      const test = await api.testProvider({
        type,
        base_url: baseUrl,
        ...(trimmedApiKey ? { api_key: trimmedApiKey } : {}),
      });
      if (!test.ok) {
        setStep('enter-key');
        setError(test.error?.message ?? '凭据校验失败');
        return;
      }
      // Test passed → create the provider (this writes the key to the keystore)
      const provider = await api.createProvider({
        name: trimmedProviderName,
        type,
        base_url: baseUrl,
        ...(trimmedApiKey ? { api_key: trimmedApiKey } : {}),
      });
      setStep('discovering');
      const disc = await api.discoverModels(provider.id);
      setDiscovery({
        provider_id: provider.id,
        chat: disc.recommended.chat,
        vision: disc.recommended.vision,
        candidates: disc.models
          .slice(0, 30)
          .map((m) => ({
            model_name: m.model_name,
            display_name: m.display_name,
            capability: m.capability,
            supports_vision: m.supports_vision,
            supports_tools: m.supports_tools ?? isChatCapable(m.capability),
            price_input_per_1m: m.price_input_per_1m,
            price_output_per_1m: m.price_output_per_1m,
            price_per_image: m.price_per_image ?? null,
            price_per_video_second: m.price_per_video_second ?? null,
          })),
      });
      setChosen('');
      setChosenSet(new Set());
      setStep('pick-model');
    } catch (e) {
      setStep('enter-key');
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const finishWithModel = async (): Promise<void> => {
    if (!discovery) return;
    setError(null);
    const set = new Set(chosenSet);
    if (set.size === 0) {
      setError('请至少勾选一个模型');
      return;
    }
    // Only an actually selected chat/multimodal model can become the default.
    const primary = chosen && set.has(chosen) ? chosen : '';
    setStep('saving');
    try {
      for (const modelName of set) {
        const candidate = discovery.candidates.find(
          (m) => m.model_name === modelName,
        );
        if (!candidate) continue;
        const capability = candidate.capability;
        const isPrimary = modelName === primary;
        // Only chat / multimodal can serve as the chat default. Image/video
        // models live on their own capability tabs and are never auto-routed
        // by the chat composer.
        const canBeChatDefault = capability === 'chat' || capability === 'multimodal';
        await api.createModel({
          provider_id: discovery.provider_id,
          model_name: modelName,
          capability,
          display_name: candidate.display_name,
          supports_vision: candidate.supports_vision,
          supports_tools: candidate.supports_tools,
          price_input_per_1m: candidate.price_input_per_1m,
          price_output_per_1m: candidate.price_output_per_1m,
          price_per_image: candidate.price_per_image,
          price_per_video_second: candidate.price_per_video_second,
          is_default_for: isPrimary && canBeChatDefault ? 'chat' : null,
        });
      }
      onDone();
    } catch (e) {
      setStep('pick-model');
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const toggleChosen = (modelName: string): void => {
    setChosenSet((prev) => {
      const next = new Set(prev);
        const currentCandidate = discovery?.candidates.find((candidate) => candidate.model_name === modelName);
        const canBeChatDefault =
          currentCandidate?.capability === 'chat' || currentCandidate?.capability === 'multimodal';
        if (next.has(modelName)) {
          next.delete(modelName);
          // If we just deselected the primary, fall back to any remaining one.
          if (modelName === chosen) {
            const fallback = discovery?.candidates.find(
              (candidate) =>
                next.has(candidate.model_name)
                && (candidate.capability === 'chat' || candidate.capability === 'multimodal'),
            )?.model_name;
            setChosen(fallback ?? '');
          }
        } else {
          next.add(modelName);
          if (!chosen && canBeChatDefault) setChosen(modelName);
        }
        return next;
      });
  };

  const statusCopy: Partial<Record<Step, { title: string; hint: string }>> = {
    testing: {
      title: type === 'ollama' ? '正在连接 Ollama' : '正在校验 API Key',
      hint: '验证通过后会自动创建供应商并继续发现模型。',
    },
    discovering: {
      title: '正在拉取可用模型',
      hint: 'Taori 会识别推荐模型，你可以按需勾选要导入的候选。',
    },
    saving: {
      title: '正在保存模型配置',
      hint: '导入完成后即可直接开始聊天、作图或发起圆桌。',
    },
  };
  const providerGuide = PROVIDER_GUIDES[type];
  const providerStackRecipes = PROVIDER_STACK_RECIPES[type] ?? [];
  const providerHelp = findCompatTemplate(providerChoice)?.hint ?? PROVIDER_PRESETS[type]?.help ?? '';

  return (
    <div className="onboarding" data-testid="onboarding">
      <h2>欢迎使用 Taori</h2>
      <p className="hint">先配一个模型供应商，配置后即可开始聊天。</p>
      <div className="onboarding-highlights" aria-hidden="true">
        <span>多模型切换</span>
        <span>成本透明</span>
        <span>本地优先</span>
      </div>

      {step === 'enter-key' && (
        <form onSubmit={submitKey} className="onboarding-form">
          <label>
            供应商
            <select
              value={providerChoice}
              onChange={(e) => {
                const nextChoice = e.target.value as OnboardingProviderChoice;
                const compatTemplate = findCompatTemplate(nextChoice);
                if (compatTemplate) {
                  applyCompatTemplate(compatTemplate);
                  return;
                }
                onTypeChange(nextChoice as ProviderType);
              }}
              data-testid="onb-provider-type"
            >
              <optgroup label="官方 / 原生">
                {Object.entries(PROVIDER_PRESETS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v.label}
                  </option>
                ))}
              </optgroup>
              <optgroup label="常用兼容端点">
                {CUSTOM_COMPAT_PROVIDER_TEMPLATES.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.label}
                  </option>
                ))}
              </optgroup>
            </select>
          </label>
          <p className="hint">{providerHelp}</p>
          {providerGuide && (
            <div className="onboarding-provider-note" data-testid="onb-provider-note">
              <strong>{providerGuide.category}</strong>
              <span>{providerGuide.bestFor}</span>
              {providerGuide.examples?.length ? (
                <em>{providerGuide.examples.join(' / ')}</em>
              ) : null}
              {providerStackRecipes[0] ? (
                <small>
                  推荐搭配：{providerStackRecipes[0].primary} → {providerStackRecipes[0].fallback}
                </small>
              ) : null}
            </div>
          )}
          {type === 'custom' && (
            <div className="onboarding-compat-templates" data-testid="onb-compat-templates">
              <div className="onboarding-compat-templates__head">
                <strong>常用兼容供应商</strong>
                <span>选一个模板即可自动填好名称和 Base URL，再补 API Key 即可。</span>
              </div>
              <div className="onboarding-compat-templates__grid">
                {CUSTOM_COMPAT_PROVIDER_TEMPLATES.map((template) => {
                  const active =
                    providerName.trim() === template.providerName && baseUrl.trim() === template.baseUrl;
                  return (
                    <button
                      key={template.id}
                      type="button"
                      className={`onboarding-compat-template${active ? ' is-active' : ''}`}
                      onClick={() => applyCompatTemplate(template)}
                      data-testid={`onb-compat-template-${template.id}`}
                    >
                      <strong>{template.label}</strong>
                      <span>{template.hint}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          <label>
            供应商名称
            <input
              value={providerName}
              onChange={(e) => {
                setProviderName(e.target.value);
                setProviderNameTouched(true);
              }}
              maxLength={100}
              spellCheck={false}
              placeholder={defaultProviderNameForChoice(providerChoice, type)}
              data-testid="onb-provider-name"
            />
          </label>
          <label>
            Base URL
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              spellCheck={false}
              data-testid="onb-base-url"
            />
          </label>
          <label>
            {type === 'ollama' ? 'API Key（Ollama 本地无需填写）' : 'API Key'}
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder={type === 'ollama' ? '留空即可使用本地 Ollama' : 'sk-or-...'}
              data-testid="onb-api-key"
            />
          </label>
          {error && <p className="err" data-testid="onb-error">{error}</p>}
          <div className="onboarding-actions">
            <button type="submit" data-testid="onb-submit">
              校验并继续
            </button>
            {onSkip && (
              <button
                type="button"
                className="onb-skip"
                onClick={onSkip}
                data-testid="onb-skip"
              >
                暂不配置（仅浏览）
              </button>
            )}
          </div>
        </form>
      )}

      {(step === 'testing' || step === 'discovering' || step === 'saving') && (
        <div className="onboarding-status-card" data-testid="onb-status">
          <span className="onboarding-status-card__spinner" aria-hidden="true" />
          <div>
            <strong>{statusCopy[step]?.title ?? '处理中'}</strong>
            <span>{statusCopy[step]?.hint ?? '请稍候…'}</span>
          </div>
        </div>
      )}

      {step === 'pick-model' && discovery && (
        <div className="onboarding-pick" data-testid="onb-pick">
          <p className="onboarding-pick-intro">
            选择要导入的模型（可多选）。文本/多模态模型可设为默认聊天模型；图像/视频模型仅可在画图/视频流程中使用。
          </p>
          {discovery.chat ? (
            <p className="onboarding-pick-note" data-testid="onb-pick-note">
              推荐默认聊天模型：{discovery.candidates.find((candidate) => candidate.model_name === discovery.chat)?.display_name ?? discovery.chat}
            </p>
          ) : null}
          <ul className="onboarding-candidates" data-testid="onb-candidates">
            {discovery.candidates.map((m) => {
              const tier = priceTier(m.price_input_per_1m);
              const checked = chosenSet.has(m.model_name);
              const isPrimary = chosen === m.model_name;
              const canBeChatDefault =
                m.capability === 'chat' || m.capability === 'multimodal';
              const capLabel: Record<string, string> = {
                chat: '💬 文本',
                multimodal: '🖼️ 多模态',
                image: '🎨 图像',
                video: '🎬 视频',
                asr: '🎙️ ASR',
                tts: '🔊 TTS',
                embedding: '🧬 嵌入',
              };
              const priceHint =
                m.capability === 'image' && m.price_per_image != null
                  ? `每张 $${m.price_per_image.toFixed(3)}`
                  : m.capability === 'video' && m.price_per_video_second != null
                    ? `每秒 $${m.price_per_video_second.toFixed(3)}`
                    : null;
              return (
                <li key={m.model_name}>
                  <label>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleChosen(m.model_name)}
                      data-testid="onb-candidate-check"
                      data-model-name={m.model_name}
                    />
                    <input
                      type="radio"
                      name="onb-primary"
                      checked={isPrimary}
                      disabled={!checked || !canBeChatDefault}
                      onChange={() => {
                        if (checked && canBeChatDefault) setChosen(m.model_name);
                      }}
                      data-testid="onb-candidate-primary"
                      title={
                        canBeChatDefault
                          ? '设为默认聊天模型'
                          : '仅文本/多模态可设为默认聊天'
                      }
                    />
                    <span className="cand-cap">{capLabel[m.capability] ?? m.capability}</span>
                    <span className="cand-name">{m.display_name}</span>
                    {m.supports_vision && <span title="支持视觉"> 👁</span>}
                    {m.supports_tools && <span title="支持工具调用"> 🧰</span>}
                    {tier && (
                      <span className={`price-badge tier-${tier}`}>
                        {PRICE_TIER_LABEL[tier]}
                      </span>
                    )}
                    {priceHint && <span className="price-hint">{priceHint}</span>}
                  </label>
                </li>
              );
            })}
          </ul>
          {error && <p className="err">{error}</p>}
          <button onClick={finishWithModel} data-testid="onb-finish">
            完成（导入 {chosenSet.size} 个模型）
          </button>
        </div>
      )}

      {step === 'saving' && <p data-testid="onb-status">正在保存…</p>}
    </div>
  );
}
