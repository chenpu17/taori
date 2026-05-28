import type { ResearchSource } from '@taori/shared';
import type { SearchRoundSummary } from './types.js';
import { classifySearchFailureReason } from '../planner.js';

export interface SearchSuccessParams {
  matchedSources: ResearchSource[];
  queries: string[];
  attemptedQueries: string[];
  rounds: SearchRoundSummary[];
  searchToolName: string;
  attemptedEngines: Set<string>;
  recoveryQueries: string[];
  recoveryStrategy: string | null;
  recoverySource: 'llm' | 'template' | null;
  querySource: 'llm' | 'template';
  queryStrategy: string | null;
  annotatedQueries: Array<{ query: string; intent: string }> | null;
  countUniqueHosts: (sources: ResearchSource[]) => number;
}

export function buildSearchSuccessOutput(params: SearchSuccessParams): Record<string, unknown> {
  const {
    matchedSources,
    queries,
    rounds,
    searchToolName,
    attemptedEngines,
    recoveryQueries,
    recoveryStrategy,
    recoverySource,
    querySource,
    queryStrategy,
    annotatedQueries,
    countUniqueHosts,
  } = params;
  const lastRound = rounds.at(-1) ?? null;

  return {
    hits: matchedSources.length,
    query: queries[0],
    queries: rounds.map((round) => round.query),
    rounds,
    rounds_completed: rounds.length,
    unique_hosts: countUniqueHosts(matchedSources),
    search_tool: searchToolName,
    engine_attempts: Array.from(attemptedEngines),
    search_engine: lastRound?.search_engine ?? null,
    search_fallback_from: rounds.find((round) => round.search_fallback_from)?.search_fallback_from ?? null,
    recovery_attempted: recoveryQueries.length > 0,
    recovery_queries: recoveryQueries,
    recovery_strategy: recoveryStrategy,
    recovery_source: recoverySource,
    recovery_successful: recoveryQueries.length > 0 && rounds.some((round) => round.phase === 'recovery' && round.hits > 0),
    query_source: querySource,
    query_strategy: queryStrategy,
    query_plan: annotatedQueries,
  };
}

export interface SearchFailureParams extends Omit<SearchSuccessParams, 'matchedSources'> {
  session: { title: string; objective: string };
  question: string;
  reason: string;
  matchedSources?: never;
}

export function buildSearchFailureOutput(
  params: SearchFailureParams,
): Record<string, unknown> {
  const {
    queries,
    attemptedQueries,
    rounds,
    searchToolName,
    attemptedEngines,
    recoveryQueries,
    recoveryStrategy,
    recoverySource,
    querySource,
    queryStrategy,
    annotatedQueries,
    session,
    question,
    reason,
  } = params;

  const failureReason = classifySearchFailureReason({
    title: session.title,
    objective: session.objective,
    question,
    reason: reason || '研究需要',
    attemptedRecovery: recoveryQueries.length > 0,
  });

  return {
    hits: 0,
    query: queries[0],
    queries: attemptedQueries,
    rounds,
    rounds_completed: rounds.length,
    unique_hosts: 0,
    search_tool: searchToolName,
    engine_attempts: Array.from(attemptedEngines),
    search_engine: rounds.at(-1)?.search_engine ?? null,
    search_fallback_from: rounds.find((round) => round.search_fallback_from)?.search_fallback_from ?? null,
    recovery_attempted: recoveryQueries.length > 0,
    recovery_queries: recoveryQueries,
    recovery_strategy: recoveryStrategy,
    recovery_source: recoverySource,
    query_source: querySource,
    query_strategy: queryStrategy,
    query_plan: annotatedQueries,
    failure_reason: failureReason,
    coverage_status: 'no_usable_sources',
  };
}
