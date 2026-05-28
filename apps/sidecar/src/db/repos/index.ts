/**
 * Barrel file — re-exports everything from per-Repo modules.
 *
 * Import paths outside this directory remain unchanged:
 *   import { ProvidersRepo, ModelsRepo, … } from '../repos/index.js';
 */

import type { Db } from '../index.js';
import { ProvidersRepo } from './providers.js';
import { ModelsRepo } from './models.js';
import { McpServersRepo } from './mcp-servers.js';
import { PromptTemplatesRepo } from './prompt-templates.js';
import { PersonasRepo } from './personas.js';
import { WorkflowRecipesRepo } from './workflow-recipes.js';
import { ResearchRepo } from './research.js';
import { ConversationsRepo } from './conversations.js';
import { MessagesRepo } from './messages.js';
import { QuickCompareRepo } from './quick-compare.js';
import { RunEventsRepo } from './run-events.js';
import { CostsRepo } from './costs.js';
import { MemoriesRepo } from './memories.js';
import { StructuredMemoriesRepo } from './structured-memories.js';
import { FilesRepo } from './files.js';
import { FileChunksRepo } from './file-chunks.js';
import { RoundtablesRepo } from './roundtables.js';
import { RoundtableMessagesRepo } from './roundtable-messages.js';

// Repos
export { ProvidersRepo } from './providers.js';
export { ModelsRepo } from './models.js';
export { McpServersRepo } from './mcp-servers.js';
export { PromptTemplatesRepo } from './prompt-templates.js';
export { PersonasRepo } from './personas.js';
export { WorkflowRecipesRepo } from './workflow-recipes.js';
export { ResearchRepo } from './research.js';
export type { ResearchSessionPatch, ResearchTaskSeed } from './research.js';
export { ConversationsRepo } from './conversations.js';
export type { ConversationRow } from './conversations.js';
export { MessagesRepo } from './messages.js';
export type { MessageRow } from './messages.js';
export { QuickCompareRepo } from './quick-compare.js';
export type { QuickCompareRunCreate, QuickCompareOutputCreate, QuickCompareOutputPatch } from './quick-compare.js';
export { RunEventsRepo } from './run-events.js';
export type { RunEventInsert } from './run-events.js';
export { CostsRepo } from './costs.js';
export type { CostInsert, CostRecord, CostCallLogRow } from './costs.js';
export { MemoriesRepo } from './memories.js';
export { StructuredMemoriesRepo } from './structured-memories.js';
export type { StructuredMemoryScope, StructuredMemoryType, StructuredMemoryInsert, StructuredMemoryRow } from './structured-memories.js';
export { FilesRepo } from './files.js';
export type { FileInsert, FileRow } from './files.js';
export { FileChunksRepo } from './file-chunks.js';
export type { FileChunkInsert } from './file-chunks.js';
export { RoundtablesRepo } from './roundtables.js';
export type { RoundtableInsert, RoundtableRow } from './roundtables.js';
export { RoundtableMessagesRepo } from './roundtable-messages.js';
export type { RoundtableMessageInsert, RoundtableMessageRow } from './roundtable-messages.js';

// Shared helpers
export { pickDefined, isForeignKeyConstraintError } from './shared.js';

// Mappers
export { toProvider, toModel, stringifyPricingMeta, parseStringArray, parseConversationTags } from './mappers.js';

// ===========================================================================
// Centralized repo container — built once in server.ts, passed to all routes
// ===========================================================================

export interface Repos {
  providers: ProvidersRepo;
  models: ModelsRepo;
  mcpServers: McpServersRepo;
  promptTemplates: PromptTemplatesRepo;
  personas: PersonasRepo;
  workflowRecipes: WorkflowRecipesRepo;
  research: ResearchRepo;
  conversations: ConversationsRepo;
  messages: MessagesRepo;
  quickCompare: QuickCompareRepo;
  runEvents: RunEventsRepo;
  costs: CostsRepo;
  memories: MemoriesRepo;
  structuredMemories: StructuredMemoriesRepo;
  files: FilesRepo;
  fileChunks: FileChunksRepo;
  roundtables: RoundtablesRepo;
  roundtableMessages: RoundtableMessagesRepo;
}

export function buildRepos(db: Db): Repos {
  return {
    providers: new ProvidersRepo(db),
    models: new ModelsRepo(db),
    mcpServers: new McpServersRepo(db),
    promptTemplates: new PromptTemplatesRepo(db),
    personas: new PersonasRepo(db),
    workflowRecipes: new WorkflowRecipesRepo(db),
    research: new ResearchRepo(db),
    conversations: new ConversationsRepo(db),
    messages: new MessagesRepo(db),
    quickCompare: new QuickCompareRepo(db),
    runEvents: new RunEventsRepo(db),
    costs: new CostsRepo(db),
    memories: new MemoriesRepo(db),
    structuredMemories: new StructuredMemoriesRepo(db),
    files: new FilesRepo(db),
    fileChunks: new FileChunksRepo(db),
    roundtables: new RoundtablesRepo(db),
    roundtableMessages: new RoundtableMessagesRepo(db),
  };
}
