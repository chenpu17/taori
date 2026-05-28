import type { ResearchSession } from '@taori/shared';
import type { QueryPlan } from './types.js';
import type { MemoriesRepo, ModelsRepo, ProvidersRepo } from '../../db/repos/index.js';
import type { KeyStore } from '../../keystore.js';
import type { SidecarTestHooksConfig } from '../../config.js';
import { generateLLMQueries } from '../query-planner.js';
import { buildSearchQueries, buildSearchRecoveryQueries } from '../planner.js';

export interface PlanQueryDeps {
  modelsRepo?: ModelsRepo;
  providersRepo?: ProvidersRepo;
  keystore?: KeyStore;
  memories?: MemoriesRepo;
  testHooks?: Pick<SidecarTestHooksConfig, 'hermeticAiPlanner'>;
  log?: { info?: (msg: unknown, extra?: unknown) => void; warn?: (msg: unknown, extra?: unknown) => void; error?: (msg: unknown, extra?: unknown) => void };
}

export async function planPrimaryQueries(
  deps: PlanQueryDeps,
  ctx: { session: ResearchSession; question: string; reason: string },
): Promise<QueryPlan> {
  const { session, question, reason } = ctx;

  const llmPlan = (deps.modelsRepo && deps.providersRepo)
    ? await generateLLMQueries(
        {
          session,
          question: { question, reason: reason || '研究需要' },
          budgetMode: session.budget_mode,
        },
        {
          modelsRepo: deps.modelsRepo,
          providersRepo: deps.providersRepo,
          keystore: deps.keystore ?? null,
          memories: deps.memories ?? null,
          testHooks: deps.testHooks,
          log: deps.log,
        },
      )
    : null;

  const configured = (llmPlan && llmPlan.ok)
    ? llmPlan.queries
    : buildSearchQueries({
        title: session.title,
        objective: session.objective,
        question: { question, reason: reason || '研究需要' },
        budgetMode: session.budget_mode,
        constraints: session.constraints,
      });

  return {
    queries: configured,
    source: llmPlan?.ok ? 'llm' : 'template',
    strategy: llmPlan?.ok ? llmPlan.strategy : null,
    annotated: llmPlan?.ok
      ? llmPlan.annotated.map((a) => ({ query: a.text, intent: a.intent }))
      : null,
  };
}

export async function planRecoveryQueries(
  deps: PlanQueryDeps,
  ctx: { session: ResearchSession; question: string; reason: string },
  attemptedQueries: string[],
): Promise<{ queries: string[]; strategy: string | null; source: 'llm' | 'template' | null }> {
  const { session, question, reason } = ctx;
  const queries = [...attemptedQueries];

  const llmRecovery = (deps.modelsRepo && deps.providersRepo)
    ? await generateLLMQueries(
        {
          session,
          question: { question, reason: reason || '研究需要' },
          budgetMode: session.budget_mode,
          attemptedQueries: queries,
          isRecovery: true,
        },
        {
          modelsRepo: deps.modelsRepo,
          providersRepo: deps.providersRepo,
          keystore: deps.keystore ?? null,
          memories: deps.memories ?? null,
          testHooks: deps.testHooks,
          log: deps.log,
        },
      )
    : null;

  if (llmRecovery?.ok) {
    return {
      queries: llmRecovery.queries,
      strategy: llmRecovery.strategy,
      source: 'llm',
    };
  }

  const recoveryQueries = buildSearchRecoveryQueries({
    title: session.title,
    objective: session.objective,
    question: { question, reason: reason || '研究需要' },
    budgetMode: session.budget_mode,
    constraints: session.constraints,
    originalQueries: queries,
  });
  return {
    queries: recoveryQueries,
    strategy: null,
    source: recoveryQueries.length > 0 ? 'template' : null,
  };
}
