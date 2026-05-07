import type {
  StructuredMemoriesRepo,
  StructuredMemoryRow,
} from '../db/repos/index.js';

const MEMORY_TYPE_LABEL: Record<string, string> = {
  preference: '偏好',
  project_fact: '项目事实',
  profile: '用户画像',
  other: '其他',
};

export interface RetrievedMemoryContext {
  memories: StructuredMemoryRow[];
  systemMessage: { role: 'system'; content: string } | null;
}

export function retrieveMemoryContext(args: {
  structuredMemoriesRepo: StructuredMemoriesRepo;
  conversationId: string;
  limit?: number;
}): RetrievedMemoryContext {
  const limit = Math.max(1, Math.min(12, Math.floor(args.limit ?? 8)));
  const session = args.structuredMemoriesRepo.list({
    scope: 'session',
    scopeId: args.conversationId,
    limit,
  });
  const global = args.structuredMemoriesRepo.list({
    scope: 'global',
    limit,
  });
  const seen = new Set<string>();
  const memories: StructuredMemoryRow[] = [];
  for (const memory of [...session, ...global]) {
    const key = `${memory.type}:${memory.content}`;
    if (seen.has(key)) continue;
    seen.add(key);
    memories.push(memory);
    if (memories.length >= limit) break;
  }
  if (memories.length === 0) return { memories, systemMessage: null };

  args.structuredMemoriesRepo.markUsed(memories.map((memory) => memory.id));
  const lines = memories.map((memory) => {
    const label = MEMORY_TYPE_LABEL[memory.type] ?? memory.type;
    return `- [${label}] ${memory.content}`;
  });
  return {
    memories,
    systemMessage: {
      role: 'system',
      content:
        '以下是用户允许 Taori 记住并用于后续回答的长期记忆。请只在相关时使用；如果与当前用户输入冲突，以当前输入为准。\n' +
        lines.join('\n'),
    },
  };
}
