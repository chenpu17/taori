import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { buildServer } from '../src/server.js';
import { openDb } from '../src/db/index.js';
import { ControlClient } from '../src/control/client.js';
import { MemoryStore } from '../src/keystore.js';
import {
  FilesRepo,
  MessagesRepo,
  RunEventsRepo,
} from '../src/db/repos/index.js';

const bearer = 'test_bearer_p2_rag';

describe('P2 RAG MVP', () => {
  let app: FastifyInstance;
  let dbPath: string;
  let db: ReturnType<typeof openDb>;
  let modelId: string;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `taori-p2-rag-${Date.now()}-${Math.random()}.db`);
    db = openDb(dbPath);
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

    const providerRes = await app.inject({
      method: 'POST',
      url: '/v1/providers',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: { name: 'RAG mock', type: 'custom', base_url: 'https://example.invalid/v1' },
    });
    expect(providerRes.statusCode).toBe(201);
    const providerId = (providerRes.json() as { id: string }).id;
    const modelRes = await app.inject({
      method: 'POST',
      url: '/v1/models',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: {
        provider_id: providerId,
        model_name: 'rag-mock-model',
        capability: 'chat',
        display_name: 'RAG Mock',
        is_default_for: 'chat',
        price_input_per_1m: 0.5,
        price_output_per_1m: 1.5,
      },
    });
    expect(modelRes.statusCode).toBe(201);
    modelId = (modelRes.json() as { id: string }).id;
  });

  afterEach(async () => {
    await app.close();
    fs.rmSync(path.join(path.dirname(dbPath), 'files'), { recursive: true, force: true });
    fs.rmSync(dbPath, { force: true });
  });

  it('persists text attachments and injects fallback file chunks for generic prompts', async () => {
    const attachmentText = 'Taori 文档检索使用本地 sqlite bm25 分块，并把相关片段注入回答上下文。';
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: {
        model_id: modelId,
        messages: [{ role: 'user', content: '请总结这个文档' }],
        attachments: [{
          kind: 'text',
          mime: 'text/markdown',
          name: 'note.md',
          data_b64: Buffer.from(attachmentText, 'utf-8').toString('base64'),
        }],
      },
    });

    expect(res.statusCode).toBe(200);
    const meta = JSON.parse(res.payload.split('\n').find((line) => line.startsWith('8:'))!.slice(2))[0] as {
      conversation_id: string;
    };

    const storedFiles = new FilesRepo(db).listByConversation(meta.conversation_id);
    expect(storedFiles).toHaveLength(1);
    expect(storedFiles[0]?.extracted_text).toContain('sqlite bm25');

    const userMessage = new MessagesRepo(db)
      .listByConversation(meta.conversation_id)
      .find((message) => message.role === 'user');
    expect(userMessage?.attachments).toContain('"file_id"');

    const fileEvent = new RunEventsRepo(db)
      .listByConversation(meta.conversation_id)
      .find((event) => event.kind === 'context.file_chunks');
    expect(fileEvent?.payload?.chunks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file_name: expect.stringContaining('note.md'),
          snippet: expect.stringContaining('sqlite bm25'),
        }),
      ]),
    );
  });
});
