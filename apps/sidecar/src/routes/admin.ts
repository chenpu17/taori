/**
 * Admin / danger-zone routes.
 *
 * Surface area:
 *   - `POST /v1/admin/clear-all-data`
 *   - `GET  /v1/admin/export-data`
 *   - `POST /v1/admin/import-data`
 *
 * Export/import is JSON-only and deliberately redacts API keys. Provider rows
 * carry `had_api_key=true` as a hint so the renderer can warn users that keys
 * must be re-entered after restore.
 */

import type { FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import {
  BackupImportRequestSchema,
  type BackupConflictStrategy,
  type BackupCounts,
  type BackupData,
  type BackupFileRecord,
  type BackupProviderRecord,
  type BackupPackage,
  TaoriError,
  makeId,
  PricingMetaSchema,
} from '@taori/shared';
import type { BuildServerArgs } from '../server.js';
import {
  providers,
  models,
  conversations,
  messages,
  files,
  memories,
  prompt_templates,
  personas,
  workflow_recipes,
  cost_records,
  mcp_servers,
  roundtables,
  roundtable_messages,
} from '../db/schema.js';

type ProviderRow = typeof providers.$inferSelect;
type ModelRow = typeof models.$inferSelect;
type ConversationRow = typeof conversations.$inferSelect;
type MessageRow = typeof messages.$inferSelect;
type FileRow = typeof files.$inferSelect;
type MemoryRow = typeof memories.$inferSelect;
type PromptTemplateRow = typeof prompt_templates.$inferSelect;
type PersonaRow = typeof personas.$inferSelect;
type CostRow = typeof cost_records.$inferSelect;
type RoundtableRow = typeof roundtables.$inferSelect;
type RoundtableMessageRow = typeof roundtable_messages.$inferSelect;

type PrefixKind =
  | 'provider'
  | 'model'
  | 'conversation'
  | 'message'
  | 'file'
  | 'memory'
  | 'cost'
  | 'roundtable'
  | 'roundtable_message'
  | 'prompt_template'
  | 'persona';

const EMPTY_COUNTS = (): BackupCounts => ({
  providers: 0,
  models: 0,
  conversations: 0,
  messages: 0,
  files: 0,
  memories: 0,
  prompt_templates: 0,
  personas: 0,
  cost_records: 0,
  roundtables: 0,
  roundtable_messages: 0,
});

function filesDir(dbPath: string): string {
  return path.join(path.dirname(dbPath), 'files');
}

function appendCnSuffix(value: string | null, max = 200): string | null {
  if (!value) return value;
  return `${value}（导入）`.slice(0, max);
}

function appendAsciiSuffix(value: string | null): string | null {
  if (!value) return value;
  return `${value}-imported`;
}

function mimeExtension(mime: string): string {
  const clean = mime.toLowerCase();
  if (clean === 'image/png') return '.png';
  if (clean === 'image/jpeg') return '.jpg';
  if (clean === 'image/webp') return '.webp';
  if (clean === 'image/gif') return '.gif';
  if (clean === 'application/pdf') return '.pdf';
  if (clean.startsWith('text/markdown')) return '.md';
  if (clean.startsWith('text/plain')) return '.txt';
  return '.bin';
}

function parseJsonArray<T extends Record<string, unknown>>(raw: string | null): T[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : null;
  } catch {
    return null;
  }
}

function remapMessageAttachments(
  raw: string | null,
  fileIdMap: Map<string, string>,
): string | null {
  if (!raw) return raw;
  const arr = parseJsonArray<Record<string, unknown>>(raw);
  if (!arr) return raw;
  let changed = false;
  const next = arr.map((item) => {
    const fileId = typeof item.file_id === 'string' ? item.file_id : null;
    const mapped = fileId ? fileIdMap.get(fileId) : null;
    if (!mapped || mapped === fileId) return item;
    changed = true;
    return { ...item, file_id: mapped };
  });
  return changed ? JSON.stringify(next) : raw;
}

function remapParticipants(raw: string, modelIdMap: Map<string, string>): string {
  const arr = parseJsonArray<Record<string, unknown>>(raw);
  if (!arr) return raw;
  let changed = false;
  const next = arr.map((item) => {
    const modelId = typeof item.model_id === 'string' ? item.model_id : null;
    const mapped = modelId ? modelIdMap.get(modelId) : null;
    if (!mapped || mapped === modelId) return item;
    changed = true;
    return { ...item, model_id: mapped };
  });
  return changed ? JSON.stringify(next) : raw;
}

function makeUniqueId(kind: PrefixKind, existing: Set<string>): string {
  let id = makeId(kind);
  while (existing.has(id)) id = makeId(kind);
  existing.add(id);
  return id;
}

function maybeRenameId(
  kind: PrefixKind,
  oldId: string,
  strategy: BackupConflictStrategy,
  existing: Set<string>,
  renamed: BackupCounts,
  countKey: keyof BackupCounts,
  map: Map<string, string>,
): void {
  if (!existing.has(oldId)) {
    existing.add(oldId);
    return;
  }
  if (strategy !== 'rename') return;
  const next = makeUniqueId(kind, existing);
  map.set(oldId, next);
  renamed[countKey] += 1;
}

function remap<T extends string | null>(value: T, map: Map<string, string>): T {
  if (!value) return value;
  return (map.get(value) ?? value) as T;
}

async function readFileAsBase64(filePath: string | null): Promise<string | null> {
  if (!filePath) return null;
  try {
    const buf = await fs.readFile(filePath);
    return buf.toString('base64');
  } catch {
    return null;
  }
}

async function collectBackup(deps: BuildServerArgs): Promise<BackupPackage> {
  const providerRows = deps.db.select().from(providers).all() as ProviderRow[];
  const modelRows = deps.db.select().from(models).all() as ModelRow[];
  const conversationRows = deps.db.select().from(conversations).all() as ConversationRow[];
  const messageRows = deps.db.select().from(messages).all() as MessageRow[];
  const fileRows = deps.db.select().from(files).all() as FileRow[];
  const memoryRows = deps.db.select().from(memories).all() as MemoryRow[];
  const promptTemplateRows = deps.db.select().from(prompt_templates).all() as PromptTemplateRow[];
  const personaRows = deps.db.select().from(personas).all() as PersonaRow[];
  const costRows = deps.db.select().from(cost_records).all() as CostRow[];
  const roundtableRows = deps.db.select().from(roundtables).all() as RoundtableRow[];
  const roundtableMessageRows =
    deps.db.select().from(roundtable_messages).all() as RoundtableMessageRow[];

  const warnings: string[] = [];
  const exportedFiles: BackupFileRecord[] = [];
  for (const row of fileRows) {
    const data_b64 = await readFileAsBase64(row.original_path);
    if (row.original_path && data_b64 == null) {
      warnings.push(`file ${row.id} bytes missing; exported as metadata only`);
    }
    exportedFiles.push({
      ...row,
      data_b64,
    });
  }

  const data: BackupData = {
    providers: providerRows.map<BackupProviderRecord>(({ api_key_ref, ...row }) => ({
      ...row,
      type: row.type as BackupProviderRecord['type'],
      had_api_key: !!api_key_ref,
    })),
    models: modelRows.map((row) => ({
      ...row,
      pricing_meta: parsePricingMetaBackup(row.pricing_meta),
    })),
    conversations: conversationRows,
    messages: messageRows,
    files: exportedFiles,
    memories: memoryRows,
    prompt_templates: promptTemplateRows,
    personas: personaRows,
    cost_records: costRows,
    roundtables: roundtableRows,
    roundtable_messages: roundtableMessageRows,
  };

  const counts: BackupCounts = {
    providers: data.providers.length,
    models: data.models.length,
    conversations: data.conversations.length,
    messages: data.messages.length,
    files: data.files.length,
    memories: data.memories.length,
    prompt_templates: data.prompt_templates.length,
    personas: data.personas.length,
    cost_records: data.cost_records.length,
    roundtables: data.roundtables.length,
    roundtable_messages: data.roundtable_messages.length,
  };

  return {
    format_version: 'taori-backup-v1',
    exported_at: Date.now(),
    app_version: deps.config.version,
    counts,
    warnings,
    data,
  };
}

function parsePricingMetaBackup(raw: string | null): BackupData['models'][number]['pricing_meta'] {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    const result = PricingMetaSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

async function wipeAllData(deps: BuildServerArgs): Promise<{
  keystoreEntriesRemoved: number;
  keystoreFailures: string[];
}> {
  const refs = (deps.db.select({ ref: providers.api_key_ref }).from(providers).all() as Array<{
    ref: string | null;
  }>)
    .map((r) => r.ref)
    .filter((r): r is string => !!r);

  const filePaths = (deps.db.select({ p: files.original_path }).from(files).all() as Array<{
    p: string | null;
  }>)
    .map((r) => r.p)
    .filter((p): p is string => !!p);

  deps.db.delete(roundtable_messages).where(sql`1=1`).run();
  deps.db.delete(roundtables).where(sql`1=1`).run();
  deps.db.delete(cost_records).where(sql`1=1`).run();
  deps.db.delete(mcp_servers).where(sql`1=1`).run();
  deps.db.run(sql`DELETE FROM file_chunk_fts`);
  deps.db.delete(files).where(sql`1=1`).run();
  deps.db.delete(messages).where(sql`1=1`).run();
  deps.db.delete(memories).where(sql`1=1`).run();
  deps.db.delete(prompt_templates).where(sql`1=1`).run();
  deps.db.delete(personas).where(sql`1=1`).run();
  deps.db.delete(workflow_recipes).where(sql`1=1`).run();
  deps.db.delete(conversations).where(sql`1=1`).run();
  deps.db.delete(models).where(sql`1=1`).run();
  deps.db.delete(providers).where(sql`1=1`).run();

  const keystoreFailures: string[] = [];
  for (const ref of refs) {
    try {
      await deps.keystore.delete(ref);
    } catch (e) {
      keystoreFailures.push(
        `${ref}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  for (const filePath of filePaths) {
    try {
      await fs.rm(filePath, { force: true });
    } catch {
      /* ignore */
    }
  }
  try {
    await fs.rm(filesDir(deps.config.dbPath), { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  return {
    keystoreEntriesRemoved: refs.length - keystoreFailures.length,
    keystoreFailures,
  };
}

export function registerAdminRoute(app: FastifyInstance, deps: BuildServerArgs): void {
  app.post('/v1/admin/clear-all-data', async () => {
    const cleared = await wipeAllData(deps);
    for (const tool of deps.bus?.list().filter((item) => item.source === 'mcp') ?? []) {
      deps.bus?.unregisterBySource('mcp', tool.source_id);
    }
    for (const tool of deps.bus?.list() ?? []) {
      deps.bus?.setEnabled(tool.name, true);
    }
    return {
      ok: true,
      data: {
        sqlite_cleared: true,
        keystore_entries_removed: cleared.keystoreEntriesRemoved,
        keystore_failures: cleared.keystoreFailures,
      },
    };
  });

  app.get('/v1/admin/export-data', async () => {
    const backup = await collectBackup(deps);
    return { ok: true, backup };
  });

  app.post('/v1/admin/import-data', async (req) => {
    const parsed = BackupImportRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new TaoriError({
        code: 'validation_error',
        message: parsed.error.issues.map((issue) => issue.message).join('; '),
      });
    }

    const { strategy, backup } = parsed.data;
    const imported = EMPTY_COUNTS();
    const skipped = EMPTY_COUNTS();
    const renamed = EMPTY_COUNTS();
    const warnings = [...backup.warnings];

    const existingProviderRows = deps.db.select().from(providers).all() as ProviderRow[];
    const existingModelRows = deps.db.select().from(models).all() as ModelRow[];
    const existingConversationRows =
      deps.db.select().from(conversations).all() as ConversationRow[];
    const existingMessageRows = deps.db.select().from(messages).all() as MessageRow[];
    const existingFileRows = deps.db.select().from(files).all() as FileRow[];
    const existingMemoryRows = deps.db.select().from(memories).all() as MemoryRow[];
    const existingPromptTemplateRows =
      deps.db.select().from(prompt_templates).all() as PromptTemplateRow[];
    const existingPersonaRows = deps.db.select().from(personas).all() as PersonaRow[];
    const existingCostRows = deps.db.select().from(cost_records).all() as CostRow[];
    const existingRoundtableRows =
      deps.db.select().from(roundtables).all() as RoundtableRow[];
    const existingRoundtableMessageRows =
      deps.db.select().from(roundtable_messages).all() as RoundtableMessageRow[];

    const providerIds = new Set(existingProviderRows.map((row) => row.id));
    const modelIds = new Set(existingModelRows.map((row) => row.id));
    const conversationIds = new Set(existingConversationRows.map((row) => row.id));
    const messageIds = new Set(existingMessageRows.map((row) => row.id));
    const fileIds = new Set(existingFileRows.map((row) => row.id));
    const memoryIds = new Set(existingMemoryRows.map((row) => row.id));
    const promptTemplateIds = new Set(existingPromptTemplateRows.map((row) => row.id));
    const personaIds = new Set(existingPersonaRows.map((row) => row.id));
    const costIds = new Set(existingCostRows.map((row) => row.id));
    const roundtableIds = new Set(existingRoundtableRows.map((row) => row.id));
    const roundtableMessageIds = new Set(existingRoundtableMessageRows.map((row) => row.id));

    const providerIdMap = new Map<string, string>();
    const modelIdMap = new Map<string, string>();
    const conversationIdMap = new Map<string, string>();
    const messageIdMap = new Map<string, string>();
    const fileIdMap = new Map<string, string>();
    const memoryIdMap = new Map<string, string>();
    const promptTemplateIdMap = new Map<string, string>();
    const personaIdMap = new Map<string, string>();
    const costIdMap = new Map<string, string>();
    const roundtableIdMap = new Map<string, string>();
    const roundtableMessageIdMap = new Map<string, string>();

    for (const row of backup.data.providers) {
      maybeRenameId(
        'provider',
        row.id,
        strategy,
        providerIds,
        renamed,
        'providers',
        providerIdMap,
      );
    }
    for (const row of backup.data.models) {
      maybeRenameId(
        'model',
        row.id,
        strategy,
        modelIds,
        renamed,
        'models',
        modelIdMap,
      );
    }
    for (const row of backup.data.conversations) {
      maybeRenameId(
        'conversation',
        row.id,
        strategy,
        conversationIds,
        renamed,
        'conversations',
        conversationIdMap,
      );
    }
    const sortedMessages = [...backup.data.messages].sort((a, b) => a.created_at - b.created_at);
    for (const row of sortedMessages) {
      maybeRenameId(
        'message',
        row.id,
        strategy,
        messageIds,
        renamed,
        'messages',
        messageIdMap,
      );
    }
    for (const row of backup.data.files) {
      maybeRenameId(
        'file',
        row.id,
        strategy,
        fileIds,
        renamed,
        'files',
        fileIdMap,
      );
    }
    for (const row of backup.data.memories) {
      maybeRenameId(
        'memory',
        row.id,
        strategy,
        memoryIds,
        renamed,
        'memories',
        memoryIdMap,
      );
    }
    for (const row of backup.data.prompt_templates) {
      maybeRenameId(
        'prompt_template',
        row.id,
        strategy,
        promptTemplateIds,
        renamed,
        'prompt_templates',
        promptTemplateIdMap,
      );
    }
    for (const row of backup.data.personas) {
      maybeRenameId(
        'persona',
        row.id,
        strategy,
        personaIds,
        renamed,
        'personas',
        personaIdMap,
      );
    }
    for (const row of backup.data.cost_records) {
      maybeRenameId(
        'cost',
        row.id,
        strategy,
        costIds,
        renamed,
        'cost_records',
        costIdMap,
      );
    }
    for (const row of backup.data.roundtables) {
      maybeRenameId(
        'roundtable',
        row.id,
        strategy,
        roundtableIds,
        renamed,
        'roundtables',
        roundtableIdMap,
      );
    }
    for (const row of backup.data.roundtable_messages) {
      maybeRenameId(
        'roundtable_message',
        row.id,
        strategy,
        roundtableMessageIds,
        renamed,
        'roundtable_messages',
        roundtableMessageIdMap,
      );
    }

    const aliasOwners = new Map<string, string>();
    for (const row of existingModelRows) {
      if (row.alias) aliasOwners.set(row.alias, row.id);
    }
    const modelPairOwners = new Map<string, string>();
    for (const row of existingModelRows) {
      if (row.provider_id) modelPairOwners.set(`${row.provider_id}::${row.model_name}`, row.id);
    }
    const memoryKeyOwners = new Map<string, string>();
    for (const row of existingMemoryRows) {
      memoryKeyOwners.set(`${row.scope}::${row.scope_id ?? ''}::${row.key}`, row.id);
    }

    const providerRows: ProviderRow[] = [];
    const modelRows: ModelRow[] = [];
    const conversationRows: ConversationRow[] = [];
    const messageRows: MessageRow[] = [];
    const fileRows: FileRow[] = [];
    const memoryRows: MemoryRow[] = [];
    const promptTemplateRows: PromptTemplateRow[] = [];
    const personaRows: PersonaRow[] = [];
    const costRows: CostRow[] = [];
    const roundtableRows: RoundtableRow[] = [];
    const roundtableMessageRows: RoundtableMessageRow[] = [];
    const fileWrites: Array<{ path: string; data_b64: string }> = [];
    const keystoreRefsToDelete = new Set<string>();

    const existingProviderById = new Map(existingProviderRows.map((row) => [row.id, row]));
    const existingFileById = new Map(existingFileRows.map((row) => [row.id, row]));

    for (const row of backup.data.providers) {
      const finalId = providerIdMap.get(row.id) ?? row.id;
      const exists = existingProviderById.has(row.id);
      if (exists && strategy === 'skip') {
        skipped.providers += 1;
        continue;
      }
      if (exists && strategy === 'overwrite') {
        const old = existingProviderById.get(row.id);
        if (old?.api_key_ref) keystoreRefsToDelete.add(old.api_key_ref);
      }
      providerRows.push({
        id: finalId,
        name: providerIdMap.has(row.id) ? appendCnSuffix(row.name, 100) ?? row.name : row.name,
        type: row.type,
        base_url: row.base_url,
        api_key_ref: null,
        enabled: row.enabled,
        created_at: row.created_at,
        updated_at: row.updated_at,
      });
      imported.providers += 1;
      if (row.had_api_key) {
        warnings.push(`provider ${row.name} 的 API Key 未包含在备份中，导入后需重新填写。`);
      }
    }

    for (const row of backup.data.models) {
      const providerId = remap(row.provider_id, providerIdMap);
      const pairKey = providerId ? `${providerId}::${row.model_name}` : null;
      const pairOwner = pairKey ? modelPairOwners.get(pairKey) ?? null : null;
      const overwritePairOwner =
        strategy === 'overwrite' ? pairOwner : null;
      let finalId = modelIdMap.get(row.id) ?? row.id;
      const renamedById = strategy === 'rename' && modelIdMap.has(row.id);
      if (overwritePairOwner && overwritePairOwner !== row.id) {
        finalId = overwritePairOwner;
        modelIdMap.set(row.id, overwritePairOwner);
      }
      const exists = existingModelRows.some((item) => item.id === row.id);
      if (exists && strategy === 'skip') {
        skipped.models += 1;
        continue;
      }
      if (pairOwner && pairOwner !== finalId && strategy === 'skip') {
        skipped.models += 1;
        continue;
      }
      if (pairOwner && pairOwner !== finalId && strategy === 'rename') {
        skipped.models += 1;
        warnings.push(
          `model ${row.model_name} skipped under rename: same provider/model pair already exists.`,
        );
        continue;
      }
      let alias = row.alias;
      if (renamedById) alias = appendAsciiSuffix(alias);
      while (alias) {
        const owner = aliasOwners.get(alias);
        if (!owner || owner === finalId) break;
        alias = appendAsciiSuffix(alias);
      }
      if (alias) aliasOwners.set(alias, finalId);
      if (pairKey) modelPairOwners.set(pairKey, finalId);
      modelRows.push({
        id: finalId,
        alias,
        provider_id: providerId,
        model_name: row.model_name,
        capability: row.capability,
        display_name: renamedById
          ? appendCnSuffix(row.display_name, 200) ?? row.display_name
          : row.display_name,
        price_input_per_1m: row.price_input_per_1m,
        price_output_per_1m: row.price_output_per_1m,
        price_per_call: row.price_per_call,
        price_per_image: row.price_per_image,
        price_per_video_second: row.price_per_video_second,
        price_currency: row.price_currency,
        pricing_meta: row.pricing_meta ? JSON.stringify(row.pricing_meta) : null,
        price_synced_at: row.price_synced_at,
        modalities: row.modalities,
        context_length: row.context_length,
        supports_vision: row.supports_vision,
        supports_tools: row.supports_tools,
        supports_json: row.supports_json,
        is_default_for: row.is_default_for,
        fallback_order: row.fallback_order,
        user_rating: row.user_rating,
        failure_count_24h: row.failure_count_24h,
        last_failure_at: row.last_failure_at,
        demoted: row.demoted,
        disabled_until: row.disabled_until,
        enabled: row.enabled,
        created_at: row.created_at,
        updated_at: row.updated_at,
      });
      imported.models += 1;
    }

    for (const row of backup.data.conversations) {
      const finalId = conversationIdMap.get(row.id) ?? row.id;
      const exists = existingConversationRows.some((item) => item.id === row.id);
      if (exists && strategy === 'skip') {
        skipped.conversations += 1;
        continue;
      }
      conversationRows.push({
        ...row,
        id: finalId,
        title: conversationIdMap.has(row.id)
          ? appendCnSuffix(row.title, 120)
          : row.title,
      });
      imported.conversations += 1;
    }

    for (const row of sortedMessages) {
      const finalId = messageIdMap.get(row.id) ?? row.id;
      const exists = existingMessageRows.some((item) => item.id === row.id);
      if (exists && strategy === 'skip') {
        skipped.messages += 1;
        continue;
      }
      messageRows.push({
        ...row,
        id: finalId,
        conversation_id: remap(row.conversation_id, conversationIdMap),
        model_id: remap(row.model_id, modelIdMap),
        parent_message_id: remap(row.parent_message_id, messageIdMap),
        attachments: remapMessageAttachments(row.attachments, fileIdMap),
      });
      imported.messages += 1;
    }

    let fileCounter = 0;
    for (const row of backup.data.files) {
      const finalId = fileIdMap.get(row.id) ?? row.id;
      const exists = existingFileById.has(row.id);
      if (exists && strategy === 'skip') {
        skipped.files += 1;
        continue;
      }
      let importedPath: string | null = null;
      if (row.data_b64) {
        importedPath = path.join(
          filesDir(deps.config.dbPath),
          `${finalId}-${fileCounter++}${mimeExtension(row.mime_type)}`,
        );
        fileWrites.push({ path: importedPath, data_b64: row.data_b64 });
      } else if (row.original_path) {
        warnings.push(`file ${row.id} missing bytes in backup; metadata restored only.`);
      }
      fileRows.push({
        id: finalId,
        conversation_id: remap(row.conversation_id, conversationIdMap),
        message_id: remap(row.message_id, messageIdMap),
        original_path: importedPath,
        mime_type: row.mime_type,
        size_bytes: row.size_bytes,
        extracted_text: row.extracted_text,
        preview_data: row.preview_data,
        created_at: row.created_at,
      });
      imported.files += 1;
    }

    for (const row of backup.data.prompt_templates) {
      const finalId = promptTemplateIdMap.get(row.id) ?? row.id;
      const exists = existingPromptTemplateRows.some((item) => item.id === row.id);
      if (exists && strategy === 'skip') {
        skipped.prompt_templates += 1;
        continue;
      }
      promptTemplateRows.push({
        ...row,
        id: finalId,
        name: promptTemplateIdMap.has(row.id)
          ? appendCnSuffix(row.name, 120) ?? row.name
          : row.name,
      });
      imported.prompt_templates += 1;
    }

    for (const row of backup.data.personas) {
      const finalId = personaIdMap.get(row.id) ?? row.id;
      const exists = existingPersonaRows.some((item) => item.id === row.id);
      if (exists && strategy === 'skip') {
        skipped.personas += 1;
        continue;
      }
      personaRows.push({
        ...row,
        id: finalId,
        name: personaIdMap.has(row.id)
          ? appendCnSuffix(row.name, 120) ?? row.name
          : row.name,
      });
      imported.personas += 1;
    }

    for (const row of backup.data.memories) {
      let finalId = memoryIdMap.get(row.id) ?? row.id;
      const exists = existingMemoryRows.some((item) => item.id === row.id);
      const scopeId = row.scope === 'session'
        ? remap(row.scope_id, conversationIdMap)
        : row.scope_id;
      const uniqueKey = `${row.scope}::${scopeId ?? ''}::${row.key}`;
      const ownerId = memoryKeyOwners.get(uniqueKey) ?? null;
      if (strategy === 'skip' && (exists || (ownerId != null && ownerId !== row.id))) {
        skipped.memories += 1;
        continue;
      }
      if (strategy === 'rename' && ownerId != null) {
        skipped.memories += 1;
        warnings.push(`memory ${row.scope}/${row.key} skipped: this key cannot be meaningfully renamed.`);
        continue;
      }
      if (strategy === 'overwrite' && ownerId != null && ownerId !== row.id) {
        finalId = ownerId;
        memoryIdMap.set(row.id, ownerId);
      }
      memoryKeyOwners.set(uniqueKey, finalId);
      memoryRows.push({
        ...row,
        id: finalId,
        scope_id: scopeId,
      });
      imported.memories += 1;
    }

    for (const row of backup.data.roundtables) {
      const finalId = roundtableIdMap.get(row.id) ?? row.id;
      const exists = existingRoundtableRows.some((item) => item.id === row.id);
      if (exists && strategy === 'skip') {
        skipped.roundtables += 1;
        continue;
      }
      roundtableRows.push({
        ...row,
        id: finalId,
        conversation_id: remap(row.conversation_id, conversationIdMap),
        participants: remapParticipants(row.participants, modelIdMap),
        summarizer_model_id: remap(row.summarizer_model_id, modelIdMap),
        origin_conversation_id: remap(row.origin_conversation_id, conversationIdMap),
      });
      imported.roundtables += 1;
    }

    for (const row of backup.data.roundtable_messages) {
      const finalId = roundtableMessageIdMap.get(row.id) ?? row.id;
      const exists = existingRoundtableMessageRows.some((item) => item.id === row.id);
      if (exists && strategy === 'skip') {
        skipped.roundtable_messages += 1;
        continue;
      }
      roundtableMessageRows.push({
        ...row,
        id: finalId,
        roundtable_id: remap(row.roundtable_id, roundtableIdMap),
        model_id: remap(row.model_id, modelIdMap),
      });
      imported.roundtable_messages += 1;
    }

    for (const row of backup.data.cost_records) {
      const finalId = costIdMap.get(row.id) ?? row.id;
      const exists = existingCostRows.some((item) => item.id === row.id);
      if (exists && strategy === 'skip') {
        skipped.cost_records += 1;
        continue;
      }
      let sourceId = row.source_id;
      if (row.source_type === 'message' || row.source_type === 'tool_call') {
        sourceId = remap(sourceId, messageIdMap);
      } else if (row.source_type === 'roundtable_message') {
        sourceId = remap(sourceId, roundtableMessageIdMap);
      } else if (row.source_type === 'topic_analyzer' || row.source_type === 'summarizer') {
        sourceId = remap(sourceId, roundtableIdMap);
      }
      costRows.push({
        ...row,
        id: finalId,
        conversation_id: remap(row.conversation_id, conversationIdMap),
        source_id: sourceId,
        model_id: remap(row.model_id, modelIdMap),
      });
      imported.cost_records += 1;
    }

    const createdFilePaths = new Set<string>();
    try {
      await fs.mkdir(filesDir(deps.config.dbPath), { recursive: true });
      for (const file of fileWrites) {
        await fs.writeFile(file.path, Buffer.from(file.data_b64, 'base64'));
        createdFilePaths.add(file.path);
      }

      deps.db.transaction((tx) => {
        for (const row of providerRows) {
          tx.insert(providers).values(row).onConflictDoUpdate({
            target: providers.id,
            set: row,
          }).run();
        }
        for (const row of modelRows) {
          tx.insert(models).values(row).onConflictDoUpdate({
            target: models.id,
            set: row,
          }).run();
        }
        for (const row of conversationRows) {
          tx.insert(conversations).values(row).onConflictDoUpdate({
            target: conversations.id,
            set: row,
          }).run();
        }
        for (const row of promptTemplateRows) {
          tx.insert(prompt_templates).values(row).onConflictDoUpdate({
            target: prompt_templates.id,
            set: row,
          }).run();
        }
        for (const row of personaRows) {
          tx.insert(personas).values(row).onConflictDoUpdate({
            target: personas.id,
            set: row,
          }).run();
        }
        for (const row of messageRows) {
          tx.insert(messages).values(row).onConflictDoUpdate({
            target: messages.id,
            set: row,
          }).run();
        }
        for (const row of fileRows) {
          tx.insert(files).values(row).onConflictDoUpdate({
            target: files.id,
            set: row,
          }).run();
        }
        for (const row of memoryRows) {
          tx.insert(memories).values(row).onConflictDoUpdate({
            target: memories.id,
            set: row,
          }).run();
        }
        for (const row of roundtableRows) {
          tx.insert(roundtables).values(row).onConflictDoUpdate({
            target: roundtables.id,
            set: row,
          }).run();
        }
        for (const row of roundtableMessageRows) {
          tx.insert(roundtable_messages).values(row).onConflictDoUpdate({
            target: roundtable_messages.id,
            set: row,
          }).run();
        }
        for (const row of costRows) {
          tx.insert(cost_records).values(row).onConflictDoUpdate({
            target: cost_records.id,
            set: row,
          }).run();
        }
      });
    } catch (e) {
      for (const filePath of createdFilePaths) {
        try {
          await fs.rm(filePath, { force: true });
        } catch {
          /* ignore */
        }
      }
      throw new TaoriError({
        code: 'validation_error',
        message: e instanceof Error ? e.message : String(e),
      });
    }

    for (const ref of keystoreRefsToDelete) {
      try {
        await deps.keystore.delete(ref);
      } catch {
        warnings.push(`keystore cleanup failed for ${ref}`);
      }
    }

    return {
      ok: true,
      data: {
        strategy,
        imported,
        skipped,
        renamed,
        warnings,
      },
    };
  });
}
