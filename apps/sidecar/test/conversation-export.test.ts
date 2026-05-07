import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/server.js';
import { ControlClient } from '../src/control/client.js';
import { openDb } from '../src/db/index.js';
import {
  ConversationsRepo,
  CostsRepo,
  MessagesRepo,
  RunEventsRepo,
} from '../src/db/repos/index.js';
import { MemoryStore } from '../src/keystore.js';

const bearer = 'test_bearer_conversation_export';

function newApp() {
  const dbPath = path.join(os.tmpdir(), `taori-conv-export-${Date.now()}-${Math.random()}.db`);
  const db = openDb(dbPath);
  const app = buildServer({
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
  return { app, db, dbPath };
}

describe('conversation markdown export', () => {
  let app: FastifyInstance;
  let db: ReturnType<typeof openDb>;
  let dbPath: string;

  beforeEach(async () => {
    ({ app, db, dbPath } = newApp());
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    fs.rmSync(dbPath, { force: true });
  });

  it('exports chat messages with safe timeline and attachment summaries', async () => {
    const convRepo = new ConversationsRepo(db);
    const msgRepo = new MessagesRepo(db);
    const costsRepo = new CostsRepo(db);
    const runEventsRepo = new RunEventsRepo(db);
    const conv = convRepo.create({ title: '导出 / 测试' });
    const user = msgRepo.insert({
      conversation_id: conv.id,
      role: 'user',
      content: '请总结这个文件',
      status: 'complete',
      attachments: JSON.stringify([
        {
          kind: 'text',
          name: 'notes.md',
          mime: 'text/markdown',
          file_id: 'file_notes',
          size_bytes: 42,
          data_b64: 'SHOULD_NOT_EXPORT',
        },
      ]),
    });
    msgRepo.insert({
      conversation_id: conv.id,
      role: 'assistant',
      content: '总结如下：重点是本地优先。',
      model_id: null,
      status: 'complete',
    });
    costsRepo.insert({
      conversation_id: conv.id,
      source_type: 'message',
      source_id: user.id,
      feature: 'chat',
      model_id: null,
      model_name_snapshot: 'local-preview',
      input_tokens: 12,
      output_tokens: 8,
      price_input_per_1m_snapshot: null,
      price_output_per_1m_snapshot: null,
      price_per_call_snapshot: null,
      estimated_cost_usd: 0.012,
      actual_cost_usd: 0.012,
      success: true,
      duration_ms: 123,
    });
    runEventsRepo.append({
      run_id: 'run_export_test',
      conversation_id: conv.id,
      message_id: user.id,
      kind: 'memory.used',
      status: 'completed',
      label: '使用记忆',
      payload: { count: 2, Authorization: 'Bearer secret' },
    });
    runEventsRepo.append({
      run_id: 'run_export_test',
      conversation_id: conv.id,
      message_id: user.id,
      kind: 'context.file_chunks',
      status: 'completed',
      label: '文件片段',
      payload: {
        token_estimate: 120,
        chunks: [{ file_id: 'file_notes', chunk_index: 0, score: -1.23 }],
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/conversations/${conv.id}/export`,
      headers: { authorization: `Bearer ${bearer}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/markdown');
    expect(res.headers['content-disposition']).toContain('taori-chat-');
    expect(res.payload).toContain('# 导出 / 测试');
    expect(res.payload).toContain('## Timeline 摘要');
    expect(res.payload).toContain('memory.used · 2 条');
    expect(res.payload).toContain('context.file_chunks · 1 个片段');
    expect(res.payload).toContain('notes.md · text · text/markdown · 42 bytes · file_id=file_notes');
    expect(res.payload).toContain('总结如下：重点是本地优先。');
    expect(res.payload).not.toContain('SHOULD_NOT_EXPORT');
    expect(res.payload).not.toContain('Authorization');
    expect(res.payload).not.toContain('Bearer secret');
  });

  it('returns not_found for missing conversations', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/conversations/conv_missing/export',
      headers: { authorization: `Bearer ${bearer}` },
    });

    expect(res.statusCode).toBe(404);
  });
});
