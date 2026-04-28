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
import { DEFAULT_OPENROUTER_BASE_URL, priceTier, PRICE_TIER_LABEL } from '@taori/shared';
import type { ProviderType } from '@taori/shared';
import { api } from './api.js';

interface OnboardingProps {
  onDone: () => void;
  onSkip?: () => void;
}

type Step = 'enter-key' | 'testing' | 'discovering' | 'pick-model' | 'saving';

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
  custom: {
    label: '自定义（OpenAI 兼容）',
    default_base_url: '',
    help: '任何兼容 OpenAI Chat Completions 的端点。',
  },
};

export function Onboarding({ onDone, onSkip }: OnboardingProps): JSX.Element {
  const [type, setType] = useState<ProviderType>('openrouter');
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
      supports_vision: boolean;
      price_input_per_1m: number | null;
    }[];
  } | null>(null);
  const [chosen, setChosen] = useState<string>('');
  // MC-1: multi-import for OpenRouter (and other providers with many models).
  // We default-check up to 3 lower/mid-tier chat models so the user gets a
  // useful starting set without having to pick by hand.
  const [chosenSet, setChosenSet] = useState<Set<string>>(new Set());

  const onTypeChange = (t: ProviderType): void => {
    setType(t);
    const preset = PROVIDER_PRESETS[t];
    if (preset) setBaseUrl(preset.default_base_url);
  };

  const submitKey = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    if (!apiKey.trim()) {
      setError('请输入 API Key');
      return;
    }
    setStep('testing');
    try {
      const test = await api.testProvider({ type, base_url: baseUrl, api_key: apiKey });
      if (!test.ok) {
        setStep('enter-key');
        setError(test.error?.message ?? '凭据校验失败');
        return;
      }
      // Test passed → create the provider (this writes the key to the keystore)
      const provider = await api.createProvider({
        name: (PROVIDER_PRESETS[type]?.label ?? type).replace(/（.+?）/g, ''),
        type,
        base_url: baseUrl,
        api_key: apiKey,
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
            supports_vision: m.supports_vision,
            price_input_per_1m: m.price_input_per_1m,
          })),
      });
      const primary = disc.recommended.chat ?? disc.models[0]?.model_name ?? '';
      setChosen(primary);
      // Pre-check up to 3 candidates. Always include the recommended one.
      // Then add up to 2 additional non-vision low-tier picks.
      const initial = new Set<string>();
      if (primary) initial.add(primary);
      for (const m of disc.models) {
        if (initial.size >= 3) break;
        if (!initial.has(m.model_name)) initial.add(m.model_name);
      }
      setChosenSet(initial);
      setStep('pick-model');
    } catch (e) {
      setStep('enter-key');
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const finishWithModel = async (): Promise<void> => {
    if (!discovery) return;
    setError(null);
    // Determine the set we will create. The "primary" chosen one becomes the
    // default for chat (and vision if it supports vision). The rest are
    // imported as additional, non-default models so users can switch.
    const primary = chosen;
    const set = new Set(chosenSet);
    if (primary) set.add(primary);
    if (set.size === 0) {
      setError('请至少勾选一个模型');
      return;
    }
    setStep('saving');
    try {
      for (const modelName of set) {
        const candidate = discovery.candidates.find(
          (m) => m.model_name === modelName,
        );
        const display = candidate?.display_name ?? modelName;
        const supportsVision = candidate?.supports_vision ?? false;
        const isPrimary = modelName === primary;
        await api.createModel({
          provider_id: discovery.provider_id,
          model_name: modelName,
          capability: 'chat',
          display_name: display,
          supports_vision: supportsVision,
          price_input_per_1m: candidate?.price_input_per_1m ?? null,
          is_default_for: isPrimary ? 'chat' : null,
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
      if (next.has(modelName)) {
        next.delete(modelName);
        // If we just deselected the primary, fall back to any remaining one.
        if (modelName === chosen) {
          const fallback = next.values().next().value;
          setChosen(fallback ?? '');
        }
      } else {
        next.add(modelName);
        if (!chosen) setChosen(modelName);
      }
      return next;
    });
  };

  return (
    <div className="onboarding" data-testid="onboarding">
      <h2>欢迎使用 Taori</h2>
      <p className="hint">先配一个模型供应商，配置后即可开始聊天。</p>

      {step === 'enter-key' && (
        <form onSubmit={submitKey} className="onboarding-form">
          <label>
            供应商
            <select
              value={type}
              onChange={(e) => onTypeChange(e.target.value as ProviderType)}
              data-testid="onb-provider-type"
            >
              {Object.entries(PROVIDER_PRESETS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.label}
                </option>
              ))}
            </select>
          </label>
          <p className="hint">{PROVIDER_PRESETS[type]?.help ?? ''}</p>
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
            API Key
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder="sk-or-..."
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

      {step === 'testing' && <p data-testid="onb-status">正在校验 API Key…</p>}
      {step === 'discovering' && <p data-testid="onb-status">正在拉取可用模型…</p>}

      {step === 'pick-model' && discovery && (
        <div className="onboarding-pick" data-testid="onb-pick">
          <p>
            选择要导入的模型（可多选），并指定一个作为默认聊天模型：
          </p>
          <ul className="onboarding-candidates" data-testid="onb-candidates">
            {discovery.candidates.map((m) => {
              const tier = priceTier(m.price_input_per_1m);
              const checked = chosenSet.has(m.model_name);
              const isPrimary = chosen === m.model_name;
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
                      disabled={!checked}
                      onChange={() => {
                        if (checked) setChosen(m.model_name);
                      }}
                      data-testid="onb-candidate-primary"
                      title="设为默认聊天模型"
                    />
                    <span className="cand-name">{m.display_name}</span>
                    {m.supports_vision && <span title="支持视觉"> 👁</span>}
                    {tier && (
                      <span className={`price-badge tier-${tier}`}>
                        {PRICE_TIER_LABEL[tier]}
                      </span>
                    )}
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
