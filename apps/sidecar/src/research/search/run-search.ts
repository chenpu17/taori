import type { ResearchSource } from '@taori/shared';
import type { CapabilityBus } from '../../bus/index.js';
import type { MemoriesRepo, ModelsRepo, ProvidersRepo, ResearchRepo } from '../../db/repos/index.js';
import type { KeyStore } from '../../keystore.js';
import type { SidecarTestHooksConfig } from '../../config.js';
import type { SearchContext } from './types.js';
import { planPrimaryQueries, planRecoveryQueries } from './plan-queries.js';
import type { PlanQueryDeps } from './plan-queries.js';
import { executePhase } from './execute-phase.js';
import type { ExecutePhaseDeps } from './execute-phase.js';
import { uniqueSearchQueries, countUniqueHosts } from './execute-phase.js';
import { collectSourcesForQuestion } from './execute-round.js';
import { buildSearchSuccessOutput, buildSearchFailureOutput } from './build-output.js';

export interface SearchDeps {
  repo: ResearchRepo;
  bus: CapabilityBus;
  modelsRepo?: ModelsRepo;
  providersRepo?: ProvidersRepo;
  keystore?: KeyStore;
  memories?: MemoriesRepo;
  testHooks?: Pick<SidecarTestHooksConfig, 'hermeticAiPlanner'>;
  log?: { info?: (msg: unknown, extra?: unknown) => void; warn?: (msg: unknown, extra?: unknown) => void; error?: (msg: unknown, extra?: unknown) => void };
  bumpBudgetSpend: (sessionId: string, actualUsd: number | undefined) => void;
}

export async function runSearch(deps: SearchDeps, ctx: SearchContext): Promise<void> {
  const { session, task, searchToolName, question, questionId, reason } = ctx;

  const planDeps: PlanQueryDeps = {
    modelsRepo: deps.modelsRepo,
    providersRepo: deps.providersRepo,
    keystore: deps.keystore,
    memories: deps.memories,
    testHooks: deps.testHooks,
    log: deps.log,
  };

  const primary = await planPrimaryQueries(planDeps, { session, question, reason });

  const allQueries = uniqueSearchQueries([
    String(task.input?.query ?? '').trim(),
    ...primary.queries,
    question,
  ]);
  if (allQueries.length === 0) {
    deps.repo.updateTask(task.id, { output: { reason: 'empty_query' } });
    return;
  }

  const phaseDeps: ExecutePhaseDeps = {
    repo: deps.repo,
    bus: deps.bus,
    memories: deps.memories,
    log: deps.log,
    bumpBudgetSpend: deps.bumpBudgetSpend,
  };

  const primaryResult = await executePhase(
    phaseDeps,
    { session, searchToolName, question, questionId },
    allQueries,
    'primary',
  );

  let recoveryQueries: string[] = [];
  let recoveryStrategy: string | null = null;
  let recoverySource: 'llm' | 'template' | null = null;

  if (primaryResult.matchedSources.length === 0) {
    const recoveryPlan = await planRecoveryQueries(
      planDeps,
      { session, question, reason },
      primaryResult.attemptedQueries,
    );
    recoveryQueries = recoveryPlan.queries;
    recoveryStrategy = recoveryPlan.strategy;
    recoverySource = recoveryPlan.source;
  }

  const matchedSources = [...primaryResult.matchedSources];
  const rounds = [...primaryResult.rounds];
  const attemptedEngines = new Set(primaryResult.attemptedEngines);
  const attemptedQueries = uniqueSearchQueries([...primaryResult.attemptedQueries, ...recoveryQueries]);

  if (matchedSources.length === 0 && recoveryQueries.length > 0) {
    const recoveryResult = await executePhase(
      phaseDeps,
      { session, searchToolName, question, questionId },
      recoveryQueries,
      'recovery',
    );
    matchedSources.push(...recoveryResult.matchedSources);
    rounds.push(...recoveryResult.rounds);
    recoveryResult.rounds.forEach((round) => {
      if (round.search_engine) attemptedEngines.add(round.search_engine);
      if (round.requested_engine) attemptedEngines.add(round.requested_engine);
    });
  }

  const outputParams = {
    queries: allQueries,
    attemptedQueries,
    rounds,
    searchToolName,
    attemptedEngines,
    recoveryQueries,
    recoveryStrategy,
    recoverySource,
    querySource: primary.source,
    queryStrategy: primary.strategy,
    annotatedQueries: primary.annotated,
    countUniqueHosts,
  };

  if (matchedSources.length === 0) {
    deps.repo.updateTask(task.id, {
      output: buildSearchFailureOutput({
        ...outputParams,
        session: { title: session.title, objective: session.objective },
        question,
        reason,
      }),
    });
  } else {
    deps.repo.updateTask(task.id, {
      output: buildSearchSuccessOutput({
        ...outputParams,
        matchedSources,
      }),
    });
  }
}
