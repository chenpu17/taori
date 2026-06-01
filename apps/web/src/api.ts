import type {
  ChatAttachment,
  DiscoveredModel,
  FileSearchRequest,
  FileSearchResult,
  HealthResponse,
  McpServer,
  McpServerLogEntry,
  Model,
  ModelCapability,
  Modality,
  Provider,
  ProviderType,
  QuickCompareAnnotation,
  QuickCompareExecutionMode,
  QuickCompareOutput,
  QuickComparePreviewReason,
  QuickCompareRun,
  ResearchClaim,
  ResearchOutputKind,
  ResearchPlan,
  ResearchSource,
  ResearchTask,
  ResearchSession,
  ResearchBudgetMode,
  Roundtable,
  RoundtableAnnotation,
  RoundtableLaunchPreview,
  RoundtableMessage,
  RoundtableMode,
  RoundtableSummary,
  Tool,
  ToolCapability,
  ToolHealthRow,
  OrchestrationAnnotation,
} from '@taori/shared';
import { authedFetch, getSidecarEndpoint } from './sidecar';

export type { ChatAttachment, DiscoveredModel } from '@taori/shared';

export class ApiError extends Error {
  readonly code?: string;
  readonly status?: number;
  readonly details?: Record<string, unknown>;

  constructor(message: string, code?: string, status?: number, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    const obj = body && typeof body === 'object' ? body as {
      message?: string;
      code?: string;
      details?: Record<string, unknown>;
      error?: { message?: string };
    } : {};
    throw new ApiError(
      obj.message ?? obj.error?.message ?? `${response.status} ${response.statusText}`,
      obj.code,
      response.status,
      obj.details,
    );
  }
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

function postBody(payload: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  };
}

export interface Conversation {
  id: string;
  type: string;
  title: string | null;
  created_at: number;
  updated_at: number;
  archived: boolean;
  pinned: boolean;
  tags: string | string[] | null;
}

export interface MessageAnnotation {
  type: string;
  message_id?: string;
  input_tokens?: number | null;
  cache_input_tokens?: number | null;
  output_tokens?: number | null;
  actual_usd?: number | null;
  first_token_ms?: number | null;
  event?: string;
  call_id?: string;
  tool?: string;
  label?: string;
  input?: string | null;
  output?: string | null;
  ok?: boolean | null;
  duration_ms?: number | null;
  run_id?: string;
  reason?: OrchestrationAnnotation['reason'];
  external_info?: OrchestrationAnnotation['external_info'];
  local_context?: OrchestrationAnnotation['local_context'];
  search_tool_name?: string | null;
  query_count?: number | null;
  fetch_top_k?: number | null;
  cite_required?: boolean | null;
  allow_model_tool_use?: boolean | null;
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
  image_attachments?: Array<{
    file_id?: string;
    mime?: string;
    width?: number;
    height?: number;
  }>;
  annotations: MessageAnnotation[];
}

export interface ChatRequest {
  conversation_id?: string;
  model_id: string;
  persona_id?: string;
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  attachments?: ChatAttachment[];
  skip_user_persist?: boolean;
  confirmed_cost?: boolean;
}

export type ChatStreamAnnotation =
  | {
      type: 'meta';
      conversation_id: string;
      message_id: string | null;
      model_id: string | null;
      run_id: string;
    }
  | {
      type: 'cost';
      message_id: string;
      input_tokens?: number | null;
      cache_input_tokens?: number | null;
      output_tokens?: number | null;
      actual_usd?: number | null;
      first_token_ms?: number | null;
      duration_ms?: number | null;
    }
  | {
      type: 'failure_decision';
      classification: string;
      recommended_model_id?: string | null;
      detail?: string;
    }
  | {
      type: 'capability_route';
      capability: string;
      prompt: string;
      user_message_id: string;
      conversation_id: string;
    }
  | {
      type: 'tool_trace';
      message_id: string;
      event: 'start' | 'finish';
      call_id: string;
      tool: string;
      label: string;
      input?: string | null;
      output?: string | null;
      ok?: boolean | null;
      duration_ms?: number | null;
    }
  | OrchestrationAnnotation
  | Record<string, unknown>;

export async function health(): Promise<HealthResponse> {
  return json<HealthResponse>(await authedFetch('/health'));
}

export async function listConversations(q?: string): Promise<Conversation[]> {
  const params = q ? `?q=${encodeURIComponent(q)}` : '';
  const response = await json<{ conversations: Conversation[] }>(
    await authedFetch(`/v1/conversations${params}`),
  );
  return response.conversations;
}

export async function getMessages(
  conversationId: string,
): Promise<{ conversation: Conversation; messages: ConversationMessage[] }> {
  return json(await authedFetch(`/v1/conversations/${conversationId}/messages`));
}

export async function patchConversation(
  id: string,
  patch: {
    title?: string | null;
    archived?: boolean;
    pinned?: boolean;
    tags?: string[];
  },
): Promise<Conversation> {
  return json(
    await authedFetch(`/v1/conversations/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  );
}

export async function deleteConversation(id: string): Promise<void> {
  const response = await authedFetch(`/v1/conversations/${id}`, { method: 'DELETE' });
  if (!response.ok) throw new ApiError(`删除失败：${response.status}`, undefined, response.status);
}

export async function editUserMessage(
  conversationId: string,
  messageId: string,
  content: string,
): Promise<{ message: { id: string; role: string; content: string; created_at: number } }> {
  return json(
    await authedFetch(`/v1/conversations/${conversationId}/messages/${messageId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    }),
  );
}

export async function branchConversation(
  conversationId: string,
  messageId: string,
  title?: string,
): Promise<{ conversation: Conversation; copied_messages: number }> {
  return json(
    await authedFetch(
      `/v1/conversations/${conversationId}/messages/${messageId}/branch`,
      postBody(title ? { title } : {}),
    ),
  );
}

export async function exportConversation(
  id: string,
  includeTimeline = true,
): Promise<string> {
  const response = await authedFetch(
    `/v1/conversations/${id}/export?format=markdown&include_timeline=${includeTimeline ? 'summary' : 'none'}`,
  );
  if (!response.ok) {
    throw new ApiError(`导出失败：${response.status}`, undefined, response.status);
  }
  return response.text();
}

export interface RunEvent {
  id?: string;
  run_id: string;
  conversation_id: string | null;
  message_id: string | null;
  kind: string;
  status: string;
  label: string | null;
  summary: string | null;
  payload?: unknown;
  created_at: number;
}

export async function getConversationRunEvents(
  conversationId: string,
  limit = 80,
): Promise<RunEvent[]> {
  const response = await json<{ ok: true; data: { events: RunEvent[] } }>(
    await authedFetch(`/v1/conversations/${conversationId}/run-events?limit=${limit}`),
  );
  return response.data.events;
}

export interface ConversationProfile {
  conversation_id: string;
  model?: unknown;
  persona?: unknown;
  tools?: unknown;
  attachments?: unknown;
  costs?: unknown;
  context_sources?: unknown[];
}

export async function getConversationProfile(conversationId: string): Promise<ConversationProfile> {
  return json(await authedFetch(`/v1/conversations/${conversationId}/profile`));
}

export async function listProviders(): Promise<Provider[]> {
  const response = await json<{ providers: Provider[] }>(await authedFetch('/v1/providers'));
  return response.providers;
}

export async function createProvider(input: {
  name: string;
  type: ProviderType;
  base_url: string;
  api_key?: string;
}): Promise<Provider> {
  return json(await authedFetch('/v1/providers', postBody(input)));
}

export async function patchProvider(
  id: string,
  patch: { name?: string; base_url?: string; api_key?: string; enabled?: boolean },
): Promise<Provider> {
  return json(
    await authedFetch(`/v1/providers/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  );
}

export async function deleteProvider(id: string): Promise<void> {
  const response = await authedFetch(`/v1/providers/${id}`, { method: 'DELETE' });
  if (!response.ok) throw new ApiError(`删除失败：${response.status}`, undefined, response.status);
}

export async function listProviderKeyStatus(confirmKeychain = false): Promise<Array<{
  provider_id: string;
  key_available: boolean;
}>> {
  const query = confirmKeychain ? '?confirm_keychain=1' : '';
  const response = await json<{ statuses: Array<{ provider_id: string; key_available: boolean }> }>(
    await authedFetch(`/v1/providers/key-status${query}`),
  );
  return response.statuses;
}

export async function deleteProviderKey(id: string): Promise<void> {
  const response = await authedFetch(`/v1/providers/${id}/key`, { method: 'DELETE' });
  if (!response.ok) throw new ApiError(`撤销 Key 失败：${response.status}`, undefined, response.status);
}

export async function testProvider(
  providerId: string,
): Promise<{ ok: boolean; sample_count?: number; error?: { classification: string; message: string } }> {
  return json(await authedFetch('/v1/providers/test', postBody({ provider_id: providerId })));
}

export interface DiscoveryResponse {
  provider_id: string;
  models: DiscoveredModel[];
  recommended: { chat: string | null; vision: string | null };
}

export async function discoverProvider(providerId: string): Promise<DiscoveryResponse> {
  return json(await authedFetch(`/v1/providers/${providerId}/discover`));
}

export async function catalogSync(providerId?: string): Promise<unknown> {
  return json(
    await authedFetch('/v1/catalog/sync', postBody(providerId ? { provider_id: providerId } : {})),
  );
}

export async function listModels(): Promise<Model[]> {
  const response = await json<{ models: Model[] }>(await authedFetch('/v1/models'));
  return response.models;
}

export async function createModel(input: {
  provider_id: string;
  model_name: string;
  display_name: string;
  capability: ModelCapability;
  is_default_for?: ModelCapability | null;
  price_input_per_1m?: number | null;
  price_output_per_1m?: number | null;
  price_per_call?: number | null;
  context_length?: number | null;
  modalities?: Modality[];
  supports_vision?: boolean;
  supports_tools?: boolean;
  supports_json?: boolean;
}): Promise<Model> {
  return json(await authedFetch('/v1/models', postBody(input)));
}

export async function patchModel(id: string, patch: Partial<Model>): Promise<Model> {
  return json(
    await authedFetch(`/v1/models/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  );
}

export async function deleteModel(id: string): Promise<void> {
  const response = await authedFetch(`/v1/models/${id}`, { method: 'DELETE' });
  if (!response.ok) throw new ApiError(`删除失败：${response.status}`, undefined, response.status);
}

export async function setModelDefault(id: string, capability: ModelCapability): Promise<Model> {
  return json(await authedFetch(`/v1/models/${id}/default`, postBody({ capability })));
}

export async function resetModelHealth(id: string): Promise<Model> {
  return json(await authedFetch(`/v1/models/${id}/reset-health`, postBody({})));
}

export interface ModelHealthRow {
  model_id: string;
  calls_24h: number;
  failures_24h: number;
  avg_first_token_ms: number | null;
  avg_duration_ms: number | null;
  last_failure_at: number | null;
  last_failure_classification: string | null;
}

export async function listModelHealth(): Promise<ModelHealthRow[]> {
  const response = await json<{ rows: ModelHealthRow[] }>(await authedFetch('/v1/models/health'));
  return response.rows;
}

export async function testModel(id: string): Promise<{
  ok: boolean;
  latency_ms?: number;
  note?: string;
  error?: { classification: string; message: string };
  tools_probe?: {
    supported: boolean | null;
    updated: boolean;
    classification?: string;
    message?: string;
  };
}> {
  return json(await authedFetch(`/v1/models/${id}/test`, postBody({})));
}

export async function recommendModels(input: {
  capability?: ModelCapability;
  task?: 'general' | 'coding' | 'fast' | 'cheap' | 'long_context' | 'vision';
  require_tools?: boolean;
  require_vision?: boolean;
  current_model_id?: string;
  limit?: number;
}): Promise<{
  task: string;
  recommended_model_id: string | null;
  recommendations: Array<{
    model_id: string;
    score: number;
    confidence: 'low' | 'medium' | 'high';
    reasons: string[];
    tradeoffs: string[];
    health: ModelHealthRow;
  }>;
}> {
  return json(await authedFetch('/v1/models/recommendations', postBody(input)));
}

export async function reorderModels(
  capability: ModelCapability,
  orderedIds: string[],
): Promise<{ capability: ModelCapability; models: Model[] }> {
  return json(
    await authedFetch('/v1/models/reorder', postBody({ capability, ordered_ids: orderedIds })),
  );
}

export interface ResumeState {
  run_id: string;
  conversation_id: string | null;
  assistant_message_id: string | null;
  message_status: string | null;
  can_continue: boolean;
  recommended_action: 'continue' | 'retry' | 'switch_model' | 'none';
  reason: string | null;
}

export async function getRunResumeState(runId: string): Promise<ResumeState> {
  const response = await json<{ ok: true; data: ResumeState }>(
    await authedFetch(`/v1/runs/${runId}/resume-state`),
  );
  return response.data;
}

function normalizeStreamError(payload: string): string {
  try {
    const parsed = JSON.parse(payload) as unknown;
    return typeof parsed === 'string' ? parsed : payload;
  } catch {
    return payload;
  }
}

async function consumeDataStream<TAnnotation>(
  response: Response,
  handlers: {
    onText?: (text: string) => void;
    onAnnotation?: (items: TAnnotation[]) => void;
    onDone?: () => void;
    onError?: (error: Error) => void;
  },
): Promise<void> {
  if (!response.ok || !response.body) {
    let detail = `${response.status}`;
    try {
      const body = await response.json() as { message?: string; error?: { message?: string } };
      detail = body.message ?? body.error?.message ?? detail;
    } catch {
      // ignore
    }
    handlers.onError?.(new Error(`请求失败：${detail}`));
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let providerError: string | null = null;

  try {
    const handleLine = (line: string): boolean => {
      if (line.length < 3 || line[1] !== ':') return false;
      const code = line[0];
      const payload = line.slice(2);
      if (code === '0') {
        const text = JSON.parse(payload) as string;
        if (text) handlers.onText?.(text);
      } else if (code === '8') {
        const items = JSON.parse(payload) as TAnnotation[];
        if (Array.isArray(items)) handlers.onAnnotation?.(items);
      } else if (code === '3') {
        providerError = normalizeStreamError(payload);
      } else if (code === 'd') {
        const finish = JSON.parse(payload) as { finishReason?: string };
        if (finish.finishReason === 'error') {
          handlers.onError?.(new Error(providerError ?? '流式请求失败'));
        } else {
          handlers.onDone?.();
        }
        return true;
      }
      return false;
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (handleLine(line)) return;
      }
    }
    buffer += decoder.decode();
    if (buffer.trim() && handleLine(buffer.trim())) return;
    if (providerError) handlers.onError?.(new Error(providerError));
    else handlers.onDone?.();
  } catch (error) {
    if ((error as Error).name !== 'AbortError') {
      handlers.onError?.(error as Error);
    }
  } finally {
    buffer = '';
    try {
      reader.releaseLock();
    } catch {
      // The lock may already be released after cancellation.
    }
  }
}

interface StreamOptions {
  signal?: AbortSignal;
}

function bindAbortSignal(controller: AbortController, signal?: AbortSignal): () => void {
  if (!signal) return () => undefined;
  const abort = (): void => controller.abort();
  if (signal.aborted) {
    controller.abort();
    return () => undefined;
  }
  signal.addEventListener('abort', abort, { once: true });
  return () => signal.removeEventListener('abort', abort);
}

export async function streamChat(
  request: ChatRequest,
  handlers: {
    onText: (text: string) => void;
    onAnnotation: (items: ChatStreamAnnotation[]) => void;
    onDone: () => void;
    onError: (error: Error) => void;
  },
  options: StreamOptions = {},
): Promise<() => void> {
  const endpoint = await getSidecarEndpoint();
  const controller = new AbortController();
  const unbindAbortSignal = bindAbortSignal(controller, options.signal);
  const response = await fetch(`${endpoint.url}/v1/chat`, {
    method: 'POST',
    credentials: 'include',
    signal: controller.signal,
    headers: {
      'Content-Type': 'application/json',
      ...(endpoint.bearer ? { Authorization: `Bearer ${endpoint.bearer}` } : {}),
    },
    body: JSON.stringify(request),
  }).catch((error: unknown) => {
    if ((error as Error).name !== 'AbortError') handlers.onError(error as Error);
    return null;
  });
  if (response) {
    void consumeDataStream<ChatStreamAnnotation>(response, handlers).finally(unbindAbortSignal);
  } else {
    unbindAbortSignal();
  }
  return () => {
    unbindAbortSignal();
    controller.abort();
  };
}

export async function streamRunContinue(
  runId: string,
  request: { confirmed_cost?: boolean },
  handlers: {
    onText: (text: string) => void;
    onAnnotation: (items: ChatStreamAnnotation[]) => void;
    onDone: () => void;
    onError: (error: Error) => void;
  },
  options?: StreamOptions,
): Promise<() => void> {
  return streamRunEndpoint(`/v1/runs/${runId}/continue`, request, handlers, options);
}

export async function streamRunRecover(
  runId: string,
  request: {
    action: 'continue' | 'retry_same_model' | 'switch_model' | 'skip_tool' | 'compact_context';
    model_id?: string | null;
    tool_name?: string | null;
    confirmed_cost?: boolean;
  },
  handlers: {
    onText: (text: string) => void;
    onAnnotation: (items: ChatStreamAnnotation[]) => void;
    onDone: () => void;
    onError: (error: Error) => void;
  },
  options?: StreamOptions,
): Promise<() => void> {
  return streamRunEndpoint(`/v1/runs/${runId}/recover`, request, handlers, options);
}

export interface QuickCompareState {
  compare: QuickCompareRun;
  outputs: QuickCompareOutput[];
}

export async function streamQuickCompare(
  request: {
    conversation_id?: string;
    messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
    model_ids?: string[];
    participant_configs?: Array<{ model_id: string; tool_names?: string[] }>;
    attachments?: ChatAttachment[];
    persona_id?: string | null;
    confirmed_cost?: boolean;
  },
  handlers: {
    onAnnotation: (items: QuickCompareAnnotation[]) => void;
    onDone: () => void;
    onError: (error: Error) => void;
  },
  options?: StreamOptions,
): Promise<() => void> {
  return streamEndpoint('/v1/quick-compare', request, handlers, options);
}

export async function getQuickCompare(id: string): Promise<QuickCompareState> {
  const response = await json<{ ok: true; data: QuickCompareState }>(
    await authedFetch(`/v1/quick-compare/${id}`),
  );
  return response.data;
}

export async function adoptQuickCompareOutput(
  compareId: string,
  outputId: string,
  replaceMessageId?: string | null,
): Promise<{
  compare_id: string;
  output_id: string;
  conversation_id: string;
  assistant_message_id: string;
}> {
  const response = await json<{
    ok: true;
    data: {
      compare_id: string;
      output_id: string;
      conversation_id: string;
      assistant_message_id: string;
    };
  }>(
    await authedFetch(
      `/v1/quick-compare/${compareId}/outputs/${outputId}/adopt`,
      postBody({ replace_message_id: replaceMessageId ?? null }),
    ),
  );
  return response.data;
}

export async function streamQuickCompareRetry(
  compareId: string,
  request: { output_id?: string; model_id?: string; confirmed_cost?: boolean },
  handlers: {
    onAnnotation: (items: QuickCompareAnnotation[]) => void;
    onDone: () => void;
    onError: (error: Error) => void;
  },
  options?: StreamOptions,
): Promise<() => void> {
  return streamEndpoint(`/v1/quick-compare/${compareId}/retry`, request, handlers, options);
}

export interface RoundtableDetail {
  roundtable: Roundtable;
  messages: RoundtableMessage[];
  total_cost_usd: number;
}

export interface CreateRoundtableResponse {
  id: string;
  conversation_id: string;
  topic: string;
  mode: Roundtable['mode'];
  participants: Roundtable['participants'];
  summarizer_model_id: string | null;
  analyzer_fallback: boolean;
  status: Roundtable['status'];
  current_round: number;
  estimated_cost_usd_low: number | null;
  estimated_cost_usd_high: number | null;
  created_at: number;
  preview?: RoundtableLaunchPreview;
}

export async function createRoundtable(input: {
  conversation_id?: string;
  origin_conversation_id?: string;
  topic: string;
  mode?: RoundtableMode;
  analyzer_model_id?: string;
  summarizer_model_id?: string;
}): Promise<CreateRoundtableResponse> {
  return json(await authedFetch('/v1/roundtable', postBody(input)));
}

export async function getRoundtable(id: string): Promise<RoundtableDetail> {
  return json(await authedFetch(`/v1/roundtable/${id}`));
}

export async function getConversationRoundtable(
  conversationId: string,
): Promise<{ roundtable_id: string | null }> {
  return json(await authedFetch(`/v1/conversations/${conversationId}/roundtable`));
}

export async function streamRoundtableRound(
  roundtableId: string,
  handlers: {
    onAnnotation: (items: RoundtableAnnotation[]) => void;
    onDone: () => void;
    onError: (error: Error) => void;
  },
  options?: StreamOptions,
): Promise<() => void> {
  return streamEndpoint(`/v1/roundtable/${roundtableId}/round`, {}, handlers, options);
}

export async function streamRoundtableSummarize(
  roundtableId: string,
  handlers: {
    onAnnotation: (items: RoundtableAnnotation[]) => void;
    onDone: () => void;
    onError: (error: Error) => void;
  },
  options?: StreamOptions,
): Promise<() => void> {
  return streamEndpoint(`/v1/roundtable/${roundtableId}/summarize`, {}, handlers, options);
}

export async function loopbackRoundtable(
  roundtableId: string,
): Promise<{ conversation_id: string; message_id: string }> {
  return json(await authedFetch(`/v1/roundtable/${roundtableId}/loopback`, postBody({})));
}

export async function exportRoundtable(roundtableId: string): Promise<string> {
  const response = await authedFetch(`/v1/roundtable/${roundtableId}/export`);
  if (!response.ok) throw new ApiError(`圆桌导出失败：${response.status}`, undefined, response.status);
  return response.text();
}

export interface ResearchDetail {
  session: ResearchSession;
  tasks: ResearchTask[];
  sources: ResearchSource[];
  claims: ResearchClaim[];
}

export async function listResearchSessions(): Promise<ResearchSession[]> {
  const response = await json<{ research_sessions: ResearchSession[] }>(
    await authedFetch('/v1/research/sessions'),
  );
  return response.research_sessions;
}

export async function createResearchSession(input: {
  conversation_id?: string | null;
  title: string;
  objective: string;
  output_kind?: ResearchOutputKind;
  budget_mode?: ResearchBudgetMode;
  budget_limit_usd?: number | null;
  preferred_model_id?: string | null;
  preferred_search_tool?: string | null;
  synthesis_model_id?: string | null;
}): Promise<ResearchSession> {
  return json(await authedFetch('/v1/research/sessions', postBody(input)));
}

export async function getResearchSession(id: string): Promise<ResearchDetail> {
  return json(await authedFetch(`/v1/research/sessions/${id}`));
}

export async function reviseResearchPlan(id: string, feedback: string): Promise<ResearchDetail> {
  return json(await authedFetch(`/v1/research/sessions/${id}/plan/revise`, postBody({ feedback })));
}

export async function startResearchSession(id: string, confirm = true): Promise<ResearchDetail> {
  return json(await authedFetch(`/v1/research/sessions/${id}/start`, postBody({ confirm })));
}

export async function pauseResearchSession(id: string): Promise<ResearchDetail> {
  return json(await authedFetch(`/v1/research/sessions/${id}/pause`, postBody({})));
}

export async function resumeResearchSession(id: string): Promise<ResearchDetail> {
  return json(await authedFetch(`/v1/research/sessions/${id}/resume`, postBody({})));
}

export async function cancelResearchSession(id: string): Promise<ResearchDetail> {
  return json(await authedFetch(`/v1/research/sessions/${id}/cancel`, postBody({})));
}

export async function exportResearchSession(
  id: string,
  format: 'json' | 'markdown' = 'markdown',
): Promise<{ filename: string; content_type: string; content: string }> {
  return json(await authedFetch(`/v1/research/sessions/${id}/export`, postBody({ format })));
}

export async function searchFiles(input: FileSearchRequest): Promise<FileSearchResult[]> {
  const response = await json<{ ok: true; data: { results: FileSearchResult[] } }>(
    await authedFetch('/v1/files/search', postBody(input)),
  );
  return response.data.results;
}

export async function getFileData(id: string): Promise<{
  ok: true;
  file_id: string;
  content_type: string;
  data_b64: string;
  size_bytes: number;
}> {
  return json(await authedFetch(`/v1/files/${id}/data`));
}

export interface EffectiveTool extends Tool {
  session_enabled: boolean | null;
  effective_enabled: boolean;
}

export async function listTools(): Promise<Tool[]> {
  const response = await json<{ ok: true; data: Tool[] }>(await authedFetch('/v1/tools'));
  return response.data;
}

export async function listToolHealth(): Promise<ToolHealthRow[]> {
  const response = await json<{ ok: true; rows: ToolHealthRow[] }>(
    await authedFetch('/v1/tools/health'),
  );
  return response.rows;
}

export async function listEffectiveTools(conversationId?: string | null): Promise<EffectiveTool[]> {
  const query = conversationId ? `?conversation_id=${encodeURIComponent(conversationId)}` : '';
  const response = await json<{ ok: true; data: EffectiveTool[] }>(
    await authedFetch(`/v1/tools/effective${query}`),
  );
  return response.data;
}

export async function setToolEnabled(name: string, enabled: boolean): Promise<Tool> {
  const response = await json<{ ok: true; data: Tool }>(
    await authedFetch(`/v1/tools/${encodeURIComponent(name)}/enabled`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    }),
  );
  return response.data;
}

export async function setSessionToolEnabled(
  name: string,
  conversationId: string,
  enabled: boolean | null,
): Promise<EffectiveTool> {
  const response = await json<{ ok: true; data: EffectiveTool }>(
    await authedFetch(`/v1/tools/${encodeURIComponent(name)}/session-enabled`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversation_id: conversationId, enabled }),
    }),
  );
  return response.data;
}

export async function invokeTool(input: {
  name: string;
  input: unknown;
  conversation_id?: string | null;
  source_message_id?: string | null;
}): Promise<{
  ok: boolean;
  output?: unknown;
  error?: { classification: string; message: string };
  cost?: { estimated_usd?: number; actual_usd?: number; tokens_in?: number; tokens_out?: number };
}> {
  const response = await json<{
    ok: boolean;
    data?: {
      ok: boolean;
      output?: unknown;
      error?: { classification: string; message: string };
      cost?: { estimated_usd?: number; actual_usd?: number; tokens_in?: number; tokens_out?: number };
    };
    error?: { classification?: string; message?: string };
  }>(await authedFetch('/v1/tools/invoke', postBody(input)));
  if (!response.data) {
    return {
      ok: false,
      error: {
        classification: response.error?.classification ?? 'tool_error',
        message: response.error?.message ?? '工具调用失败',
      },
    };
  }
  return response.data;
}

export async function listMcpServers(): Promise<McpServer[]> {
  const response = await json<{ ok: true; servers: McpServer[] }>(
    await authedFetch('/v1/mcp/servers'),
  );
  return response.servers;
}

export async function createMcpServer(input: {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
}): Promise<McpServer> {
  const response = await json<{ ok: true; server: McpServer }>(
    await authedFetch('/v1/mcp/servers', postBody({ transport: 'stdio', ...input })),
  );
  return response.server;
}

export async function deleteMcpServer(id: string): Promise<void> {
  const response = await authedFetch(`/v1/mcp/servers/${id}`, { method: 'DELETE' });
  if (!response.ok) throw new ApiError(`删除 MCP 失败：${response.status}`, undefined, response.status);
}

export async function refreshMcpServer(id: string): Promise<{
  ok: boolean;
  server: McpServer;
  tools: Array<{ name: string; description: string }>;
}> {
  return json(await authedFetch(`/v1/mcp/servers/${id}/refresh`, postBody({})));
}

export async function restartMcpServer(id: string): Promise<{
  ok: boolean;
  server: McpServer;
  tools: Array<{ name: string; description: string }>;
}> {
  return json(await authedFetch(`/v1/mcp/servers/${id}/restart`, postBody({})));
}

export async function getMcpRuntime(id: string): Promise<{
  ok: true;
  server: McpServer;
  session_running: boolean;
  tools: Array<{ name: string; description: string }>;
  logs: McpServerLogEntry[];
}> {
  return json(await authedFetch(`/v1/mcp/servers/${id}/runtime`));
}

export type {
  FileSearchResult,
  McpServer,
  QuickCompareAnnotation,
  QuickCompareExecutionMode,
  QuickCompareOutput,
  QuickComparePreviewReason,
  QuickCompareRun,
  ResearchPlan,
  ResearchSession,
  Roundtable,
  RoundtableAnnotation,
  RoundtableMessage,
  RoundtableSummary,
  Tool,
  ToolCapability,
  ToolHealthRow,
};

/* ============================================================
 * Costs
 * ========================================================== */

export interface CostsRealtime {
  current_conversation_usd: number;
  current_conversation_calls: number;
  today_usd: number;
  month_usd: number;
  currency_display?: string;
}

export type CostsBreakdownScope = 'session' | 'today' | 'week' | 'month';
export type CostsGroupBy = 'model_feature' | 'model' | 'conversation' | 'feature' | 'tag';

export interface CostsBreakdownRow {
  label?: string;
  model_id?: string;
  feature?: string;
  conversation_id?: string;
  conversation_title?: string;
  total_usd?: number;
  calls?: number;
  [key: string]: unknown;
}

export interface CostsCallLog {
  id: string;
  created_at: number;
  conversation_id: string | null;
  conversation_title: string | null;
  source_type: string;
  feature: string | null;
  model_id: string | null;
  model_name_snapshot: string | null;
  provider_id: string | null;
  provider_name: string | null;
  input_tokens: number | null;
  cache_input_tokens: number | null;
  output_tokens: number | null;
  actual_cost_usd: number | null;
  success: boolean | null;
  classification: string | null;
  first_token_ms: number | null;
  duration_ms: number | null;
}

export async function getCostsRealtime(conversationId?: string | null): Promise<CostsRealtime> {
  const q = conversationId ? `?conversation_id=${encodeURIComponent(conversationId)}` : '';
  const response = await json<{ ok: true; data: CostsRealtime }>(
    await authedFetch(`/v1/costs/realtime${q}`),
  );
  return response.data;
}

export async function getCostsBreakdown(
  scope: CostsBreakdownScope,
  groupBy: CostsGroupBy = 'model',
  conversationId?: string,
): Promise<{ scope: CostsBreakdownScope; group_by: CostsGroupBy; rows: CostsBreakdownRow[] }> {
  const params = new URLSearchParams({ scope, group_by: groupBy });
  if (conversationId) params.set('conversation_id', conversationId);
  const response = await json<{
    ok: true;
    data: { scope: CostsBreakdownScope; group_by: CostsGroupBy; rows: CostsBreakdownRow[] };
  }>(await authedFetch(`/v1/costs/breakdown?${params.toString()}`));
  return response.data;
}

export async function listCostsCalls(limit = 50): Promise<CostsCallLog[]> {
  const response = await json<{ ok: true; data: { rows: CostsCallLog[] } }>(
    await authedFetch(`/v1/costs/calls?limit=${limit}`),
  );
  return response.data.rows;
}

/* ============================================================
 * Prompt Templates & Personas
 * ========================================================== */

export interface PromptTemplate {
  id: string;
  name: string;
  description: string | null;
  content: string;
  created_at: number;
  updated_at: number;
}

export interface Persona {
  id: string;
  name: string;
  description: string | null;
  prompt: string;
  created_at: number;
  updated_at: number;
}

export async function listPromptTemplates(): Promise<PromptTemplate[]> {
  const response = await json<{ prompt_templates: PromptTemplate[] }>(
    await authedFetch('/v1/prompt-templates'),
  );
  return response.prompt_templates;
}

export async function createPromptTemplate(input: {
  name: string;
  description?: string | null;
  content: string;
}): Promise<PromptTemplate> {
  return json(await authedFetch('/v1/prompt-templates', postBody(input)));
}

export async function deletePromptTemplate(id: string): Promise<void> {
  const response = await authedFetch(`/v1/prompt-templates/${id}`, { method: 'DELETE' });
  if (!response.ok) throw new ApiError(`删除模板失败：${response.status}`, undefined, response.status);
}

export async function listPersonas(): Promise<Persona[]> {
  const response = await json<{ personas: Persona[] }>(await authedFetch('/v1/personas'));
  return response.personas;
}

export async function createPersona(input: {
  name: string;
  description?: string | null;
  prompt: string;
}): Promise<Persona> {
  return json(await authedFetch('/v1/personas', postBody(input)));
}

export async function deletePersona(id: string): Promise<void> {
  const response = await authedFetch(`/v1/personas/${id}`, { method: 'DELETE' });
  if (!response.ok) throw new ApiError(`删除人格失败：${response.status}`, undefined, response.status);
}

/* ============================================================
 * Memories
 * ========================================================== */

export type MemoryScope = 'global' | 'session' | 'user';

export interface MemoryRow {
  scope: MemoryScope;
  scope_id: string | null;
  key: string;
  value: string | null;
}

export interface StructuredMemory {
  id: string;
  scope: string;
  scope_id: string | null;
  kind: string;
  key: string;
  value: string;
  enabled: boolean;
  created_at: number;
  updated_at: number;
  deleted_at?: number | null;
}

export async function getMemory(scope: MemoryScope, key: string, scopeId?: string): Promise<MemoryRow> {
  const params = new URLSearchParams({ scope, key });
  if (scopeId) params.set('scope_id', scopeId);
  const response = await json<{ ok: true; data: MemoryRow }>(
    await authedFetch(`/v1/memories?${params.toString()}`),
  );
  return response.data;
}

export async function putMemory(input: {
  scope: MemoryScope;
  scope_id?: string | null;
  key: string;
  value: string;
}): Promise<MemoryRow> {
  const response = await json<{ ok: true; data: MemoryRow }>(
    await authedFetch('/v1/memories', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  );
  return response.data;
}

export async function deleteMemory(scope: MemoryScope, key: string, scopeId?: string): Promise<void> {
  const params = new URLSearchParams({ scope, key });
  if (scopeId) params.set('scope_id', scopeId);
  const response = await authedFetch(`/v1/memories?${params.toString()}`, { method: 'DELETE' });
  if (!response.ok) throw new ApiError(`删除记忆失败：${response.status}`, undefined, response.status);
}

export async function listStructuredMemories(includeDisabled = false): Promise<StructuredMemory[]> {
  const params = new URLSearchParams();
  if (includeDisabled) params.set('include_disabled', '1');
  const response = await json<{ ok: true; data: { memories: StructuredMemory[] } }>(
    await authedFetch(`/v1/structured-memories?${params.toString()}`),
  );
  return response.data.memories;
}

export async function setStructuredMemoryEnabled(id: string, enabled: boolean): Promise<StructuredMemory> {
  const response = await json<{ ok: true; data: StructuredMemory }>(
    await authedFetch(`/v1/structured-memories/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    }),
  );
  return response.data;
}

export async function deleteStructuredMemory(id: string): Promise<void> {
  const response = await authedFetch(`/v1/structured-memories/${id}`, { method: 'DELETE' });
  if (!response.ok) throw new ApiError(`删除结构化记忆失败：${response.status}`, undefined, response.status);
}

/* ============================================================
 * Diagnostics / self-check / admin
 * ========================================================== */

export interface SelfCheckResult {
  ok: boolean;
  overall?: 'ok' | 'warn' | 'error';
  checks?: Array<{
    id: string;
    name?: string;
    ok: boolean;
    detail?: string;
    level?: 'ok' | 'warn' | 'error';
  }>;
  [key: string]: unknown;
}

export async function runSelfCheck(): Promise<SelfCheckResult> {
  return json(await authedFetch('/v1/selfcheck'));
}

export async function getDiagnosticsRuntime(): Promise<unknown> {
  return json(await authedFetch('/v1/diagnostics/runtime'));
}

export async function adminExportData(): Promise<string> {
  const response = await authedFetch('/v1/admin/export-data');
  if (!response.ok) {
    throw new ApiError(`导出失败：${response.status}`, undefined, response.status);
  }
  return response.text();
}

export async function adminClearAllData(): Promise<void> {
  const response = await authedFetch('/v1/admin/clear-all-data', { method: 'POST' });
  if (!response.ok) throw new ApiError(`清空失败：${response.status}`, undefined, response.status);
}

export async function adminImportData(payload: string): Promise<unknown> {
  return json(
    await authedFetch('/v1/admin/import-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    }),
  );
}

/* ============================================================
 * Research subresource lists (sources / tasks / claims)
 * ========================================================== */

export async function listResearchSources(id: string): Promise<unknown[]> {
  const response = await json<{ ok?: boolean; sources?: unknown[]; data?: { sources?: unknown[] } }>(
    await authedFetch(`/v1/research/sessions/${id}/sources`),
  );
  return response.sources ?? response.data?.sources ?? [];
}

export async function listResearchTasks(id: string): Promise<unknown[]> {
  const response = await json<{ ok?: boolean; tasks?: unknown[]; data?: { tasks?: unknown[] } }>(
    await authedFetch(`/v1/research/sessions/${id}/tasks`),
  );
  return response.tasks ?? response.data?.tasks ?? [];
}

export async function listResearchClaims(id: string): Promise<unknown[]> {
  const response = await json<{ ok?: boolean; claims?: unknown[]; data?: { claims?: unknown[] } }>(
    await authedFetch(`/v1/research/sessions/${id}/claims`),
  );
  return response.claims ?? response.data?.claims ?? [];
}

async function streamRunEndpoint(
  path: string,
  request: unknown,
  handlers: {
    onText: (text: string) => void;
    onAnnotation: (items: ChatStreamAnnotation[]) => void;
    onDone: () => void;
    onError: (error: Error) => void;
  },
  options: StreamOptions = {},
): Promise<() => void> {
  const endpoint = await getSidecarEndpoint();
  const controller = new AbortController();
  const unbindAbortSignal = bindAbortSignal(controller, options.signal);
  const response = await fetch(`${endpoint.url}${path}`, {
    method: 'POST',
    credentials: 'include',
    signal: controller.signal,
    headers: {
      'Content-Type': 'application/json',
      ...(endpoint.bearer ? { Authorization: `Bearer ${endpoint.bearer}` } : {}),
    },
    body: JSON.stringify(request),
  }).catch((error: unknown) => {
    if ((error as Error).name !== 'AbortError') handlers.onError(error as Error);
    return null;
  });
  if (response) {
    void consumeDataStream<ChatStreamAnnotation>(response, handlers).finally(unbindAbortSignal);
  } else {
    unbindAbortSignal();
  }
  return () => {
    unbindAbortSignal();
    controller.abort();
  };
}

async function streamEndpoint<TAnnotation>(
  path: string,
  request: unknown,
  handlers: {
    onAnnotation: (items: TAnnotation[]) => void;
    onDone: () => void;
    onError: (error: Error) => void;
  },
  options: StreamOptions = {},
): Promise<() => void> {
  const endpoint = await getSidecarEndpoint();
  const controller = new AbortController();
  const unbindAbortSignal = bindAbortSignal(controller, options.signal);
  const response = await fetch(`${endpoint.url}${path}`, {
    method: 'POST',
    credentials: 'include',
    signal: controller.signal,
    headers: {
      'Content-Type': 'application/json',
      ...(endpoint.bearer ? { Authorization: `Bearer ${endpoint.bearer}` } : {}),
    },
    body: JSON.stringify(request),
  }).catch((error: unknown) => {
    if ((error as Error).name !== 'AbortError') handlers.onError(error as Error);
    return null;
  });
  if (response) {
    void consumeDataStream<TAnnotation>(response, {
      onAnnotation: handlers.onAnnotation,
      onDone: handlers.onDone,
      onError: handlers.onError,
    }).finally(unbindAbortSignal);
  } else {
    unbindAbortSignal();
  }
  return () => {
    unbindAbortSignal();
    controller.abort();
  };
}
