import type { ResearchSource, ResearchSession, ResearchTask } from '@taori/shared';

export type SearchEngine = 'duckduckgo' | 'exa' | 'bocha';
export type SourceKind = 'official' | 'third_party' | 'community';
export type SearchPhase = 'primary' | 'recovery';

export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchRoundSummary {
  query: string;
  hits: number;
  total_sources: number;
  unique_hosts: number;
  requested_engine?: SearchEngine | null;
  search_engine: string | null;
  search_fallback_from: string | null;
  search_track: SourceKind;
  phase: SearchPhase;
  error?: string | null;
}

export interface QueryPlan {
  queries: string[];
  source: 'llm' | 'template';
  strategy: string | null;
  annotated: Array<{ query: string; intent: string }> | null;
}

export interface PhaseResult {
  matchedSources: ResearchSource[];
  rounds: SearchRoundSummary[];
  attemptedEngines: Set<string>;
  attemptedQueries: string[];
}

export interface SearchContext {
  session: ResearchSession;
  task: ResearchTask;
  searchToolName: string;
  question: string;
  questionId: string | undefined;
  reason: string;
}

export const SEARCH_RESULTS_PER_TASK = 8;
export const FETCH_TOP_N = 4;
export const FETCH_MAX_CHARS = 5000;
