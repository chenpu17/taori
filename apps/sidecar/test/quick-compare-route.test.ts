import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { ControlClient } from '../src/control/client.js';
import { openDb } from '../src/db/index.js';
import {
  MessagesRepo,
  ModelsRepo,
  ProvidersRepo,
  QuickCompareRepo,
} from '../src/db/repos/index.js';
import { MemoryStore } from '../src/keystore.js';

const bearer = 'test_bearer_quick_compare_route';
const auth = { authorization: `Bearer ${bearer}` };

describe('quick compare route', () => {
  let app: FastifyInstance;
  let dbPath: string;
  let db: ReturnType<typeof openDb>;
  let models: string[];
  let qcRepo: QuickCompareRepo;
  let msgRepo: MessagesRepo;
  let modelsRepo: ModelsRepo;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `taori-quick-compare-route-${Date.now()}-${Math.random()}.db`);
    db = openDb(dbPath);
    qcRepo = new QuickCompareRepo(db);
    msgRepo = new MessagesRepo(db);
    const providers = new ProvidersRepo(db);
    modelsRepo = new ModelsRepo(db);
    const provider = providers.create({
      name: 'No-key Provider',
      type: 'openai',
      base_url: 'https://example.com/v1',
    });
    models = [0, 1, 2].map((index) =>
      modelsRepo.create({
        provider_id: provider.id,
        model_name: `qc-${index}`,
        display_name: `QC ${index}`,
        capability: 'chat',
        price_input_per_1m: index + 1,
        price_output_per_1m: index + 2,
        context_length: index === 2 ? 100_000 : 8_000,
        supports_tools: index === 2,
        supports_json: index === 2,
      }).id,
    );
    app = buildServer({
      config: {
        port: 0,
        bearer,
        dbPath,
        controlUrl: null,
        controlBearer: null,
        isDev: false,
        version: '0.0.0-test',
      },
      db,
      control: new ControlClient({ url: null, bearer: null }),
      keystore: new MemoryStore(),
      startedAt: Date.now(),
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    fs.rmSync(dbPath, { force: true });
  });

  async function createCompare(): Promise<{ compareId: string; outputIds: string[] }> {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/quick-compare',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: {
        model_ids: [models[0], models[1], models[2]],
        messages: [{ role: 'user', content: '比较三个方案' }],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('"type":"qc.meta"');
    expect(res.body).toContain('"type":"qc.done"');
    const match = /"compare_id":"([^"]+)"/.exec(res.body);
    expect(match?.[1]).toBeTruthy();
    const outputs = qcRepo.listOutputs(match![1]!);
    expect(outputs).toHaveLength(3);
    expect(outputs.every((output) => output.status === 'complete')).toBe(true);
    expect(outputs.map((output) => output.content)).toEqual(
      expect.arrayContaining([expect.stringContaining('Quick Compare 本地预览')]),
    );
    return { compareId: match![1]!, outputIds: outputs.map((output) => output.id) };
  }

  it('streams compare annotations and persists outputs without assistant messages', async () => {
    await createCompare();
  });

  it('returns detail, adopts an output, and retries an output', async () => {
    const { compareId, outputIds } = await createCompare();

    const detailRes = await app.inject({
      method: 'GET',
      url: `/v1/quick-compare/${compareId}`,
      headers: auth,
    });
    expect(detailRes.statusCode).toBe(200);
    expect(detailRes.json().data.outputs).toHaveLength(3);

    const adoptRes = await app.inject({
      method: 'POST',
      url: `/v1/quick-compare/${compareId}/outputs/${outputIds[0]}/adopt`,
      headers: { ...auth, 'content-type': 'application/json' },
      payload: {},
    });
    expect(adoptRes.statusCode).toBe(200);
    const assistantId = adoptRes.json().data.assistant_message_id as string;
    expect(msgRepo.get(assistantId)?.role).toBe('assistant');
    expect(qcRepo.getRun(compareId)?.adopted_output_id).toBe(outputIds[0]);

    const retryRes = await app.inject({
      method: 'POST',
      url: `/v1/quick-compare/${compareId}/retry`,
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { output_id: outputIds[1] },
    });
    expect(retryRes.statusCode).toBe(200);
    expect(retryRes.body).toContain('"type":"qc.done"');
    expect(qcRepo.getOutput(outputIds[1])?.status).toBe('complete');
  });

  it('returns user-facing validation errors for ineligible requested models', async () => {
    const provider = new ProvidersRepo(db).list()[0]!;
    const disabledModel = modelsRepo.create({
      provider_id: provider.id,
      model_name: 'qc-disabled',
      display_name: 'Disabled Candidate',
      capability: 'chat',
      enabled: false,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/quick-compare',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: {
        model_ids: [models[0], disabledModel.id],
        messages: [{ role: 'user', content: '比较两个方案' }],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('Disabled Candidate');
    expect(res.json().message).not.toContain(disabledModel.id);
  });

  it('returns a current-model specific message when the first requested model is demoted', async () => {
    modelsRepo.recordFailure(models[0]!, 'network');
    modelsRepo.recordFailure(models[0]!, 'network');
    modelsRepo.recordFailure(models[0]!, 'network');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/quick-compare',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: {
        model_ids: [models[0], models[1]],
        messages: [{ role: 'user', content: '比较两个方案' }],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('当前会话模型暂不可用于 Quick Compare');
    expect(res.json().message).not.toContain(models[0]);
  });
});
