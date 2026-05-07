import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db/index.js';
import { StructuredMemoriesRepo } from '../src/db/repos/index.js';
import { retrieveMemoryContext } from '../src/memory/retrieval.js';

describe('memory retrieval', () => {
  let dbPath: string;
  let db: ReturnType<typeof openDb>;
  let repo: StructuredMemoriesRepo;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `taori-memory-retrieval-${Date.now()}-${Math.random()}.db`);
    db = openDb(dbPath);
    repo = new StructuredMemoriesRepo(db);
  });

  afterEach(() => {
    fs.rmSync(dbPath, { force: true });
  });

  it('returns session memories before global memories and marks them used', () => {
    const global = repo.insert({
      scope: 'global',
      type: 'preference',
      content: '用户偏好简短回答',
    });
    const session = repo.insert({
      scope: 'session',
      scope_id: 'conv_recall',
      type: 'project_fact',
      content: '当前项目使用 Tauri',
    });

    const out = retrieveMemoryContext({
      structuredMemoriesRepo: repo,
      conversationId: 'conv_recall',
      limit: 8,
    });

    expect(out.memories.map((memory) => memory.id)).toEqual([session.id, global.id]);
    expect(out.systemMessage?.content).toContain('当前项目使用 Tauri');
    expect(out.systemMessage?.content).toContain('用户偏好简短回答');
    const touched = repo.list({ includeDisabled: true });
    expect(touched.every((memory) => typeof memory.last_used_at === 'number')).toBe(true);
  });
});
