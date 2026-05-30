/**
 * V2b — runAutoTitle integration: gate + model pick + key + (mocked) generateText
 * + rename. The live model call mirrors memory extraction; here generateText is
 * mocked so we cover the wiring without depending on real provider keys.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const generateTextMock = vi.fn();
vi.mock('ai', () => ({
  generateText: (...args: unknown[]) => generateTextMock(...args),
}));

import { openDb } from '../src/db/index.js';
import { MemoryStore } from '../src/keystore.js';
import {
  ConversationsRepo,
  MemoriesRepo,
  ModelsRepo,
  ProvidersRepo,
} from '../src/db/repos/index.js';
import { runAutoTitle, computeAutoTitle } from '../src/chat/auto-title.js';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

describe('runAutoTitle integration', () => {
  let db: ReturnType<typeof openDb>;
  let dbPath: string;
  let keystore: MemoryStore;
  let convRepo: ConversationsRepo;
  let modelsRepo: ModelsRepo;
  let providersRepo: ProvidersRepo;
  let memoriesRepo: MemoriesRepo;
  const log = { warn: () => {} };

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `taori-autotitle-${Date.now()}-${Math.random()}.db`);
    db = openDb(dbPath);
    keystore = new MemoryStore();
    convRepo = new ConversationsRepo(db);
    modelsRepo = new ModelsRepo(db);
    providersRepo = new ProvidersRepo(db);
    memoriesRepo = new MemoriesRepo(db);
    generateTextMock.mockReset();
  });
  afterEach(() => {
    fs.rmSync(dbPath, { force: true });
  });

  async function seedCheapModel(): Promise<string> {
    const prov = providersRepo.create({
      name: 'P',
      type: 'openai',
      base_url: 'https://api.example.com/v1',
      api_key: 'sk-test',
    });
    await keystore.write(prov.api_key_ref!, 'sk-test');
    modelsRepo.create({
      provider_id: prov.id,
      model_name: 'cheap',
      capability: 'chat',
      display_name: 'Cheap',
      price_input_per_1m: 0.01,
      price_output_per_1m: 0.02,
    });
    return prov.id;
  }

  function baseInput(conversationId: string, userText: string) {
    return {
      conversationId,
      userText,
      assistantText: '量子纠缠是一种量子关联现象。',
      convRepo,
      modelsRepo,
      providersRepo,
      memoriesRepo,
      keystore,
      hermetic: false,
      log,
    };
  }

  it('upgrades the auto truncation to a sanitized AI title', async () => {
    await seedCheapModel();
    const userText = '用一句话介绍量子纠缠';
    const conv = convRepo.create({ title: computeAutoTitle(userText) });
    memoriesRepo.set('session', conv.id, 'auto_title_llm_enabled', 'true');
    generateTextMock.mockResolvedValue({ text: '「量子纠缠简介」。' });

    await runAutoTitle(baseInput(conv.id, userText));

    expect(generateTextMock).toHaveBeenCalledOnce();
    expect(convRepo.get(conv.id)?.title).toBe('量子纠缠简介');
  });

  it('keeps the truncation by default without calling a model', async () => {
    await seedCheapModel();
    const userText = '用一句话介绍量子纠缠';
    const conv = convRepo.create({ title: computeAutoTitle(userText) });
    generateTextMock.mockResolvedValue({ text: '量子纠缠简介' });

    await runAutoTitle(baseInput(conv.id, userText));

    expect(generateTextMock).not.toHaveBeenCalled();
    expect(convRepo.get(conv.id)?.title).toBe(computeAutoTitle(userText));
  });

  it('skips the model call entirely in hermetic mode', async () => {
    await seedCheapModel();
    const userText = '帮我看看这段代码';
    const conv = convRepo.create({ title: computeAutoTitle(userText) });

    await runAutoTitle({ ...baseInput(conv.id, userText), hermetic: true });

    expect(generateTextMock).not.toHaveBeenCalled();
    expect(convRepo.get(conv.id)?.title).toBe(computeAutoTitle(userText));
  });

  it('never overrides a manual rename', async () => {
    await seedCheapModel();
    const userText = '帮我看看这段代码';
    const conv = convRepo.create({ title: '我自己起的标题' });
    memoriesRepo.set('session', conv.id, 'auto_title_llm_enabled', 'true');
    generateTextMock.mockResolvedValue({ text: 'AI 标题' });

    await runAutoTitle(baseInput(conv.id, userText));

    expect(generateTextMock).not.toHaveBeenCalled();
    expect(convRepo.get(conv.id)?.title).toBe('我自己起的标题');
  });

  it('leaves the truncation in place when no chat model is available', async () => {
    // no model seeded → pickCheapestActive returns null
    const userText = '用一句话介绍量子纠缠';
    const conv = convRepo.create({ title: computeAutoTitle(userText) });
    memoriesRepo.set('session', conv.id, 'auto_title_llm_enabled', 'true');
    generateTextMock.mockResolvedValue({ text: '量子纠缠简介' });

    await runAutoTitle(baseInput(conv.id, userText));

    expect(generateTextMock).not.toHaveBeenCalled();
    expect(convRepo.get(conv.id)?.title).toBe(computeAutoTitle(userText));
  });

  it('keeps the truncation when the model returns an empty/too-short title', async () => {
    await seedCheapModel();
    const userText = '用一句话介绍量子纠缠';
    const conv = convRepo.create({ title: computeAutoTitle(userText) });
    memoriesRepo.set('session', conv.id, 'auto_title_llm_enabled', 'true');
    generateTextMock.mockResolvedValue({ text: '。' });

    await runAutoTitle(baseInput(conv.id, userText));

    expect(generateTextMock).toHaveBeenCalledOnce();
    expect(convRepo.get(conv.id)?.title).toBe(computeAutoTitle(userText));
  });

  it('does not call a model when the cheapest provider is disabled', async () => {
    const providerId = await seedCheapModel();
    providersRepo.update(providerId, { enabled: false });
    const userText = '用一句话介绍量子纠缠';
    const conv = convRepo.create({ title: computeAutoTitle(userText) });
    memoriesRepo.set('session', conv.id, 'auto_title_llm_enabled', 'true');
    generateTextMock.mockResolvedValue({ text: '量子纠缠简介' });

    await runAutoTitle(baseInput(conv.id, userText));

    expect(generateTextMock).not.toHaveBeenCalled();
    expect(convRepo.get(conv.id)?.title).toBe(computeAutoTitle(userText));
  });
});
