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
  ModelHealthRow,
  ModelCreate,
  ModelUpdate,
  ModelDiscoveryResponse,
  ModelCapability,
  Roundtable,
  RoundtableMode,
  RoundtableMessage,
  Participant,
  PromptTemplate,
  PromptTemplateCreate,
  PromptTemplateUpdate,
  Persona,
  PersonaCreate,
  PersonaUpdate,
  BackupConflictStrategy,
  BackupExportResponse,
  BackupImportResponse,
  BackupPackage,
  Tool,
  EffectiveTool,
  ConversationProfile,
  RunEvent,
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

  // B3 — selfcheck endpoint used by HelpCenter to verify local plumbing.
  selfCheck: () =>
    authedFetch('/v1/selfcheck').then((r) =>
      json<{
        ok: boolean;
        overall: 'ok' | 'warn' | 'error';
        checks: {
          id: 'sidecar' | 'keystore' | 'database' | 'default_model';
          ok: boolean;
          level: 'ok' | 'warn' | 'error';
          detail: string;
        }[];
      }>(r),
    ),

  listProviders: () =>
    authedFetch('/v1/providers').then((r) =>
      json<{ providers: Provider[] }>(r),
    ),
  providerKeyStatus: () =>
    authedFetch('/v1/providers/key-status').then((r) =>
      json<{ statuses: { provider_id: string; key_available: boolean }[] }>(r),
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
  modelsHealth: () =>
    authedFetch('/v1/models/health').then((r) =>
      json<{ rows: ModelHealthRow[] }>(r),
    ),
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
    scope: 'session' | 'today' | 'week' | 'month',
    conversationId?: string | null,
  ) => {
    const params = new URLSearchParams({ scope });
    if (conversationId) params.set('conversation_id', conversationId);
    return authedFetch(`/v1/costs/breakdown?${params.toString()}`).then((r) =>
      json<{
        ok: boolean;
        data: {
          scope: 'session' | 'today' | 'week' | 'month';
          group_by: 'model_feature' | 'model' | 'conversation' | 'feature';
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

  costsDashboardBreakdown: (
    scope: 'today' | 'week' | 'month',
    groupBy: 'model' | 'conversation' | 'feature',
  ) => {
    const params = new URLSearchParams({ scope, group_by: groupBy });
    return authedFetch(`/v1/costs/breakdown?${params.toString()}`).then((r) =>
      json<{
        ok: boolean;
        data: {
          scope: 'today' | 'week' | 'month';
          group_by: 'model' | 'conversation' | 'feature';
          rows: Array<{
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
          }>;
        };
      }>(r),
    );
  },

  costsCallLogs: (limit = 50) =>
    authedFetch(`/v1/costs/calls?limit=${encodeURIComponent(String(limit))}`).then((r) =>
      json<{
        ok: boolean;
        data: {
          rows: Array<{
            id: string;
            created_at: number;
            conversation_id: string | null;
            conversation_title: string | null;
            source_type: 'message' | 'roundtable_message' | 'topic_analyzer' | 'summarizer' | 'tool_call';
            source_id: string | null;
            feature: 'chat' | 'roundtable' | 'image' | 'tool_call';
            model_id: string | null;
            model_name_snapshot: string;
            provider_id: string | null;
            provider_name: string | null;
            provider_type: string | null;
            input_tokens: number | null;
            output_tokens: number | null;
            actual_cost_usd: number | null;
            success: boolean;
            classification: string | null;
            first_token_ms: number | null;
            duration_ms: number | null;
          }>;
        };
      }>(r),
    ),

  listConversations: (q?: string) => {
    const qs = q && q.trim().length > 0 ? `?q=${encodeURIComponent(q.trim())}` : '';
    return authedFetch(`/v1/conversations${qs}`).then((r) =>
      json<{
        conversations: Array<{
          id: string;
          title: string | null;
          type: string;
          created_at: number;
          updated_at: number;
          archived: boolean;
          pinned: boolean;
          tags: string | null;
        }>;
      }>(r),
    );
  },
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
          image_attachments: Array<{ file_id?: string; mime?: string; width?: number; height?: number }>;
        }>;
      }>(r),
    ),
  getConversationProfile: (id: string) =>
    authedFetch(`/v1/conversations/${id}/profile`).then((r) =>
      json<{ ok: boolean; data: ConversationProfile }>(r),
    ),
  getConversationRunEvents: (id: string, limit = 120) =>
    authedFetch(
      `/v1/conversations/${id}/run-events?limit=${encodeURIComponent(String(limit))}`,
    ).then((r) =>
      json<{ ok: boolean; data: { conversation_id: string; events: RunEvent[] } }>(r),
    ),
  getFileData: (fileId: string) =>
    authedFetch(`/v1/files/${fileId}/data`).then((r) =>
      json<{ ok: boolean; file_id: string; content_type: string; data_b64: string; size_bytes: number }>(r),
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
  // C4 — pin/unpin a conversation.
  setConversationPinned: (id: string, pinned: boolean) =>
    authedFetch(`/v1/conversations/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinned }),
    }).then((r) =>
      json<{ id: string; pinned: boolean; updated_at: number }>(r),
    ),
  // C4 — overwrite the tag list (max 3, trimmed server-side).
  setConversationTags: (id: string, tags: string[]) =>
    authedFetch(`/v1/conversations/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags }),
    }).then((r) =>
      json<{ id: string; tags: string | null; updated_at: number }>(r),
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
  // C1 — patch a user message (deletes everything that came after it).
  editUserMessage: (convId: string, msgId: string, content: string) =>
    authedFetch(`/v1/conversations/${convId}/messages/${msgId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    }).then((r) =>
      json<{ message: { id: string; role: string; content: string; created_at: number } }>(r),
    ),
  // C1 — fork a conversation at a specific message.
  branchConversationAtMessage: (
    convId: string,
    msgId: string,
    title?: string,
  ) =>
    authedFetch(`/v1/conversations/${convId}/messages/${msgId}/branch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(title ? { title } : {}),
    }).then((r) =>
      json<{
        conversation: { id: string; type: string; title: string | null; created_at: number; updated_at: number };
        copied_messages: number;
      }>(r),
    ),
  testModel: (id: string) =>
    authedFetch(`/v1/models/${id}/test`, { method: 'POST' }).then((r) =>
      json<{
        ok: boolean;
        latency_ms?: number;
        note?: string;
        tools_probe?: {
          supported: boolean | null;
          updated: boolean;
          classification?: string;
          message?: string;
        };
        error?: { classification: string; message: string };
      }>(r),
    ),
  // M2.1 — three-tier scoped key/value (renderer-driven preferences).
  getMemory: (
    scope: 'global' | 'session' | 'user',
    key: string,
    scopeId?: string | null,
  ) => {
    const qs = new URLSearchParams({ scope, key });
    if (scopeId) qs.set('scope_id', scopeId);
    return authedFetch(`/v1/memories?${qs.toString()}`).then((r) =>
      json<{
        ok: boolean;
        data: { scope: string; scope_id: string | null; key: string; value: string | null };
      }>(r),
    );
  },
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
  deleteMemory: (
    scope: 'global' | 'session' | 'user',
    key: string,
    scopeId?: string | null,
  ) => {
    const qs = new URLSearchParams({ scope, key });
    if (scopeId) qs.set('scope_id', scopeId);
    return authedFetch(`/v1/memories?${qs.toString()}`, {
      method: 'DELETE',
    }).then((r) => json<{ ok: boolean }>(r));
  },
  listPromptTemplates: () =>
    authedFetch('/v1/prompt-templates').then((r) =>
      json<{ prompt_templates: PromptTemplate[] }>(r),
    ),
  createPromptTemplate: (input: PromptTemplateCreate) =>
    authedFetch('/v1/prompt-templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }).then((r) => json<PromptTemplate>(r)),
  updatePromptTemplate: (id: string, patch: PromptTemplateUpdate) =>
    authedFetch(`/v1/prompt-templates/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }).then((r) => json<PromptTemplate>(r)),
  deletePromptTemplate: (id: string) =>
    authedFetch(`/v1/prompt-templates/${id}`, { method: 'DELETE' }).then((r) =>
      json<void>(r),
    ),
  listPersonas: () =>
    authedFetch('/v1/personas').then((r) =>
      json<{ personas: Persona[] }>(r),
    ),
  createPersona: (input: PersonaCreate) =>
    authedFetch('/v1/personas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }).then((r) => json<Persona>(r)),
  updatePersona: (id: string, patch: PersonaUpdate) =>
    authedFetch(`/v1/personas/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }).then((r) => json<Persona>(r)),
  deletePersona: (id: string) =>
    authedFetch(`/v1/personas/${id}`, { method: 'DELETE' }).then((r) =>
      json<void>(r),
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
  exportBackup: () =>
    authedFetch('/v1/admin/export-data').then((r) =>
      json<BackupExportResponse>(r),
    ),
  importBackup: (strategy: BackupConflictStrategy, backup: BackupPackage) =>
    authedFetch('/v1/admin/import-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ strategy, backup }),
    }).then((r) => json<BackupImportResponse>(r)),
  // M2.4 — capability tools.
  listTools: () =>
    authedFetch('/v1/tools').then((r) =>
      json<{ ok: boolean; data: Tool[] }>(r),
    ),
  listEffectiveTools: (conversationId?: string | null) => {
    const qs = conversationId
      ? `?conversation_id=${encodeURIComponent(conversationId)}`
      : '';
    return authedFetch(`/v1/tools/effective${qs}`).then((r) =>
      json<{ ok: boolean; data: EffectiveTool[] }>(r),
    );
  },
  setToolEnabled: (name: string, enabled: boolean) =>
    authedFetch(`/v1/tools/${encodeURIComponent(name)}/enabled`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled }),
    }).then((r) => json<{ ok: boolean; data: Tool }>(r)),
  setSessionToolEnabled: (
    name: string,
    conversationId: string,
    enabled: boolean | null,
  ) =>
    authedFetch(`/v1/tools/${encodeURIComponent(name)}/session-enabled`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversation_id: conversationId, enabled }),
    }).then((r) => json<{ ok: boolean; data: EffectiveTool }>(r)),
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
  createRoundtable: (input: {
    topic: string;
    mode?: RoundtableMode;
    conversation_id?: string;
    origin_conversation_id?: string;
    analyzer_model_id?: string;
    summarizer_model_id?: string;
  }) =>
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
        // A5 — launch preview metadata (always present, even on fallback).
        preview: {
          topic_type:
            | 'business'
            | 'technical'
            | 'creative'
            | 'decision'
            | 'research'
            | 'other'
            | null;
          complexity: 'low' | 'medium' | 'high' | null;
          requested_mode: 'fast' | 'deep' | 'auto';
          analyzer_chose_mode_reason: string | null;
          estimated_calls: number;
          estimated_duration_sec_low: number;
          estimated_duration_sec_high: number;
          alt_mode: 'fast' | 'deep';
          alt_estimated_cost_usd_low: number | null;
          alt_estimated_cost_usd_high: number | null;
          alt_estimated_calls: number;
          alt_estimated_duration_sec_low: number;
          alt_estimated_duration_sec_high: number;
        };
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

  // A1 — list candidate models a user can switch to when retrying a failed
  // participant. Includes the current model (first), the recommended fallback
  // (next non-demoted in fallback_order), and all other chat-capable models.
  getRoundtableRetryCandidates: (id: string, index: number) =>
    authedFetch(`/v1/roundtable/${id}/participant/${index}/retry-candidates`)
      .then((r) =>
        json<{
          roundtable_id: string;
          participant_index: number;
          current_model_id: string;
          recommended_model_id: string | null;
          candidates: Array<{
            model_id: string;
            display_name: string;
            model_name: string;
            provider_id: string | null;
            fallback_order: number;
            demoted: boolean;
            disabled: boolean;
            is_current: boolean;
            recommended: boolean;
            already_used_by_other_participant: boolean;
          }>;
        }>(r),
      ),

  // A3 — replace participants list (only allowed before round 1).
  putRoundtableParticipants: (
    id: string,
    participants: Array<{
      model_id: string;
      display_name: string;
      role_label: string;
      persona_prompt: string;
    }>,
  ) =>
    authedFetch(`/v1/roundtable/${id}/participants`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ participants }),
    }).then((r) => json<{ ok: true }>(r)),

  // A4 — write the final summary back into the original chat conversation as
  // an assistant message. Returns the conversation id that received the message
  // (might be a freshly minted one when the original origin was null/deleted).
  postRoundtableLoopback: (id: string) =>
    authedFetch(`/v1/roundtable/${id}/loopback`, { method: 'POST' }).then((r) =>
      json<{ conversation_id: string; message_id: string }>(r),
    ),

  // M2.5 §F-PR — manual catalog sync (price + capability refresh).
  catalogSync: (providerId?: string | null) =>
    authedFetch('/v1/catalog/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(providerId ? { provider_id: providerId } : {}),
    }).then((r) =>
      json<{
        ok: boolean;
        synced_at: number;
        total_providers: number;
        total_models: number;
        diffs: Array<{
          provider_id: string;
          model_name: string;
          display_name?: string | null;
          change: 'new' | 'price_changed' | 'unchanged' | 'removed';
          before?: { price_input_per_1m: number | null; price_output_per_1m: number | null; price_per_image: number | null };
          after?: { price_input_per_1m: number | null; price_output_per_1m: number | null; price_per_image: number | null };
        }>;
        errors: Array<{ provider_id: string; message: string }>;
      }>(r),
    ),
};
