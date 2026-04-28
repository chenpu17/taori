/**
 * Typed Sidecar HTTP client for the Renderer.
 *
 * All methods go through `authedFetch` so they automatically pick up the
 * (Tauri- or env-derived) bearer token. We keep this thin — no caching, no
 * retry — letting the calling components own their UI states.
 */

import { authedFetch } from './sidecar.js';
import type {
  Provider,
  ProviderCreate,
  ProviderUpdate,
  ProviderTestRequest,
  ProviderTestResponse,
  Model,
  ModelCreate,
  ModelUpdate,
  ModelDiscoveryResponse,
  ModelCapability,
  Roundtable,
  RoundtableMode,
  RoundtableMessage,
  Participant,
} from '@taori/shared';

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let body: unknown = undefined;
    try {
      body = await res.json();
    } catch {
      /* ignore */
    }
    const msg =
      typeof body === 'object' && body && 'message' in body
        ? (body as { message: string }).message
        : `${res.status} ${res.statusText}`;
    const err = new Error(msg);
    (err as { code?: string }).code =
      typeof body === 'object' && body && 'code' in body
        ? (body as { code: string }).code
        : undefined;
    throw err;
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  health: () => authedFetch('/health').then((r) => json<{ ok: boolean; control_channel: string }>(r)),

  listProviders: () =>
    authedFetch('/v1/providers').then((r) =>
      json<{ providers: Provider[] }>(r),
    ),
  testProvider: (input: ProviderTestRequest) =>
    authedFetch('/v1/providers/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }).then((r) => json<ProviderTestResponse>(r)),
  createProvider: (input: ProviderCreate) =>
    authedFetch('/v1/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }).then((r) => json<Provider>(r)),
  updateProvider: (id: string, patch: ProviderUpdate) =>
    authedFetch(`/v1/providers/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }).then((r) => json<Provider>(r)),
  deleteProvider: (id: string) =>
    authedFetch(`/v1/providers/${id}`, { method: 'DELETE' }).then((r) =>
      json<void>(r),
    ),
  discoverModels: (providerId: string) =>
    authedFetch(`/v1/providers/${providerId}/discover`).then((r) =>
      json<ModelDiscoveryResponse>(r),
    ),

  listModels: () =>
    authedFetch('/v1/models').then((r) => json<{ models: Model[] }>(r)),
  createModel: (input: ModelCreate) =>
    authedFetch('/v1/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }).then((r) => json<Model>(r)),
  updateModel: (id: string, patch: ModelUpdate) =>
    authedFetch(`/v1/models/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }).then((r) => json<Model>(r)),
  setDefaultModel: (modelId: string, capability: ModelCapability) =>
    authedFetch(`/v1/models/${modelId}/default`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ capability }),
    }).then((r) => json<Model>(r)),
  deleteModel: (id: string) =>
    authedFetch(`/v1/models/${id}`, { method: 'DELETE' }).then((r) =>
      json<void>(r),
    ),
  reorderModels: (capability: ModelCapability, ordered_ids: string[]) =>
    authedFetch('/v1/models/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ capability, ordered_ids }),
    }).then((r) => json<{ capability: ModelCapability; models: Model[] }>(r)),

  costsRealtime: (conversationId?: string | null) => {
    const qs = conversationId ? `?conversation_id=${encodeURIComponent(conversationId)}` : '';
    return authedFetch(`/v1/costs/realtime${qs}`).then((r) =>
      json<{
        ok: boolean;
        data: {
          current_conversation_usd: number;
          current_conversation_calls: number;
          today_usd: number;
          month_usd: number;
          currency_display: string;
        };
      }>(r),
    );
  },

  costsBreakdown: (
    scope: 'session' | 'today' | 'month',
    conversationId?: string | null,
  ) => {
    const params = new URLSearchParams({ scope });
    if (conversationId) params.set('conversation_id', conversationId);
    return authedFetch(`/v1/costs/breakdown?${params.toString()}`).then((r) =>
      json<{
        ok: boolean;
        data: {
          scope: 'session' | 'today' | 'month';
          rows: Array<{
            model_id: string | null;
            model_name_snapshot: string | null;
            feature: string;
            sum_usd: number;
            count: number;
            success_count: number;
            billed_failure_count: number;
          }>;
        };
      }>(r),
    );
  },

  listConversations: () =>
    authedFetch('/v1/conversations').then((r) =>
      json<{
        conversations: Array<{
          id: string;
          title: string | null;
          type: string;
          created_at: number;
          updated_at: number;
          archived: boolean;
        }>;
      }>(r),
    ),
  getConversationMessages: (id: string) =>
    authedFetch(`/v1/conversations/${id}/messages`).then((r) =>
      json<{
        conversation: { id: string; title: string | null; created_at: number; updated_at: number };
        messages: Array<{
          id: string;
          conversation_id: string;
          role: 'user' | 'assistant' | 'system';
          content: string | null;
          model_id: string | null;
          status: string;
          error: string | null;
          created_at: number;
          attachments_count: number;
        }>;
      }>(r),
    ),
  renameConversation: (id: string, title: string | null) =>
    authedFetch(`/v1/conversations/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    }).then((r) =>
      json<{ id: string; title: string | null; updated_at: number }>(r),
    ),
  deleteConversation: (id: string) =>
    authedFetch(`/v1/conversations/${id}`, { method: 'DELETE' }).then((r) =>
      json<void>(r),
    ),
  // M2 §1.4 — persist a system note (e.g. auto-fallback notice) so it
  // survives reload and is visible to other clients of the same conversation.
  appendSystemMessage: (id: string, content: string) =>
    authedFetch(`/v1/conversations/${id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'system', content }),
    }).then((r) =>
      json<{ message: { id: string; role: 'system'; content: string; created_at: number } }>(r),
    ),
  testModel: (id: string) =>
    authedFetch(`/v1/models/${id}/test`, { method: 'POST' }).then((r) =>
      json<{
        ok: boolean;
        latency_ms?: number;
        note?: string;
        error?: { classification: string; message: string };
      }>(r),
    ),
  // M2.1 — three-tier scoped key/value (renderer-driven preferences).
  getMemoryEffective: (key: string, conversationId?: string | null) => {
    const qs = new URLSearchParams({ key });
    if (conversationId) qs.set('conversation_id', conversationId);
    return authedFetch(`/v1/memories/effective?${qs.toString()}`).then((r) =>
      json<{ ok: boolean; data: { key: string; value: string | null } }>(r),
    );
  },
  putMemory: (
    scope: 'global' | 'session' | 'user',
    key: string,
    value: string,
    scopeId?: string | null,
  ) =>
    authedFetch('/v1/memories', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope, scope_id: scopeId ?? null, key, value }),
    }).then((r) =>
      json<{ ok: boolean }>(r),
    ),
  clearAllData: () =>
    authedFetch('/v1/admin/clear-all-data', { method: 'POST' }).then((r) =>
      json<{
        ok: boolean;
        data: {
          sqlite_cleared: boolean;
          keystore_entries_removed: number;
          keystore_failures: string[];
        };
      }>(r),
    ),
  // M2.4 — capability tools.
  invokeTool: (
    name: string,
    input: unknown,
    opts: {
      conversation_id?: string | null;
      source_message_id?: string | null;
      forceImageResult?: 'success' | 'quota' | 'content_filter' | 'billed_4xx' | null;
    } = {},
  ) =>
    authedFetch('/v1/tools/invoke', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(opts.forceImageResult ? { 'x-test-force-image-result': opts.forceImageResult } : {}),
      },
      body: JSON.stringify({
        name,
        input,
        conversation_id: opts.conversation_id ?? null,
        source_message_id: opts.source_message_id ?? null,
      }),
    }).then((r) =>
      json<{
        ok: boolean;
        data: {
          ok: boolean;
          output?: { file_id: string; assistant_message_id: string; width: number; height: number; content_type: string };
          error?: { classification: string; message: string };
          cost?: { actual_usd: number };
        };
      }>(r),
    ),

  // M3.A — roundtable APIs (M3.A.4 wires create + GET; M3.A.5 wires round/summarize/export).
  createRoundtable: (input: { topic: string; mode?: RoundtableMode; conversation_id?: string }) =>
    authedFetch('/v1/roundtable', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }).then((r) =>
      json<{
        id: string;
        conversation_id: string;
        topic: string;
        mode: 'fast' | 'deep';
        participants: Participant[];
        summarizer_model_id: string | null;
        analyzer_fallback: boolean;
        status: string;
        current_round: number;
        estimated_cost_usd_low: number | null;
        estimated_cost_usd_high: number | null;
        created_at: number;
      }>(r),
    ),
  getRoundtable: (id: string) =>
    authedFetch(`/v1/roundtable/${id}`).then((r) =>
      json<{
        roundtable: Roundtable;
        messages: RoundtableMessage[];
        total_cost_usd: number;
      }>(r),
    ),
  getActiveRoundtableForConversation: (id: string) =>
    authedFetch(`/v1/conversations/${id}/roundtable`).then((r) =>
      json<{ roundtable_id: string | null }>(r),
    ),
};
