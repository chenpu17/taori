import type { MemoriesRepo } from '../db/repos/index.js';

export type MemoryProviderScope = 'global' | 'session' | 'user';

export interface MemoryKey {
  scope: MemoryProviderScope;
  scopeId: string | null;
  key: string;
}

export interface MemoryProvider {
  kind: 'local-kv' | 'mem0';
  get(input: MemoryKey): Promise<string | null>;
  getEffective(conversationId: string | null, key: string): Promise<string | null>;
  set(input: MemoryKey & { value: string }): Promise<void>;
  delete(input: MemoryKey): Promise<void>;
}

export class LocalKvMemoryProvider implements MemoryProvider {
  readonly kind = 'local-kv' as const;

  constructor(private repo: MemoriesRepo) {}

  async get(input: MemoryKey): Promise<string | null> {
    return this.repo.get(input.scope, input.scope === 'global' ? null : input.scopeId, input.key);
  }

  async getEffective(conversationId: string | null, key: string): Promise<string | null> {
    return this.repo.getEffective(conversationId, key);
  }

  async set(input: MemoryKey & { value: string }): Promise<void> {
    this.repo.set(input.scope, input.scope === 'global' ? null : input.scopeId, input.key, input.value);
  }

  async delete(input: MemoryKey): Promise<void> {
    this.repo.delete(input.scope, input.scope === 'global' ? null : input.scopeId, input.key);
  }
}

export interface Mem0MemoryProviderOptions {
  endpoint: string;
  apiKey?: string | null;
}

export class Mem0MemoryProvider implements MemoryProvider {
  readonly kind = 'mem0' as const;

  constructor(readonly options: Mem0MemoryProviderOptions) {}

  async get(): Promise<string | null> {
    throw new Error('Mem0MemoryProvider is not enabled in this build yet');
  }

  async getEffective(): Promise<string | null> {
    throw new Error('Mem0MemoryProvider is not enabled in this build yet');
  }

  async set(): Promise<void> {
    throw new Error('Mem0MemoryProvider is not enabled in this build yet');
  }

  async delete(): Promise<void> {
    throw new Error('Mem0MemoryProvider is not enabled in this build yet');
  }
}
