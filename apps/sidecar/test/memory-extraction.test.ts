import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db/index.js';
import {
  MemoriesRepo,
  ModelsRepo,
  ProvidersRepo,
  RunEventsRepo,
  StructuredMemoriesRepo,
} from '../src/db/repos/index.js';
import { MemoryStore } from '../src/keystore.js';
import {
  MEMORY_LOCAL_ONLY_KEY,
  parseAutoMemoryCandidates,
  pickExtractionModel,
  type ScheduleMemoryExtractionInput,
} from '../src/memory/extraction.js';

describe('memory extraction helpers', () => {
  it('parses fenced JSON arrays and removes duplicates', () => {
    const out = parseAutoMemoryCandidates(`
\`\`\`json
[
  { "type": "preference", "content": " 用户偏好简短回答 " },
  { "type": "preference", "content": "用户偏好简短回答" },
  { "type": "project_fact", "content": "当前项目使用 Tauri + React" }
]
\`\`\`
`);
    expect(out).toEqual([
      { type: 'preference', content: '用户偏好简短回答' },
      { type: 'project_fact', content: '当前项目使用 Tauri + React' },
    ]);
  });

  it('returns an empty list for invalid or unsafe shapes', () => {
    expect(parseAutoMemoryCandidates('not json')).toEqual([]);
    expect(parseAutoMemoryCandidates('[{"type":"secret","content":"abc123"}]')).toEqual([]);
  });
});

describe('memory extraction model selection', () => {
  let dbPath: string;
  let db: ReturnType<typeof openDb>;
  let memoriesRepo: MemoriesRepo;
  let modelsRepo: ModelsRepo;
  let providersRepo: ProvidersRepo;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `taori-memory-extraction-${Date.now()}-${Math.random()}.db`);
    db = openDb(dbPath);
    memoriesRepo = new MemoriesRepo(db);
    modelsRepo = new ModelsRepo(db);
    providersRepo = new ProvidersRepo(db);
  });

  afterEach(() => {
    fs.rmSync(dbPath, { force: true });
  });

  function input(): ScheduleMemoryExtractionInput {
    return {
      conversationId: 'conv_memory_local',
      sourceUserMessageId: 'msg_user',
      assistantMessageId: 'msg_assistant',
      userText: '用户偏好简短回答',
      assistantText: '好的，我会记住。',
      memoriesRepo,
      structuredMemoriesRepo: new StructuredMemoriesRepo(db),
      modelsRepo,
      providersRepo,
      runEventsRepo: new RunEventsRepo(db),
      keystore: new MemoryStore(),
      log: { warn: () => undefined, info: () => undefined },
      runId: 'run_memory',
    };
  }

  it('uses the configured remote extractor when local-only mode is off', () => {
    const remoteProvider = providersRepo.create({
      name: 'remote',
      type: 'openai',
      base_url: 'https://api.openai.com/v1',
      api_key: 'sk-test',
    });
    const localProvider = providersRepo.create({
      name: 'ollama',
      type: 'ollama',
      base_url: 'http://127.0.0.1:11434',
    });
    const remote = modelsRepo.create({
      provider_id: remoteProvider.id,
      model_name: 'gpt-4o-mini',
      display_name: 'GPT-4o mini',
      capability: 'chat',
      price_input_per_1m: 0.15,
    });
    modelsRepo.create({
      provider_id: localProvider.id,
      model_name: 'llama3.2:latest',
      display_name: 'Llama 3.2',
      capability: 'chat',
      price_input_per_1m: 0,
    });
    memoriesRepo.set('global', null, 'memory_extraction_model_id', remote.id);

    expect(pickExtractionModel(input())?.id).toBe(remote.id);
  });

  it('blocks a configured remote extractor and picks Ollama when local-only mode is on', () => {
    const remoteProvider = providersRepo.create({
      name: 'remote',
      type: 'openai',
      base_url: 'https://api.openai.com/v1',
      api_key: 'sk-test',
    });
    const localProvider = providersRepo.create({
      name: 'ollama',
      type: 'ollama',
      base_url: 'http://127.0.0.1:11434',
    });
    const remote = modelsRepo.create({
      provider_id: remoteProvider.id,
      model_name: 'gpt-4o-mini',
      display_name: 'GPT-4o mini',
      capability: 'chat',
      price_input_per_1m: 0.15,
    });
    const local = modelsRepo.create({
      provider_id: localProvider.id,
      model_name: 'llama3.2:latest',
      display_name: 'Llama 3.2',
      capability: 'chat',
      price_input_per_1m: 0,
    });
    memoriesRepo.set('global', null, 'memory_extraction_model_id', remote.id);
    memoriesRepo.set('global', null, MEMORY_LOCAL_ONLY_KEY, 'true');

    expect(pickExtractionModel(input())?.id).toBe(local.id);
  });
});
