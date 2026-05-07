import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db/index.js';
import {
  CostsRepo,
  MemoriesRepo,
  ModelsRepo,
  ProvidersRepo,
} from '../src/db/repos/index.js';
import { evaluateBudgetGuard } from '../src/cost/budget-guard.js';

describe('budget guard', () => {
  let dbPath: string;
  let db: ReturnType<typeof openDb>;
  let costsRepo: CostsRepo;
  let memoriesRepo: MemoriesRepo;
  let model: ReturnType<ModelsRepo['create']>;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `taori-budget-guard-${Date.now()}-${Math.random()}.db`);
    db = openDb(dbPath);
    costsRepo = new CostsRepo(db);
    memoriesRepo = new MemoriesRepo(db);
    const provider = new ProvidersRepo(db).create({
      name: 'Budget Provider',
      type: 'openrouter',
      base_url: 'https://example.invalid',
      api_key: null,
    });
    model = new ModelsRepo(db).create({
      provider_id: provider.id,
      model_name: 'budget-model',
      capability: 'chat',
      display_name: 'Budget Model',
      price_per_call: 0.02,
    });
  });

  afterEach(() => {
    fs.rmSync(dbPath, { force: true });
  });

  function decide(overrides: Partial<Parameters<typeof evaluateBudgetGuard>[0]> = {}) {
    return evaluateBudgetGuard({
      confirmed: false,
      conversationId: 'conv_budget',
      model,
      inputText: 'hello',
      costsRepo,
      memoriesRepo,
      ...overrides,
    });
  }

  it('confirms when the estimated call exceeds the threshold', () => {
    memoriesRepo.set('global', null, 'cost_confirm_threshold_usd', '0.001');
    const decision = decide();
    expect(decision.kind).toBe('confirm');
    expect(decision.reason).toBe('threshold');
    expect(decision.estimate_usd).toBe(0.02);
  });

  it('confirmed bypasses threshold and soft monthly budget', () => {
    memoriesRepo.set('global', null, 'cost_confirm_threshold_usd', '0.001');
    memoriesRepo.set('global', null, 'monthly_budget_usd', '0.01');
    const decision = decide({ confirmed: true });
    expect(decision.kind).toBe('allow');
    expect(decision.reason).toBeNull();
  });

  it('blocks confirmed calls when hard monthly budget would be exceeded', () => {
    memoriesRepo.set('global', null, 'monthly_budget_usd', '0.01');
    memoriesRepo.set('global', null, 'monthly_budget_hard_limit', 'true');
    const decision = decide({ confirmed: true });
    expect(decision.kind).toBe('block');
    expect(decision.reason).toBe('budget');
    expect(decision.hard_limit).toBe(true);
  });

  it('respects disabled model threshold while still enforcing monthly budget', () => {
    memoriesRepo.set('global', null, 'cost_confirm_threshold_usd', '0.001');
    memoriesRepo.set('global', null, 'cost_confirm_disabled_models', JSON.stringify([model.id]));
    expect(decide().kind).toBe('allow');

    memoriesRepo.set('global', null, 'monthly_budget_usd', '0.01');
    const decision = decide();
    expect(decision.kind).toBe('confirm');
    expect(decision.reason).toBe('budget');
  });
});
