import type { ResearchSource, ResearchSession } from '@taori/shared';
import type { MemoriesRepo } from '../../db/repos/index.js';
import type { ResearchRepo } from '../../db/repos/index.js';
import type { CapabilityBus } from '../../bus/index.js';
import type { SearchEngine, SearchPhase, SearchRoundSummary, PhaseResult } from './types.js';
import { executeSearchRound, collectSourcesForQuestion, inferSearchTrack } from './execute-round.js';

export interface ExecutePhaseDeps {
  repo: ResearchRepo;
  bus: CapabilityBus;
  memories?: MemoriesRepo;
  log?: { info?: (msg: unknown, extra?: unknown) => void; warn?: (msg: unknown, extra?: unknown) => void; error?: (msg: unknown, extra?: unknown) => void };
  bumpBudgetSpend: (sessionId: string, actualUsd: number | undefined) => void;
}

export function resolveBuiltinSearchEngineCandidates(
  session: ResearchSession,
  memories?: MemoriesRepo,
): SearchEngine[] {
  const configured = memories?.getEffective(session.conversation_id ?? null, 'builtin_web_search_engine');
  const current: SearchEngine =
    configured === 'exa' || configured === 'bocha' ? configured : 'duckduckgo';
  const bochaApiKey =
    String(memories?.getEffective(session.conversation_id ?? null, 'builtin_web_search_bocha_api_key') ?? '')
      .trim();
  const candidates: SearchEngine[] = [current];
  if (current !== 'exa') candidates.push('exa');
  if (bochaApiKey && current !== 'bocha') candidates.push('bocha');
  if (current !== 'duckduckgo') candidates.push('duckduckgo');
  return candidates.filter((engine, index, arr) => arr.indexOf(engine) === index);
}

export function hasEnoughSearchCoverage(sources: ResearchSource[], budgetMode: ResearchSession['budget_mode']): boolean {
  const uniqueHosts = countUniqueHosts(sources);
  if (budgetMode === 'fast') return sources.length >= 2;
  if (budgetMode === 'balanced') return sources.length >= 3 && uniqueHosts >= 2;
  return sources.length >= 4 && uniqueHosts >= 2;
}

export function uniqueSearchQueries(queries: string[]): string[] {
  return queries
    .map((query) => query.trim())
    .filter(Boolean)
    .filter((value, index, arr) => arr.indexOf(value) === index);
}

export function countUniqueHosts(sources: ResearchSource[]): number {
  const hosts = new Set<string>();
  for (const source of sources) {
    try {
      hosts.add(new URL(source.locator).hostname);
    } catch {
      hosts.add(source.locator);
    }
  }
  return hosts.size;
}

export async function executeSearchAttemptsForQuery(
  deps: ExecutePhaseDeps,
  ctx: {
    session: ResearchSession;
    searchToolName: string;
    query: string;
    question: string;
    questionId: string | undefined;
    phase: SearchPhase;
  },
): Promise<{ rounds: SearchRoundSummary[]; matchedSources: ResearchSource[] }> {
  const { repo, bus, memories, bumpBudgetSpend } = deps;
  const { session, searchToolName, query, question, questionId, phase } = ctx;

  const rounds: SearchRoundSummary[] = [];
  let matchedSources = collectSourcesForQuestion(
    repo.listSources(session.id),
    question,
    questionId,
  );
  const candidates: Array<SearchEngine | undefined> =
    searchToolName === 'builtin.web_search'
      ? resolveBuiltinSearchEngineCandidates(session, memories)
      : [undefined];

  for (const requestedEngine of candidates) {
    const beforeCount = matchedSources.length;
    try {
      const round = await executeSearchRound(
        { repo, bus, bumpBudgetSpend },
        {
          sessionId: session.id,
          conversationId: session.conversation_id ?? null,
          searchToolName,
          query,
          questionId,
          requestedEngine,
        },
      );
      matchedSources = collectSourcesForQuestion(
        repo.listSources(session.id),
        question,
        questionId,
      );
      rounds.push({
        query,
        hits: round.recorded.length,
        total_sources: matchedSources.length,
        unique_hosts: countUniqueHosts(matchedSources),
        requested_engine: requestedEngine ?? null,
        search_engine: round.engine,
        search_fallback_from: round.fallbackFrom,
        search_track: round.track,
        phase,
      });
      if (matchedSources.length > beforeCount || round.recorded.length > 0) break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      rounds.push({
        query,
        hits: 0,
        total_sources: matchedSources.length,
        unique_hosts: countUniqueHosts(matchedSources),
        requested_engine: requestedEngine ?? null,
        search_engine: requestedEngine ?? null,
        search_fallback_from: null,
        search_track: inferSearchTrack(query),
        phase,
        error: message,
      });
      if (searchToolName !== 'builtin.web_search') throw error;
    }
  }
  return { rounds, matchedSources };
}

export async function executePhase(
  deps: ExecutePhaseDeps,
  ctx: {
    session: ResearchSession;
    searchToolName: string;
    question: string;
    questionId: string | undefined;
  },
  queries: string[],
  phase: SearchPhase,
): Promise<PhaseResult> {
  const { session, searchToolName, question, questionId } = ctx;
  const rounds: SearchRoundSummary[] = [];
  const attemptedEngines = new Set<string>();
  const attemptedQueries = [...queries];
  let matchedSources = collectSourcesForQuestion(
    deps.repo.listSources(session.id),
    question,
    questionId,
  );

  for (const query of queries) {
    const result = await executeSearchAttemptsForQuery(deps, {
      session,
      searchToolName,
      query,
      question,
      questionId,
      phase,
    });
    matchedSources = result.matchedSources;
    result.rounds.forEach((round) => {
      if (round.search_engine) attemptedEngines.add(round.search_engine);
      if (round.requested_engine) attemptedEngines.add(round.requested_engine);
    });
    rounds.push(...result.rounds);
    if (hasEnoughSearchCoverage(matchedSources, session.budget_mode)) break;
  }

  return {
    matchedSources,
    rounds,
    attemptedEngines,
    attemptedQueries,
  };
}
