import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db/index.js';
import {
  ConversationsRepo,
  ModelsRepo,
  ProvidersRepo,
  QuickCompareRepo,
} from '../src/db/repos/index.js';

describe('QuickCompareRepo', () => {
  let dbPath: string;
  let db: ReturnType<typeof openDb>;
  let repo: QuickCompareRepo;
  let conversationId: string;
  let modelId: string;
  let providerId: string;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `taori-quick-compare-${Date.now()}-${Math.random()}.db`);
    db = openDb(dbPath);
    repo = new QuickCompareRepo(db);
    const provider = new ProvidersRepo(db).create({
      name: 'QC Provider',
      type: 'openai',
      base_url: 'https://example.com/v1',
    });
    const model = new ModelsRepo(db).create({
      provider_id: provider.id,
      model_name: 'qc-model',
      display_name: 'QC Model',
      capability: 'chat',
      price_input_per_1m: 1,
      price_output_per_1m: 2,
    });
    conversationId = new ConversationsRepo(db).create({ title: 'Quick Compare' }).id;
    providerId = provider.id;
    modelId = model.id;
  });

  afterEach(() => {
    fs.rmSync(dbPath, { force: true });
  });

  it('stores compare runs, outputs, status transitions, and adoption', () => {
    const run = repo.createRun({
      conversation_id: conversationId,
      source_user_message_id: null,
      run_id: 'run_qc_test',
      model_ids: [modelId, 'mdl_peer_model'],
    });
    expect(run.id).toMatch(/^qc_/);
    expect(run.status).toBe('running');
    expect(run.model_ids).toEqual([modelId, 'mdl_peer_model']);

    const output = repo.createOutput({
      compare_id: run.id,
      participant_index: 0,
      model_id: modelId,
      provider_id: providerId,
    });
    expect(output.id).toMatch(/^qcout_/);
    expect(output.status).toBe('pending');

    const completed = repo.patchOutput(output.id, {
      content: '候选回答',
      status: 'complete',
      first_token_ms: 120,
      duration_ms: 900,
    });
    expect(completed?.content).toBe('候选回答');
    expect(completed?.first_token_ms).toBe(120);
    expect(repo.listOutputs(run.id).map((item) => item.id)).toEqual([output.id]);

    expect(repo.markAdopted(run.id, output.id)?.adopted_output_id).toBe(output.id);
    expect(repo.updateRunStatus(run.id, 'completed')?.status).toBe('completed');
    expect(repo.listRunsByConversation(conversationId)[0]?.id).toBe(run.id);
  });
});
