import { eq, and, isNotNull, asc, desc, sql } from 'drizzle-orm';
import { type Db } from '../index.js';
import { cost_records, models, providers, conversations, run_events } from '../schema.js';
import type {
  ErrorClassification,
  ModelHealthRow,
  ToolErrorClassification,
  ToolHealthRow,
  RunEventKind,
} from '@taori/shared';
import type { RunEvent } from '@taori/shared';
import { makeId } from '@taori/shared';
import { parseConversationTags } from './mappers.js';

export interface CostInsert {
  conversation_id: string | null;
  source_type: 'message' | 'roundtable_message' | 'topic_analyzer' | 'summarizer' | 'tool_call' | 'quick_compare_output';
  source_id: string | null;
  feature: 'chat' | 'roundtable' | 'image' | 'tool_call' | 'quick_compare';
  model_id: string | null;
  model_name_snapshot: string;
  input_tokens: number | null;
  cache_input_tokens?: number | null;
  output_tokens: number | null;
  call_count?: number;
  price_input_per_1m_snapshot: number | null;
  price_output_per_1m_snapshot: number | null;
  price_per_call_snapshot: number | null;
  estimated_cost_usd: number | null;
  actual_cost_usd: number | null;
  success: boolean;
  classification?: ErrorClassification | ToolErrorClassification | null;
  first_token_ms?: number | null;
  duration_ms: number | null;
}

export interface CostRecord extends CostInsert {
  id: string;
  call_count: number;
  created_at: number;
}

export interface CostCallLogRow {
  id: string;
  created_at: number;
  conversation_id: string | null;
  conversation_title: string | null;
  source_type: CostInsert['source_type'];
  source_id: string | null;
  feature: CostInsert['feature'];
  model_id: string | null;
  model_name_snapshot: string;
  provider_id: string | null;
  provider_name: string | null;
  provider_type: string | null;
  input_tokens: number | null;
  cache_input_tokens: number | null;
  output_tokens: number | null;
  actual_cost_usd: number | null;
  success: boolean;
  classification: ErrorClassification | ToolErrorClassification | null;
  first_token_ms: number | null;
  duration_ms: number | null;
  run_id: string | null;
  run_event_id: string | null;
  run_event_kind: RunEventKind | null;
  run_event_label: string | null;
}

function toRunEvent(row: { id: string; run_id: string; conversation_id: string | null; message_id: string | null; kind: string; status: string; label: string; summary: string | null; payload: string | null; created_at: number }): RunEvent {
  let payload: Record<string, unknown> | null = null;
  if (row.payload) {
    try {
      const parsed = JSON.parse(row.payload);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>;
      }
    } catch {
      payload = null;
    }
  }
  return {
    id: row.id,
    run_id: row.run_id,
    conversation_id: row.conversation_id,
    message_id: row.message_id,
    kind: row.kind as RunEvent['kind'],
    status: row.status as RunEvent['status'],
    label: row.label,
    summary: row.summary,
    payload,
    created_at: row.created_at,
  };
}

function payloadString(event: RunEvent, key: string): string | null {
  const value = event.payload?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export class CostsRepo {
  constructor(private db: Db) {}

  private startOfToday(now = new Date()): number {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  }

  private startOfWeek(now = new Date()): number {
    const day = now.getDay();
    const diff = day === 0 ? 6 : day - 1;
    return new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - diff,
    ).getTime();
  }

  private startOfMonth(now = new Date()): number {
    return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  }

  private scopeStart(scope: 'session' | 'today' | 'week' | 'month'): number | null {
    if (scope === 'today') return this.startOfToday();
    if (scope === 'week') return this.startOfWeek();
    if (scope === 'month') return this.startOfMonth();
    return null;
  }

  private listWindowRows(
    scope: 'session' | 'today' | 'week' | 'month',
    conversationId: string | null,
  ): Array<{
    model_id: string | null;
    model_name_snapshot: string | null;
    feature: string;
    sum_usd: number;
    success: boolean;
    created_at: number;
    conversation_id: string | null;
    conversation_title: string | null;
    conversation_tags: string[];
  }> {
    if (scope === 'session' && !conversationId) return [];
    const clauses = [];
    const start = this.scopeStart(scope);
    if (start != null) clauses.push(sql`${cost_records.created_at} >= ${start}`);
    if (scope === 'session' && conversationId) {
      clauses.push(eq(cost_records.conversation_id, conversationId));
    }
    const query = this.db
      .select({
        model_id: cost_records.model_id,
        model_name_snapshot: cost_records.model_name_snapshot,
        feature: cost_records.feature,
        sum_usd: sql<number>`COALESCE(${cost_records.actual_cost_usd}, 0)`,
        success: cost_records.success,
        created_at: cost_records.created_at,
        conversation_id: cost_records.conversation_id,
        conversation_title: conversations.title,
        conversation_tags: conversations.tags,
      })
      .from(cost_records)
      .leftJoin(conversations, eq(cost_records.conversation_id, conversations.id))
      .orderBy(asc(cost_records.created_at));
    const rows = (clauses.length > 0 ? query.where(and(...clauses)) : query).all() as Array<{
      model_id: string | null;
      model_name_snapshot: string | null;
      feature: string;
      sum_usd: number;
      success: boolean;
      created_at: number;
      conversation_id: string | null;
      conversation_title: string | null;
      conversation_tags: string | null;
    }>;
    return rows.map((row) => ({
      ...row,
      conversation_tags: parseConversationTags(row.conversation_tags),
    }));
  }

  private makeTrendBuckets(
    scope: 'session' | 'today' | 'week' | 'month',
    rows: Array<{ created_at: number }>,
  ): Array<{ start: number; label: string }> {
    if (scope === 'today') {
      const now = new Date();
      const start = this.startOfToday(now);
      const currentHour = now.getHours();
      return Array.from({ length: currentHour + 1 }, (_, hour) => ({
        start: start + hour * 60 * 60 * 1000,
        label: `${String(hour).padStart(2, '0')}:00`,
      }));
    }
    const byDay = (startMs: number, count: number, label: (date: Date) => string) =>
      Array.from({ length: count }, (_, i) => {
        const date = new Date(startMs + i * 24 * 60 * 60 * 1000);
        return { start: date.getTime(), label: label(date) };
      });
    if (scope === 'week') {
      const now = new Date();
      const start = this.startOfWeek(now);
      const days = Math.floor((this.startOfToday(now) - start) / (24 * 60 * 60 * 1000)) + 1;
      return byDay(start, days, (date) => `${date.getMonth() + 1}/${date.getDate()}`);
    }
    if (scope === 'month') {
      const now = new Date();
      const start = this.startOfMonth(now);
      return byDay(start, now.getDate(), (date) => `${date.getDate()}`);
    }
    if (rows.length === 0) {
      const today = this.startOfToday();
      return [{ start: today, label: '今天' }];
    }
    const first = new Date(rows[0]!.created_at);
    const last = new Date(rows[rows.length - 1]!.created_at);
    const start = new Date(first.getFullYear(), first.getMonth(), first.getDate()).getTime();
    const end = new Date(last.getFullYear(), last.getMonth(), last.getDate()).getTime();
    const days = Math.max(1, Math.floor((end - start) / (24 * 60 * 60 * 1000)) + 1);
    return byDay(start, days, (date) => `${date.getMonth() + 1}/${date.getDate()}`);
  }

  private bucketStartForScope(
    scope: 'session' | 'today' | 'week' | 'month',
    createdAt: number,
  ): number {
    const date = new Date(createdAt);
    if (scope === 'today') {
      return new Date(
        date.getFullYear(),
        date.getMonth(),
        date.getDate(),
        date.getHours(),
      ).getTime();
    }
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  }

  insert(input: CostInsert): CostRecord {
    const id = makeId('cost');
    const now = Date.now();
    const row = this.db
      .insert(cost_records)
      .values({
        id,
        conversation_id: input.conversation_id,
        source_type: input.source_type,
        source_id: input.source_id,
        feature: input.feature,
        model_id: input.model_id,
        model_name_snapshot: input.model_name_snapshot,
        input_tokens: input.input_tokens,
        cache_input_tokens: input.cache_input_tokens ?? null,
        output_tokens: input.output_tokens,
        call_count: input.call_count ?? 1,
        price_input_per_1m_snapshot: input.price_input_per_1m_snapshot,
        price_output_per_1m_snapshot: input.price_output_per_1m_snapshot,
        price_per_call_snapshot: input.price_per_call_snapshot,
        estimated_cost_usd: input.estimated_cost_usd,
        actual_cost_usd: input.actual_cost_usd,
        success: input.success,
        classification: input.classification ?? null,
        first_token_ms: input.first_token_ms ?? null,
        duration_ms: input.duration_ms,
        created_at: now,
      })
      .returning()
      .get();
    return row as CostRecord;
  }

  /** Sum actual_cost_usd in a window. Nulls treated as 0. */
  sumSince(opts: { since?: number; conversationId?: string }): {
    total_usd: number;
    calls: number;
  } {
    const since = opts.since ?? 0;
    const where = opts.conversationId
      ? sql`created_at >= ${since} AND conversation_id = ${opts.conversationId}`
      : sql`created_at >= ${since}`;
    const row = this.db
      .select({
        total: sql<number>`COALESCE(SUM(actual_cost_usd), 0)`,
        calls: sql<number>`COUNT(*)`,
      })
      .from(cost_records)
      .where(where)
      .get();
    return { total_usd: row?.total ?? 0, calls: row?.calls ?? 0 };
  }

  /** Snapshot for the bottom status bar. */
  realtime(currentConversationId: string | null): {
    current_conversation_usd: number;
    current_conversation_calls: number;
    today_usd: number;
    month_usd: number;
  } {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const today = this.sumSince({ since: todayStart });
    const month = this.sumSince({ since: monthStart });
    const conv = currentConversationId
      ? this.sumSince({ conversationId: currentConversationId })
      : { total_usd: 0, calls: 0 };
    return {
      current_conversation_usd: conv.total_usd,
      current_conversation_calls: conv.calls,
      today_usd: today.total_usd,
      month_usd: month.total_usd,
    };
  }

  listByConversation(conversationId: string): CostRecord[] {
    return this.db
      .select()
      .from(cost_records)
      .where(eq(cost_records.conversation_id, conversationId))
      .orderBy(asc(cost_records.created_at))
      .all() as CostRecord[];
  }

  callLogs(opts: { limit?: number; costRecordId?: string } | number = 100): CostCallLogRow[] {
    const limit = typeof opts === 'number' ? opts : opts.limit ?? 100;
    const costRecordId = typeof opts === 'number' ? undefined : opts.costRecordId;
    const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
    const query = this.db
      .select({
        id: cost_records.id,
        created_at: cost_records.created_at,
        conversation_id: cost_records.conversation_id,
        conversation_title: conversations.title,
        source_type: cost_records.source_type,
        source_id: cost_records.source_id,
        feature: cost_records.feature,
        model_id: cost_records.model_id,
        model_name_snapshot: cost_records.model_name_snapshot,
        provider_id: providers.id,
        provider_name: providers.name,
        provider_type: providers.type,
        input_tokens: cost_records.input_tokens,
        cache_input_tokens: cost_records.cache_input_tokens,
        output_tokens: cost_records.output_tokens,
        actual_cost_usd: cost_records.actual_cost_usd,
        success: cost_records.success,
        classification: cost_records.classification,
        first_token_ms: cost_records.first_token_ms,
        duration_ms: cost_records.duration_ms,
      })
      .from(cost_records)
      .leftJoin(models, eq(cost_records.model_id, models.id))
      .leftJoin(providers, eq(models.provider_id, providers.id))
      .leftJoin(conversations, eq(cost_records.conversation_id, conversations.id))
      .where(costRecordId ? eq(cost_records.id, costRecordId) : undefined)
      .orderBy(desc(cost_records.created_at))
      .limit(costRecordId ? 1 : safeLimit);
    const rows = query.all() as Array<Omit<CostCallLogRow, 'run_id' | 'run_event_id' | 'run_event_kind' | 'run_event_label'>>;
    if (rows.length === 0) return [];

    const eventRows = this.db
      .select()
      .from(run_events)
      .where(eq(run_events.kind, 'cost.recorded'))
      .orderBy(desc(run_events.created_at))
      .limit(1000)
      .all()
      .map(toRunEvent);
    const byCostId = new Map<string, RunEvent>();
    const bySource = new Map<string, RunEvent>();
    for (const event of eventRows) {
      const costRecordId = payloadString(event, 'cost_record_id');
      if (costRecordId && !byCostId.has(costRecordId)) byCostId.set(costRecordId, event);
      if (event.message_id && !bySource.has(`message:${event.message_id}`)) {
        bySource.set(`message:${event.message_id}`, event);
      }
      if (event.message_id && !bySource.has(`tool_call:${event.message_id}`)) {
        bySource.set(`tool_call:${event.message_id}`, event);
      }
      const roundtableMessageId = payloadString(event, 'roundtable_message_id');
      if (roundtableMessageId && !bySource.has(`roundtable_message:${roundtableMessageId}`)) {
        bySource.set(`roundtable_message:${roundtableMessageId}`, event);
      }
      for (const sourceId of [
        payloadString(event, 'assistant_message_id'),
        payloadString(event, 'message_id'),
      ].filter((value): value is string => Boolean(value))) {
        if (!bySource.has(`message:${sourceId}`)) bySource.set(`message:${sourceId}`, event);
        if (!bySource.has(`tool_call:${sourceId}`)) bySource.set(`tool_call:${sourceId}`, event);
      }
    }

    return rows.map((row) => {
      const event =
        byCostId.get(row.id)
        ?? (row.source_id ? bySource.get(`${row.source_type}:${row.source_id}`) : undefined)
        ?? undefined;
      return {
        ...row,
        run_id: event?.run_id ?? null,
        run_event_id: event?.id ?? null,
        run_event_kind: event?.kind ?? null,
        run_event_label: event?.label ?? null,
      };
    });
  }

  modelHealth24h(): Map<string, ModelHealthRow> {
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const bucketSizeMs = 3 * 60 * 60 * 1000;
    const bucketCount = 8;
    const bucketBase = Math.floor(since / bucketSizeMs) * bucketSizeMs;
    const makeEmptyTrend = () =>
      Array.from({ length: bucketCount }, (_, index) => ({
        bucket_start: bucketBase + index * bucketSizeMs,
        label: new Date(bucketBase + index * bucketSizeMs).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        }),
        failures: 0,
        classifications: [] as Array<{
          classification: ErrorClassification;
          failures: number;
        }>,
      }));
    const rows = this.db
      .select({
        model_id: cost_records.model_id,
        success: cost_records.success,
        classification: cost_records.classification,
        first_token_ms: cost_records.first_token_ms,
        duration_ms: cost_records.duration_ms,
        created_at: cost_records.created_at,
      })
      .from(cost_records)
      .where(
        and(
          isNotNull(cost_records.model_id),
          sql`${cost_records.created_at} >= ${since}`,
        ),
      )
      .all() as Array<{
      model_id: string | null;
      success: boolean;
      classification: ErrorClassification | null;
      first_token_ms: number | null;
      duration_ms: number | null;
      created_at: number;
    }>;

    const grouped = new Map<
      string,
      ModelHealthRow & {
        firstTokenTotal: number;
        firstTokenCount: number;
        durationTotal: number;
        durationCount: number;
        failureDistribution: Map<ErrorClassification, number>;
        failureTrendMaps: Array<Map<ErrorClassification, number>>;
      }
    >();

    for (const row of rows) {
      if (!row.model_id) continue;
      const current = grouped.get(row.model_id) ?? {
        model_id: row.model_id,
        calls_24h: 0,
        failures_24h: 0,
        avg_first_token_ms: null,
        avg_duration_ms: null,
        last_failure_at: null,
        last_failure_classification: null,
        failure_distribution_24h: [],
        failure_trend_24h: makeEmptyTrend(),
        firstTokenTotal: 0,
        firstTokenCount: 0,
        durationTotal: 0,
        durationCount: 0,
        failureDistribution: new Map<ErrorClassification, number>(),
        failureTrendMaps: Array.from({ length: bucketCount }, () => new Map<ErrorClassification, number>()),
      };
      current.calls_24h += 1;
      if (!row.success) {
        current.failures_24h += 1;
        if (current.last_failure_at == null || row.created_at >= current.last_failure_at) {
          current.last_failure_at = row.created_at;
          current.last_failure_classification = row.classification ?? null;
        }
        if (row.classification) {
          current.failureDistribution.set(
            row.classification,
            (current.failureDistribution.get(row.classification) ?? 0) + 1,
          );
          const rawBucketIndex = Math.floor((row.created_at - bucketBase) / bucketSizeMs);
          const bucketIndex = Math.min(
            bucketCount - 1,
            Math.max(0, rawBucketIndex),
          );
          const trendBucket = current.failureTrendMaps[bucketIndex]!;
          trendBucket.set(
            row.classification,
            (trendBucket.get(row.classification) ?? 0) + 1,
          );
        }
      }
      if (typeof row.first_token_ms === 'number') {
        current.firstTokenTotal += row.first_token_ms;
        current.firstTokenCount += 1;
      }
      if (typeof row.duration_ms === 'number') {
        current.durationTotal += row.duration_ms;
        current.durationCount += 1;
      }
      grouped.set(row.model_id, current);
    }

    const out = new Map<string, ModelHealthRow>();
    for (const [modelId, row] of grouped.entries()) {
      const failure_distribution_24h = Array.from(row.failureDistribution.entries())
        .map(([classification, failures]) => ({ classification, failures }))
        .sort((a, b) => b.failures - a.failures);
      const failure_trend_24h = row.failure_trend_24h.map((bucket, index) => {
        const classifications = Array.from(row.failureTrendMaps[index]!.entries())
          .map(([classification, failures]) => ({ classification, failures }))
          .sort((a, b) => b.failures - a.failures);
        return {
          ...bucket,
          failures: classifications.reduce((sum, item) => sum + item.failures, 0),
          classifications,
        };
      });
      out.set(modelId, {
        model_id: row.model_id,
        calls_24h: row.calls_24h,
        failures_24h: row.failures_24h,
        avg_first_token_ms:
          row.firstTokenCount > 0 ? row.firstTokenTotal / row.firstTokenCount : null,
        avg_duration_ms:
          row.durationCount > 0 ? row.durationTotal / row.durationCount : null,
        last_failure_at: row.last_failure_at,
        last_failure_classification: row.last_failure_classification,
        failure_distribution_24h,
        failure_trend_24h,
      });
    }
    return out;
  }

  toolHealth24h(toolNames: string[]): Map<string, ToolHealthRow> {
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const imageToolName = toolNames.includes('builtin.image_generate')
      ? 'builtin.image_generate'
      : null;
    const toolNameSet = new Set(toolNames);
    const rows = this.db
      .select({
        feature: cost_records.feature,
        model_name_snapshot: cost_records.model_name_snapshot,
        success: cost_records.success,
        classification: cost_records.classification,
        duration_ms: cost_records.duration_ms,
        created_at: cost_records.created_at,
      })
      .from(cost_records)
      .where(
        and(
          sql`${cost_records.source_type} = 'tool_call'`,
          sql`${cost_records.created_at} >= ${since}`,
        ),
      )
      .all() as Array<{
      feature: CostInsert['feature'];
      model_name_snapshot: string;
      success: boolean;
      classification: ToolErrorClassification | null;
      duration_ms: number | null;
      created_at: number;
    }>;

    const grouped = new Map<
      string,
      ToolHealthRow & {
        durationTotal: number;
        durationCount: number;
      }
    >();

    for (const row of rows) {
      const toolName =
        row.feature === 'image' && imageToolName
          ? imageToolName
          : row.model_name_snapshot;
      if (!toolNameSet.has(toolName)) continue;
      const current = grouped.get(toolName) ?? {
        tool_name: toolName,
        calls_24h: 0,
        failures_24h: 0,
        avg_duration_ms: null,
        last_failure_at: null,
        last_failure_classification: null,
        durationTotal: 0,
        durationCount: 0,
      };
      current.calls_24h += 1;
      if (!row.success) {
        current.failures_24h += 1;
        if (current.last_failure_at == null || row.created_at >= current.last_failure_at) {
          current.last_failure_at = row.created_at;
          current.last_failure_classification = row.classification ?? null;
        }
      }
      if (typeof row.duration_ms === 'number') {
        current.durationTotal += row.duration_ms;
        current.durationCount += 1;
      }
      grouped.set(toolName, current);
    }

    const out = new Map<string, ToolHealthRow>();
    for (const [toolName, row] of grouped.entries()) {
      out.set(toolName, {
        tool_name: toolName,
        calls_24h: row.calls_24h,
        failures_24h: row.failures_24h,
        avg_duration_ms:
          row.durationCount > 0 ? row.durationTotal / row.durationCount : null,
        last_failure_at: row.last_failure_at,
        last_failure_classification: row.last_failure_classification,
      });
    }
    return out;
  }

  /** For per-message display. */
  forMessage(messageId: string): CostRecord | null {
    const row = this.db
      .select()
      .from(cost_records)
      .where(sql`source_type = 'message' AND source_id = ${messageId}`)
      .get();
    return (row as CostRecord | undefined) ?? null;
  }

  /**
   * M3.A.3 — list every cost record tied to a roundtable (analyzer + each
   * participant message + summarizer). Filters by conversation + feature so
   * we don't accidentally pull in unrelated chat records.
   */
  listForRoundtable(args: {
    conversationId: string;
    roundtableId: string;
    messageIds: string[];
  }): CostRecord[] {
    const ids = new Set<string>([args.roundtableId, ...args.messageIds]);
    if (ids.size === 0) return [];
    const rows = this.db
      .select()
      .from(cost_records)
      .where(
        sql`conversation_id = ${args.conversationId} AND feature = 'roundtable'`,
      )
      .orderBy(asc(cost_records.created_at))
      .all() as CostRecord[];
    return rows.filter((r) => r.source_id !== null && ids.has(r.source_id));
  }

  /**
   * Pre-send estimate input (M1 §5.1): rolling average output_tokens for a
   * given model id. Limits the sample to the most recent 50 successful calls
   * to keep estimates responsive after price/behaviour changes. Returns
   * `sample_count` so the renderer can render "区间" when sample < 5.
   */
  avgOutputTokens(modelId: string): { avg_output_tokens: number; sample_count: number } {
    const rows = this.db
      .select({ output_tokens: cost_records.output_tokens })
      .from(cost_records)
      .where(
        sql`model_id = ${modelId} AND success = 1 AND output_tokens IS NOT NULL AND output_tokens > 0`,
      )
      .orderBy(sql`created_at DESC`)
      .limit(50)
      .all() as Array<{ output_tokens: number | null }>;
    if (rows.length === 0) return { avg_output_tokens: 0, sample_count: 0 };
    const sum = rows.reduce((s, r) => s + (r.output_tokens ?? 0), 0);
    return {
      avg_output_tokens: Math.round(sum / rows.length),
      sample_count: rows.length,
    };
  }

  /**
   * M2.2 §3.3 — per-scope, per-(model, feature) cost breakdown for the
   * session-cost panel.
   */
  breakdown(
    scope: 'session' | 'today' | 'week' | 'month',
    conversationId: string | null,
  ): Array<{
    model_id: string | null;
    model_name_snapshot: string | null;
    feature: string;
    sum_usd: number;
    count: number;
    success_count: number;
    billed_failure_count: number;
  }> {
    const grouped = new Map<
      string,
      {
        model_id: string | null;
        model_name_snapshot: string | null;
        feature: string;
        sum_usd: number;
        count: number;
        success_count: number;
        billed_failure_count: number;
      }
    >();
    for (const row of this.listWindowRows(scope, conversationId)) {
      const key = `${row.model_id ?? 'null'}::${row.feature}`;
      const current = grouped.get(key) ?? {
        model_id: row.model_id,
        model_name_snapshot: row.model_name_snapshot,
        feature: row.feature,
        sum_usd: 0,
        count: 0,
        success_count: 0,
        billed_failure_count: 0,
      };
      current.sum_usd += row.sum_usd;
      current.count += 1;
      current.success_count += row.success ? 1 : 0;
      current.billed_failure_count += !row.success && row.sum_usd > 0 ? 1 : 0;
      grouped.set(key, current);
    }
    return Array.from(grouped.values()).sort((a, b) => b.sum_usd - a.sum_usd);
  }

  breakdownBy(
    scope: 'session' | 'today' | 'week' | 'month',
    groupBy: 'model' | 'conversation' | 'feature' | 'tag',
    conversationId: string | null,
  ): Array<{
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
    trend: Array<{ bucket_start: number; label: string; sum_usd: number; count: number }>;
  }> {
    const rows = this.listWindowRows(scope, conversationId);
    const buckets = this.makeTrendBuckets(scope, rows);
    const bucketTemplate = buckets.map((bucket) => ({
      bucket_start: bucket.start,
      label: bucket.label,
      sum_usd: 0,
      count: 0,
    }));
    const grouped = new Map<
      string,
      {
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
        trend: Array<{ bucket_start: number; label: string; sum_usd: number; count: number }>;
      }
    >();
    const bucketIndex = new Map<number, number>();
    for (let i = 0; i < buckets.length; i++) bucketIndex.set(buckets[i]!.start, i);

    for (const row of rows) {
      const bucketStart = this.bucketStartForScope(scope, row.created_at);
      const segments =
        groupBy === 'tag'
          ? (row.conversation_tags.length > 0 ? row.conversation_tags : ['未归档项目']).map((tag) => ({
              key: `tag:${tag}`,
              label: tag,
              modelId: null,
              modelNameSnapshot: null,
              feature: null,
              conversationId: null,
              conversationTitle: null,
              weight: 1 / (row.conversation_tags.length > 0 ? row.conversation_tags.length : 1),
            }))
          : [(() => {
              if (groupBy === 'model') {
                return {
                  key: row.model_id ?? `snapshot:${row.model_name_snapshot ?? 'deleted'}`,
                  label: row.model_name_snapshot ?? '(已删除模型)',
                  modelId: row.model_id,
                  modelNameSnapshot: row.model_name_snapshot,
                  feature: null,
                  conversationId: null,
                  conversationTitle: null,
                  weight: 1,
                };
              }
              if (groupBy === 'conversation') {
                return {
                  key: row.conversation_id ?? 'no-conversation',
                  label: row.conversation_title ?? (row.conversation_id ? '未命名会话' : '无会话归属'),
                  modelId: null,
                  modelNameSnapshot: null,
                  feature: null,
                  conversationId: row.conversation_id,
                  conversationTitle: row.conversation_title,
                  weight: 1,
                };
              }
              return {
                key: row.feature,
                label: row.feature,
                modelId: null,
                modelNameSnapshot: null,
                feature: row.feature,
                conversationId: null,
                conversationTitle: null,
                weight: 1,
              };
            })()];

      for (const segment of segments) {
        const current = grouped.get(segment.key) ?? {
          key: segment.key,
          label: segment.label,
          model_id: segment.modelId,
          model_name_snapshot: segment.modelNameSnapshot,
          conversation_id: segment.conversationId,
          conversation_title: segment.conversationTitle,
          feature: segment.feature,
          sum_usd: 0,
          count: 0,
          success_count: 0,
          billed_failure_count: 0,
          trend: bucketTemplate.map((bucket) => ({ ...bucket })),
        };
        current.sum_usd += row.sum_usd * segment.weight;
        current.count += segment.weight;
        current.success_count += row.success ? segment.weight : 0;
        current.billed_failure_count += !row.success && row.sum_usd > 0 ? segment.weight : 0;
        const idx = bucketIndex.get(bucketStart);
        if (idx != null) {
          current.trend[idx]!.sum_usd += row.sum_usd * segment.weight;
          current.trend[idx]!.count += segment.weight;
        }
        grouped.set(segment.key, current);
      }
    }
    return Array.from(grouped.values()).sort((a, b) => b.sum_usd - a.sum_usd);
  }
}
