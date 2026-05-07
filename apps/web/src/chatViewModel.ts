import type { Message as AiMessage } from '@ai-sdk/react';
import type {
  ChatMetaAnnotation,
  Model,
  ModelHealthRow,
  Provider,
  QuickCompareAnnotation,
} from '@taori/shared';
import { modelDisplayWithProvider } from './modelDisplay.js';

export interface QuickCompareUiOutput {
  outputId: string;
  index: number;
  modelId: string;
  content: string;
  status: 'streaming' | 'complete' | 'failed';
  error?: string;
}

export interface QuickCompareUiState {
  compareId: string | null;
  running: boolean;
  error: string | null;
  outputs: QuickCompareUiOutput[];
}

export type ChatMessage = AiMessage & {
  model_id?: string | null;
  status?: string | null;
  error?: string | null;
  created_at?: number;
};

export function parseChatMetaAnnotation(raw: Record<string, unknown>): ChatMetaAnnotation | null {
  if (raw.type !== 'meta') return null;
  if (typeof raw.conversation_id !== 'string') return null;
  if (raw.message_id != null && typeof raw.message_id !== 'string') return null;
  if (raw.model_id != null && typeof raw.model_id !== 'string') return null;
  return {
    type: 'meta',
    conversation_id: raw.conversation_id,
    message_id: typeof raw.message_id === 'string' ? raw.message_id : null,
    model_id: typeof raw.model_id === 'string' ? raw.model_id : null,
    run_id: typeof raw.run_id === 'string' ? raw.run_id : '',
  };
}

export function toChatMessage(m: {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string | null;
  model_id?: string | null;
  status?: string | null;
  error?: string | null;
  created_at?: number;
}): ChatMessage {
  return {
    id: m.id,
    role: m.role,
    content: m.content ?? '',
    model_id: m.model_id ?? null,
    status: m.status ?? null,
    error: m.error ?? null,
    created_at: m.created_at,
  };
}

export function messageRoleLabel(
  m: ChatMessage,
  chatModels: Model[],
  providers: Provider[],
  currentModel: Model,
): string {
  if (m.role === 'user') return '你';
  if (m.role === 'system') return '系统';
  const modelForMessage = m.model_id
    ? chatModels.find((candidate) => candidate.id === m.model_id)
    : null;
  return modelDisplayWithProvider(modelForMessage ?? currentModel, providers);
}

export function slowResponseThresholdMs(health: ModelHealthRow | undefined): number {
  const baseline = health?.avg_first_token_ms;
  if (baseline == null || !Number.isFinite(baseline)) return 6_000;
  return Math.max(5_000, Math.min(8_000, Math.round(baseline * 1.4)));
}

export function isQuickCompareEligibleModel(model: Model, now = Date.now()): boolean {
  return (
    model.enabled
    && !model.demoted
    && Boolean(model.provider_id)
    && (model.capability === 'chat' || model.capability === 'multimodal')
    && (model.disabled_until == null || model.disabled_until <= now)
  );
}

export function hasQuickCompareToolIntent(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  return (
    /https?:\/\//i.test(normalized)
    || /(?:搜索|检索|联网|网页|抓取|读取网页|浏览器|最新|实时|公开资料|新闻|今日)/i.test(normalized)
    || /\b(?:search|fetch|browse|web|url|latest|realtime|real-time|online|news)\b/i.test(normalized)
  );
}

export function pickFastAlternativeModel(
  currentModel: Model,
  models: Model[],
  healthRows: Map<string, ModelHealthRow>,
): Model | null {
  const currentTtfb = healthRows.get(currentModel.id)?.avg_first_token_ms ?? Number.POSITIVE_INFINITY;
  return models
    .filter((item) =>
      item.id !== currentModel.id
      && item.enabled
      && !item.demoted
      && (item.capability === 'chat' || item.capability === 'multimodal')
      && (item.disabled_until == null || item.disabled_until <= Date.now())
    )
    .slice()
    .sort((a, b) => {
      const ah = healthRows.get(a.id)?.avg_first_token_ms ?? Number.POSITIVE_INFINITY;
      const bh = healthRows.get(b.id)?.avg_first_token_ms ?? Number.POSITIVE_INFINITY;
      if (ah !== bh) return ah - bh;
      return a.fallback_order - b.fallback_order;
    })
    .find((item) => (healthRows.get(item.id)?.avg_first_token_ms ?? Number.POSITIVE_INFINITY) < currentTtfb) ?? null;
}

export function quickCompareStateFromAnnotations(annotations: QuickCompareAnnotation[]): QuickCompareUiState {
  return {
    ...annotations.reduce<QuickCompareUiState>(
      (state, annotation) => applyQuickCompareAnnotation(state, annotation),
      { compareId: null, running: true, error: null, outputs: [] },
    ),
    running: false,
  };
}

export function applyQuickCompareAnnotation(
  state: QuickCompareUiState,
  ann: QuickCompareAnnotation,
): QuickCompareUiState {
  const outputs = new Map<string, QuickCompareUiOutput>(
    state.outputs.map((output) => [output.outputId, output]),
  );
  let compareId = state.compareId;
  let running = state.running;

  if (ann.type === 'qc.meta') {
    compareId = ann.compare_id;
    running = true;
  } else if (ann.type === 'qc.participant_start') {
    outputs.set(ann.output_id, {
      outputId: ann.output_id,
      index: ann.index,
      modelId: ann.model_id,
      content: '',
      status: 'streaming',
    });
  } else if (ann.type === 'qc.participant_delta') {
    const current = outputs.get(ann.output_id) ?? {
      outputId: ann.output_id,
      index: ann.index,
      modelId: ann.model_id,
      content: '',
      status: 'streaming' as const,
    };
    outputs.set(ann.output_id, { ...current, content: current.content + ann.text_chunk });
  } else if (ann.type === 'qc.participant_done') {
    outputs.set(ann.output_id, {
      outputId: ann.output_id,
      index: ann.index,
      modelId: ann.model_id,
      content: ann.content,
      status: 'complete',
    });
  } else if (ann.type === 'qc.participant_failed') {
    outputs.set(ann.output_id, {
      outputId: ann.output_id,
      index: ann.index,
      modelId: ann.model_id,
      content: outputs.get(ann.output_id)?.content ?? '',
      status: 'failed',
      error: ann.message,
    });
  } else if (ann.type === 'qc.done') {
    compareId = ann.compare_id;
    running = false;
  }

  return {
    compareId,
    running,
    error: state.error,
    outputs: [...outputs.values()].sort((a, b) => a.index - b.index),
  };
}
