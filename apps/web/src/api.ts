/**
 * Typed Sidecar HTTP client — only the endpoints the new web UI consumes.
 * Everything else is added on demand. Never throws on network failure;
 * callers decide whether to fall back to mock data.
 */
import type { Model, Provider } from '@taori/shared';
import { authedFetch } from './sidecar';

export class ApiError extends Error {
  readonly code?: string;
  readonly status?: number;
  constructor(message: string, code?: string, status?: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let body: unknown;
    try { body = await res.json(); } catch { /* ignore */ }
    const obj = (body && typeof body === 'object' ? body : {}) as { message?: string; code?: string };
    throw new ApiError(obj.message ?? `${res.status} ${res.statusText}`, obj.code, res.status);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ── Health ───────────────────────────────────────────────────
export interface HealthSnapshot {
  ok: boolean;
  service: string;
  version: string;
  uptime_ms: number;
  control_channel: 'connected' | 'disconnected' | 'unknown';
}

export async function getHealth(): Promise<HealthSnapshot> {
  return json<HealthSnapshot>(await authedFetch('/health'));
}

// ── Providers ────────────────────────────────────────────────
export async function listProviders(): Promise<Provider[]> {
  const res = await json<{ providers: Provider[] }>(await authedFetch('/v1/providers'));
  return res.providers;
}

export interface ProviderKeyStatus {
  provider_id: string;
  key_available: boolean;
}

export async function getProviderKeyStatus(opts?: { confirmKeychain?: boolean }): Promise<ProviderKeyStatus[]> {
  const qs = opts?.confirmKeychain ? '?confirm_keychain=1' : '';
  const res = await json<{ statuses: ProviderKeyStatus[] }>(await authedFetch('/v1/providers/key-status' + qs));
  return res.statuses;
}

// ── Models ───────────────────────────────────────────────────
export async function listModels(): Promise<Model[]> {
  const res = await json<{ models: Model[] }>(await authedFetch('/v1/models'));
  return res.models;
}

// ── Costs ────────────────────────────────────────────────────
export interface RealtimeCost {
  current_conversation_usd: number;
  current_conversation_calls: number;
  today_usd: number;
  month_usd: number;
  currency_display: string;
}

export async function getRealtimeCost(conversationId?: string | null): Promise<RealtimeCost> {
  const qs = conversationId ? `?conversation_id=${encodeURIComponent(conversationId)}` : '';
  const res = await json<{ ok: boolean; data: RealtimeCost }>(await authedFetch('/v1/costs/realtime' + qs));
  return res.data;
}

export interface CostBreakdownRow {
  key: string;
  label: string;
  sum_usd: number;
  count: number;
  // optional dimensions
  model_id?: string | null;
  model_name_snapshot?: string | null;
  feature?: string | null;
  conversation_id?: string | null;
  conversation_title?: string | null;
}

export interface CostBreakdownResponse {
  scope: 'session' | 'today' | 'week' | 'month';
  group_by: string;
  rows: CostBreakdownRow[];
}

export async function getCostBreakdown(opts: {
  scope: 'session' | 'today' | 'week' | 'month';
  groupBy?: 'model' | 'feature' | 'conversation' | 'tag' | 'model_feature';
  conversationId?: string;
}): Promise<CostBreakdownResponse> {
  const params = new URLSearchParams({ scope: opts.scope });
  if (opts.groupBy) params.set('group_by', opts.groupBy);
  if (opts.conversationId) params.set('conversation_id', opts.conversationId);
  const res = await json<{ ok: boolean; data: CostBreakdownResponse }>(
    await authedFetch('/v1/costs/breakdown?' + params.toString()),
  );
  return res.data;
}

// ── Conversations ────────────────────────────────────────────
export interface Conversation {
  id: string;
  type: string;
  title: string;
  created_at: number;
  updated_at: number;
  archived: boolean;
  pinned: boolean;
  tags: string[] | null;
}

export async function listConversations(): Promise<Conversation[]> {
  const res = await json<{ conversations: Conversation[] }>(await authedFetch('/v1/conversations'));
  return res.conversations;
}

export interface MessageAnnotation {
  type: string;
  message_id: string;
  input_tokens?: number | null;
  cache_input_tokens?: number | null;
  output_tokens?: number | null;
  actual_usd?: number | null;
}

export interface ConversationMessage {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  model_id: string | null;
  status: string;
  error: string | null;
  created_at: number;
  attachments_count: number;
  image_attachments: unknown[];
  annotations: MessageAnnotation[];
}

export interface ConversationMessagesResponse {
  conversation: Conversation;
  messages: ConversationMessage[];
}

export async function getMessages(
  conversationId: string,
  limit = 100,
): Promise<ConversationMessagesResponse> {
  const res = await json<ConversationMessagesResponse>(
    await authedFetch(`/v1/conversations/${conversationId}/messages?limit=${limit}`),
  );
  return res;
}

// ── Chat (SSE streaming) ─────────────────────────────────────
export interface ChatRequest {
  conversation_id: string;
  message: string;
  model_id?: string;
}

export async function postChat(
  req: ChatRequest,
  onChunk: (text: string) => void,
  onDone: () => void,
  onError: (err: Error) => void,
): Promise<() => void> {
  const ep = await import('./sidecar').then((m) => m.getSidecarEndpoint());
  const controller = new AbortController();
  const res = await fetch(`${ep.url}/v1/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(ep.bearer ? { Authorization: `Bearer ${ep.bearer}` } : {}),
    },
    body: JSON.stringify(req),
    signal: controller.signal,
    credentials: 'include',
  }).catch((e) => {
    onError(e);
    return null;
  });
  if (!res || !res.ok || !res.body) {
    if (res) onError(new Error(`Chat request failed: ${res.status}`));
    return () => controller.abort();
  }
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const payload = line.slice(6);
            if (payload === '[DONE]') { onDone(); return; }
            try {
              const parsed = JSON.parse(payload) as { content?: string; [k: string]: unknown };
              if (parsed.content) onChunk(parsed.content);
            } catch { /* skip malformed */ }
          }
        }
      }
      onDone();
    } catch (e) {
      if ((e as Error).name !== 'AbortError') onError(e as Error);
    }
  })();
  return () => controller.abort();
}

// ── Write operations ──────────────────────────────────────────
export async function patchModel(id: string, patch: { enabled?: boolean; [k: string]: unknown }): Promise<Model> {
  return json<Model>(await authedFetch(`/v1/models/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }));
}

export async function toggleTool(name: string, enabled: boolean): Promise<{ name: string; enabled: boolean }> {
  return json(await authedFetch(`/v1/tools/${encodeURIComponent(name)}/enabled`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) }));
}

export async function patchProvider(id: string, patch: { name?: string; base_url?: string; api_key?: string; enabled?: boolean }): Promise<Provider> {
  return json<Provider>(await authedFetch(`/v1/providers/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }));
}

export async function createProvider(body: { name: string; type: string; base_url: string; api_key?: string }): Promise<Provider> {
  return json<Provider>(await authedFetch('/v1/providers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
}

export async function patchConversation(id: string, patch: { title?: string; archived?: boolean; pinned?: boolean; tags?: string[] | null }): Promise<Conversation> {
  return json<Conversation>(await authedFetch(`/v1/conversations/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }));
}

export async function deleteConversation(id: string): Promise<void> {
  const res = await authedFetch(`/v1/conversations/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new ApiError(`Delete failed: ${res.status}`);
}

export async function setMemory(key: string, value: unknown, scope: 'global' | 'session' | 'user' = 'global', scopeId?: string): Promise<void> {
  const res = await authedFetch('/v1/memories', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope, scope_id: scopeId, key, value }) });
  if (!res.ok) throw new ApiError(`Set memory failed: ${res.status}`);
}
