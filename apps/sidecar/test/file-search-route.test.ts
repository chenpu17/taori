import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { buildServer } from '../src/server.js';
import { openDb } from '../src/db/index.js';
import { ControlClient } from '../src/control/client.js';
import { MemoryStore } from '../src/keystore.js';
import { ConversationsRepo, FilesRepo } from '../src/db/repos/index.js';

const bearer = 'test_bearer_file_search';
const auth = { authorization: `Bearer ${bearer}` };

describe('POST /v1/files/search', () => {
  let app: FastifyInstance;
  let dbPath: string;
  let db: ReturnType<typeof openDb>;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `taori-file-search-${Date.now()}-${Math.random()}.db`);
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
  });

  afterEach(async () => {
    await app.close();
    fs.rmSync(dbPath, { force: true });
  });

  it('lazily indexes extracted text and returns filtered snippets', async () => {
    const conv = new ConversationsRepo(db).create({ title: 'file search' });
    const file = new FilesRepo(db).insert({
      conversation_id: conv.id,
      message_id: null,
      original_path: 'notes.md',
      mime_type: 'text/markdown',
      size_bytes: 100,
      extracted_text: [
        'Architecture notes mention sqlite bm25 retrieval for local files.',
        '',
        'A separate paragraph describes budgets and memories.',
      ].join('\n'),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/files/search',
      headers: auth,
      payload: {
        query: 'sqlite bm25',
        conversation_id: conv.id,
        file_ids: [file.id],
        limit: 5,
        include_content: false,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      ok: true;
      data: { results: Array<{ file_id: string; content: string | null; snippet: string }> };
    };
    expect(body.data.results).toHaveLength(1);
    expect(body.data.results[0]).toMatchObject({
      file_id: file.id,
      file_name: 'notes.md',
      content: null,
    });
    expect(body.data.results[0]?.snippet).toContain('sqlite bm25');
  });

  it('returns not_found for explicit missing file ids', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/files/search',
      headers: auth,
      payload: { query: 'anything', file_ids: ['file_missing'] },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'not_found' });
  });
});
