import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db/index.js';
import { MemoriesRepo } from '../src/db/repos/index.js';
import { LocalKvMemoryProvider } from '../src/memory/provider.js';

describe('MemoryProvider', () => {
  let dbPath: string;
  let db: ReturnType<typeof openDb>;
  let provider: LocalKvMemoryProvider;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `taori-memory-provider-${Date.now()}-${Math.random()}.db`);
    db = openDb(dbPath);
    provider = new LocalKvMemoryProvider(new MemoriesRepo(db));
  });

  afterEach(() => {
    fs.rmSync(dbPath, { force: true });
  });

  it('wraps the existing local KV memories repo without changing effective lookup', async () => {
    await provider.set({
      scope: 'global',
      scopeId: null,
      key: 'preferred_tone',
      value: 'concise',
    });
    await provider.set({
      scope: 'session',
      scopeId: 'conv_memory',
      key: 'preferred_tone',
      value: 'detailed',
    });

    await expect(provider.get({
      scope: 'global',
      scopeId: null,
      key: 'preferred_tone',
    })).resolves.toBe('concise');
    await expect(provider.getEffective('conv_memory', 'preferred_tone')).resolves.toBe('detailed');
    await expect(provider.getEffective('other_conv', 'preferred_tone')).resolves.toBe('concise');

    await provider.delete({
      scope: 'session',
      scopeId: 'conv_memory',
      key: 'preferred_tone',
    });
    await expect(provider.getEffective('conv_memory', 'preferred_tone')).resolves.toBe('concise');
  });
});
