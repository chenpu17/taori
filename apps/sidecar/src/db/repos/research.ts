import { eq, and, asc, desc, sql } from 'drizzle-orm';
import { type Db } from '../index.js';
import {
  research_sessions,
  research_tasks,
  research_sources,
  research_claims,
} from '../schema.js';
import type {
  ResearchSession,
  ResearchSessionCreate,
  ResearchSessionDetail,
  ResearchSessionExport,
  ResearchSessionExportRequest,
  ResearchTask,
  ResearchTaskKind,
  ResearchTaskStatus,
  ResearchSource,
  ResearchSourceType,
  ResearchClaim,
  ResearchClaimKind,
  ResearchClaimSupportStatus,
  ResearchConstraints,
  ResearchPlan,
  ResearchPlanOrigin,
  ResearchStatus,
  ResearchStage,
  ResearchBudgetMode,
  ResearchOutputKind,
} from '@taori/shared';
import { ResearchConstraintsSchema, ResearchPlanSchema, makeId } from '@taori/shared';
import type { PlanMessage } from '@taori/shared';
import { pickDefined } from './shared.js';

type ResearchSessionRow = typeof research_sessions.$inferSelect;
type ResearchTaskRow = typeof research_tasks.$inferSelect;
type ResearchSourceRow = typeof research_sources.$inferSelect;
type ResearchClaimRow = typeof research_claims.$inferSelect;

function parseJsonRecord(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function parseResearchConstraints(raw: string | null): ResearchConstraints {
  try {
    return ResearchConstraintsSchema.parse(raw ? JSON.parse(raw) : {});
  } catch {
    return ResearchConstraintsSchema.parse({});
  }
}

function parseResearchPlan(raw: string | null): ResearchPlan | null {
  if (!raw) return null;
  try {
    return ResearchPlanSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

function parsePlanMessages(raw: string | null | undefined): PlanMessage[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    return (parsed as unknown[]).filter(
      (m): m is PlanMessage =>
        typeof m === 'object' && m !== null &&
        ((m as Record<string, unknown>).role === 'user' || (m as Record<string, unknown>).role === 'assistant') &&
        typeof (m as Record<string, unknown>).content === 'string',
    );
  } catch {
    return null;
  }
}

function parseResearchCitations(raw: string | null): ResearchClaim['citations'] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is ResearchClaim['citations'][number] =>
          Boolean(item)
          && typeof item === 'object'
          && !Array.isArray(item)
          && typeof (item as { source_id?: unknown }).source_id === 'string',
        )
      : [];
  } catch {
    return [];
  }
}

function parseResearchEvidenceSpans(raw: string | null): ResearchClaim['evidence_spans'] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is { source_id: string; span_text: string; stance?: string } =>
        Boolean(item)
        && typeof item === 'object'
        && !Array.isArray(item)
        && typeof (item as { source_id?: unknown }).source_id === 'string'
        && typeof (item as { span_text?: unknown }).span_text === 'string',
      )
      .map((item) => ({
        source_id: item.source_id,
        span_text: item.span_text.slice(0, 600),
        stance: (item.stance === 'contradicts' || item.stance === 'partial')
          ? item.stance
          : 'supports' as const,
      }));
  } catch {
    return [];
  }
}

function toResearchSession(row: ResearchSessionRow): ResearchSession {
  return {
    id: row.id,
    conversation_id: row.conversation_id ?? null,
    title: row.title,
    objective: row.objective,
    output_kind: row.output_kind as ResearchOutputKind,
    status: row.status as ResearchStatus,
    stage: row.stage as ResearchStage,
    budget_mode: row.budget_mode as ResearchBudgetMode,
    budget_limit_usd: row.budget_limit_usd ?? null,
    budget_spent_usd: row.budget_spent_usd ?? 0,
    constraints: parseResearchConstraints(row.constraints_json),
    plan: parseResearchPlan(row.plan_json),
    plan_origin: ((row as Record<string, unknown>).plan_origin as ResearchPlanOrigin | null) ?? 'pending',
    plan_messages: parsePlanMessages((row as Record<string, unknown>).plan_messages_json as string | null | undefined),
    draft_markdown: row.draft_markdown ?? null,
    final_markdown: row.final_markdown ?? null,
    preferred_model_id: (row as Record<string, unknown>).preferred_model_id as string | null ?? null,
    preferred_search_tool: (row as Record<string, unknown>).preferred_search_tool as string | null ?? null,
    synthesis_model_id: (row as Record<string, unknown>).synthesis_model_id as string | null ?? null,
    started_at: row.started_at ?? null,
    completed_at: row.completed_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toResearchTask(row: ResearchTaskRow): ResearchTask {
  return {
    id: row.id,
    research_session_id: row.research_session_id,
    parent_task_id: row.parent_task_id ?? null,
    kind: row.kind as ResearchTaskKind,
    status: row.status as ResearchTaskStatus,
    title: row.title,
    input: parseJsonRecord(row.input_json),
    output: row.output_json ? parseJsonRecord(row.output_json) : null,
    error: row.error_json ? parseJsonRecord(row.error_json) : null,
    started_at: row.started_at ?? null,
    finished_at: row.finished_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toResearchSource(row: ResearchSourceRow): ResearchSource {
  return {
    id: row.id,
    research_session_id: row.research_session_id,
    source_type: row.source_type as ResearchSourceType,
    title: row.title ?? null,
    locator: row.locator,
    snippet: row.snippet ?? null,
    credibility_score: row.credibility_score ?? null,
    included: row.included ?? true,
    metadata: parseJsonRecord(row.metadata_json),
    created_at: row.created_at,
  };
}

function toResearchClaim(row: ResearchClaimRow): ResearchClaim {
  const rec = row as Record<string, unknown>;
  const rawConfidence = rec.confidence;
  const confidence = (rawConfidence === 'high' || rawConfidence === 'medium' || rawConfidence === 'low' || rawConfidence === 'unverified')
    ? rawConfidence
    : null;
  return {
    id: row.id,
    research_session_id: row.research_session_id,
    section_key: row.section_key,
    claim_text: row.claim_text,
    claim_kind: row.claim_kind as ResearchClaimKind,
    support_status: row.support_status as ResearchClaimSupportStatus,
    citations: parseResearchCitations(row.citations_json),
    evidence_spans: parseResearchEvidenceSpans((rec.evidence_spans_json as string | null) ?? null),
    confidence,
    verified_at: typeof rec.verified_at === 'number' ? rec.verified_at : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export interface ResearchSessionPatch {
  conversation_id?: string | null;
  title?: string;
  objective?: string;
  output_kind?: ResearchOutputKind;
  status?: ResearchStatus;
  stage?: ResearchStage;
  budget_mode?: ResearchBudgetMode;
  budget_limit_usd?: number | null;
  budget_spent_usd?: number;
  constraints?: ResearchConstraints;
  plan?: ResearchPlan | null;
  plan_origin?: ResearchPlanOrigin;
  plan_messages?: PlanMessage[] | null;
  draft_markdown?: string | null;
  final_markdown?: string | null;
  preferred_model_id?: string | null;
  preferred_search_tool?: string | null;
  synthesis_model_id?: string | null;
  started_at?: number | null;
  completed_at?: number | null;
}

export interface ResearchTaskSeed {
  parent_task_id?: string | null;
  kind: ResearchTaskKind;
  status?: ResearchTaskStatus;
  title: string;
  input: Record<string, unknown>;
  output?: Record<string, unknown> | null;
  error?: Record<string, unknown> | null;
  started_at?: number | null;
  finished_at?: number | null;
}

export class ResearchRepo {
  constructor(private db: Db) {}

  list(limit = 50): ResearchSession[] {
    const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
    return this.db
      .select()
      .from(research_sessions)
      .orderBy(desc(research_sessions.updated_at), desc(research_sessions.created_at))
      .limit(safeLimit)
      .all()
      .map(toResearchSession);
  }

  get(id: string): ResearchSession | null {
    const row = this.db
      .select()
      .from(research_sessions)
      .where(eq(research_sessions.id, id))
      .get();
    return row ? toResearchSession(row) : null;
  }

  getDetail(id: string): ResearchSessionDetail | null {
    const session = this.get(id);
    if (!session) return null;
    return {
      session,
      tasks: this.listTasks(id),
      sources: this.listSources(id),
      claims: this.listClaims(id),
    };
  }

  listTasks(sessionId: string): ResearchTask[] {
    return this.db
      .select()
      .from(research_tasks)
      .where(eq(research_tasks.research_session_id, sessionId))
      .orderBy(asc(research_tasks.created_at))
      .all()
      .map(toResearchTask);
  }

  listSources(sessionId: string): ResearchSource[] {
    return this.db
      .select()
      .from(research_sources)
      .where(eq(research_sources.research_session_id, sessionId))
      .orderBy(desc(research_sources.created_at))
      .all()
      .map(toResearchSource);
  }

  listClaims(sessionId: string): ResearchClaim[] {
    return this.db
      .select()
      .from(research_claims)
      .where(eq(research_claims.research_session_id, sessionId))
      .orderBy(desc(research_claims.updated_at))
      .all()
      .map(toResearchClaim);
  }

  create(input: ResearchSessionCreate, initialStatus: ResearchStatus = 'reviewing'): ResearchSession {
    const now = Date.now();
    const row = this.db
      .insert(research_sessions)
      .values({
        id: makeId('research_session'),
        conversation_id: input.conversation_id ?? null,
        title: input.title,
        objective: input.objective,
        output_kind: input.output_kind,
        status: initialStatus,
        stage: 'scoping',
        budget_mode: input.budget_mode,
        budget_limit_usd: input.budget_limit_usd ?? null,
        budget_spent_usd: 0,
        constraints_json: JSON.stringify(ResearchConstraintsSchema.parse(input.constraints ?? {})),
        plan_json: null,
        plan_origin: 'pending',
        plan_messages_json: null,
        draft_markdown: null,
        final_markdown: null,
        preferred_model_id: input.preferred_model_id ?? null,
        preferred_search_tool: input.preferred_search_tool ?? null,
        synthesis_model_id: input.synthesis_model_id ?? null,
        started_at: null,
        completed_at: null,
        created_at: now,
        updated_at: now,
      })
      .returning()
      .get();
    return toResearchSession(row);
  }

  update(id: string, patch: ResearchSessionPatch): ResearchSession | null {
    const row = this.db
      .update(research_sessions)
      .set({
        ...pickDefined(patch, [
          'conversation_id', 'title', 'objective', 'output_kind',
          'status', 'stage', 'budget_mode', 'budget_limit_usd', 'budget_spent_usd',
          'plan_origin', 'draft_markdown', 'final_markdown',
          'preferred_model_id', 'preferred_search_tool', 'synthesis_model_id',
          'started_at', 'completed_at',
        ]),
        ...(patch.constraints !== undefined && {
          constraints_json: JSON.stringify(ResearchConstraintsSchema.parse(patch.constraints)),
        }),
        ...(patch.plan !== undefined && {
          plan_json: patch.plan ? JSON.stringify(ResearchPlanSchema.parse(patch.plan)) : null,
        }),
        ...(patch.plan_messages !== undefined && {
          plan_messages_json: patch.plan_messages ? JSON.stringify(patch.plan_messages) : null,
        }),
        updated_at: Date.now(),
      })
      .where(eq(research_sessions.id, id))
      .returning()
      .get();
    return row ? toResearchSession(row) : null;
  }

  incrementBudgetSpent(id: string, delta: number): ResearchSession | null {
    if (!Number.isFinite(delta) || delta <= 0) return this.get(id);
    const row = this.db
      .update(research_sessions)
      .set({
        budget_spent_usd: sql`ROUND(COALESCE(${research_sessions.budget_spent_usd}, 0) + ${delta}, 6)`,
        updated_at: Date.now(),
      })
      .where(eq(research_sessions.id, id))
      .returning()
      .get();
    return row ? toResearchSession(row) : null;
  }

  getTask(taskId: string): ResearchTask | null {
    const row = this.db
      .select()
      .from(research_tasks)
      .where(eq(research_tasks.id, taskId))
      .get() as ResearchTaskRow | undefined;
    return row ? toResearchTask(row) : null;
  }

  updateTask(
    taskId: string,
    patch: {
      status?: ResearchTaskStatus;
      output?: Record<string, unknown> | null;
      error?: Record<string, unknown> | null;
      started_at?: number | null;
      finished_at?: number | null;
    },
  ): ResearchTask | null {
    const row = this.db
      .update(research_tasks)
      .set({
        ...pickDefined(patch, ['status', 'started_at', 'finished_at']),
        ...(patch.output !== undefined && {
          output_json: patch.output ? JSON.stringify(patch.output) : null,
        }),
        ...(patch.error !== undefined && {
          error_json: patch.error ? JSON.stringify(patch.error) : null,
        }),
        updated_at: Date.now(),
      })
      .where(eq(research_tasks.id, taskId))
      .returning()
      .get() as ResearchTaskRow | undefined;
    return row ? toResearchTask(row) : null;
  }

  appendSource(
    sessionId: string,
    source: Omit<ResearchSource, 'id' | 'research_session_id' | 'created_at'>,
  ): ResearchSource {
    const row = this.db
      .insert(research_sources)
      .values({
        id: makeId('research_source'),
        research_session_id: sessionId,
        source_type: source.source_type,
        title: source.title,
        locator: source.locator,
        snippet: source.snippet,
        credibility_score: source.credibility_score,
        included: source.included,
        metadata_json: JSON.stringify(source.metadata ?? {}),
        created_at: Date.now(),
      })
      .returning()
      .get() as ResearchSourceRow;
    return toResearchSource(row);
  }

  findSourceByLocator(sessionId: string, locator: string): ResearchSource | null {
    const row = this.db
      .select()
      .from(research_sources)
      .where(
        and(
          eq(research_sources.research_session_id, sessionId),
          eq(research_sources.locator, locator),
        ),
      )
      .get() as ResearchSourceRow | undefined;
    return row ? toResearchSource(row) : null;
  }

  updateSource(
    sourceId: string,
    patch: { title?: string | null; snippet?: string | null; credibility_score?: number | null; metadata?: Record<string, unknown> },
  ): ResearchSource | null {
    const row = this.db
      .update(research_sources)
      .set({
        ...pickDefined(patch, ['title', 'snippet', 'credibility_score']),
        ...(patch.metadata !== undefined && { metadata_json: JSON.stringify(patch.metadata) }),
      })
      .where(eq(research_sources.id, sourceId))
      .returning()
      .get() as ResearchSourceRow | undefined;
    return row ? toResearchSource(row) : null;
  }

  appendClaim(
    sessionId: string,
    claim: Omit<ResearchClaim, 'id' | 'research_session_id' | 'created_at' | 'updated_at'>,
  ): ResearchClaim {
    const now = Date.now();
    const row = this.db
      .insert(research_claims)
      .values({
        id: makeId('research_claim'),
        research_session_id: sessionId,
        section_key: claim.section_key,
        claim_text: claim.claim_text,
        claim_kind: claim.claim_kind,
        support_status: claim.support_status,
        citations_json: JSON.stringify(claim.citations ?? []),
        evidence_spans_json: JSON.stringify(claim.evidence_spans ?? []),
        confidence: claim.confidence ?? null,
        verified_at: claim.verified_at ?? null,
        created_at: now,
        updated_at: now,
      })
      .returning()
      .get() as ResearchClaimRow;
    return toResearchClaim(row);
  }

  insertTask(sessionId: string, task: ResearchTaskSeed): ResearchTask {
    const now = Date.now();
    const row = this.db
      .insert(research_tasks)
      .values({
        id: makeId('research_task'),
        research_session_id: sessionId,
        parent_task_id: task.parent_task_id ?? null,
        kind: task.kind,
        status: task.status ?? 'queued',
        title: task.title,
        input_json: JSON.stringify(task.input),
        output_json: task.output ? JSON.stringify(task.output) : null,
        error_json: task.error ? JSON.stringify(task.error) : null,
        started_at: task.started_at ?? null,
        finished_at: task.finished_at ?? null,
        created_at: now,
        updated_at: now,
      })
      .returning()
      .get() as ResearchTaskRow;
    return toResearchTask(row);
  }

  replaceTasks(sessionId: string, tasks: ResearchTaskSeed[]): ResearchTask[] {
    return this.db.transaction((tx) => {
      tx.delete(research_tasks).where(eq(research_tasks.research_session_id, sessionId)).run();
      const now = Date.now();
      const rows: ResearchTaskRow[] = [];
      for (const task of tasks) {
        const row = tx
          .insert(research_tasks)
          .values({
            id: makeId('research_task'),
            research_session_id: sessionId,
            parent_task_id: task.parent_task_id ?? null,
            kind: task.kind,
            status: task.status ?? 'queued',
            title: task.title,
            input_json: JSON.stringify(task.input),
            output_json: task.output ? JSON.stringify(task.output) : null,
            error_json: task.error ? JSON.stringify(task.error) : null,
            started_at: task.started_at ?? null,
            finished_at: task.finished_at ?? null,
            created_at: now,
            updated_at: now,
          })
          .returning()
          .get() as ResearchTaskRow;
        rows.push(row);
      }
      return rows.map(toResearchTask);
    });
  }

  replaceSources(sessionId: string, sources: Array<Omit<ResearchSource, 'id' | 'research_session_id' | 'created_at'>>): ResearchSource[] {
    return this.db.transaction((tx) => {
      tx.delete(research_sources).where(eq(research_sources.research_session_id, sessionId)).run();
      const now = Date.now();
      const rows: ResearchSourceRow[] = [];
      for (const source of sources) {
        const row = tx
          .insert(research_sources)
          .values({
            id: makeId('research_source'),
            research_session_id: sessionId,
            source_type: source.source_type,
            title: source.title,
            locator: source.locator,
            snippet: source.snippet,
            credibility_score: source.credibility_score,
            included: source.included,
            metadata_json: JSON.stringify(source.metadata),
            created_at: now,
          })
          .returning()
          .get() as ResearchSourceRow;
        rows.push(row);
      }
      return rows.map(toResearchSource);
    });
  }

  replaceClaims(sessionId: string, claims: Array<Omit<ResearchClaim, 'id' | 'research_session_id' | 'created_at' | 'updated_at'>>): ResearchClaim[] {
    return this.db.transaction((tx) => {
      tx.delete(research_claims).where(eq(research_claims.research_session_id, sessionId)).run();
      const now = Date.now();
      const rows: ResearchClaimRow[] = [];
      for (const claim of claims) {
        const row = tx
          .insert(research_claims)
          .values({
            id: makeId('research_claim'),
            research_session_id: sessionId,
            section_key: claim.section_key,
            claim_text: claim.claim_text,
            claim_kind: claim.claim_kind,
            support_status: claim.support_status,
            citations_json: JSON.stringify(claim.citations),
            evidence_spans_json: JSON.stringify(claim.evidence_spans ?? []),
            confidence: claim.confidence ?? null,
            verified_at: claim.verified_at ?? null,
            created_at: now,
            updated_at: now,
          })
          .returning()
          .get() as ResearchClaimRow;
        rows.push(row);
      }
      return rows.map(toResearchClaim);
    });
  }

  exportSession(id: string, req: ResearchSessionExportRequest): ResearchSessionExport | null {
    const detail = this.getDetail(id);
    if (!detail) return null;
    if (req.format === 'markdown') {
      const lines = [
        `# ${detail.session.title}`,
        '',
        `- 状态：${detail.session.status}`,
        `- 阶段：${detail.session.stage}`,
        `- 产出：${detail.session.output_kind}`,
        `- 预算：${detail.session.budget_mode}${detail.session.budget_limit_usd != null ? ` / ${detail.session.budget_limit_usd} USD` : ''}`,
        '',
        '## 研究目标',
        '',
        detail.session.objective,
      ];
      if (detail.session.plan) {
        lines.push(
          '',
          '## 研究计划',
          '',
          detail.session.plan.summary,
          '',
          '### 关键问题',
          '',
          ...detail.session.plan.key_questions.map((item: ResearchPlan['key_questions'][number]) => `- ${item.question}：${item.reason}`),
          '',
          '### 阶段',
          '',
          ...detail.session.plan.stages.map((item: ResearchPlan['stages'][number], index: number) => `${index + 1}. ${item.title} — ${item.objective}（产物：${item.deliverable}）`),
        );
      }
      if (detail.tasks.length > 0) {
        lines.push('', '## 待办任务', '', ...detail.tasks.map((task: ResearchTask) => `- [${task.status}] ${task.title}`));
      }
      lines.push(
        '',
        '## 当前草稿',
        '',
        detail.session.final_markdown ?? detail.session.draft_markdown ?? '（尚未生成草稿）',
      );
      return {
        filename: `taori-research-${detail.session.id}.md`,
        content_type: 'text/markdown; charset=utf-8',
        content: `${lines.join('\n').trim()}\n`,
      };
    }
    return {
      filename: `taori-research-${detail.session.id}.json`,
      content_type: 'application/json; charset=utf-8',
      content: JSON.stringify(detail, null, 2),
    };
  }
}
