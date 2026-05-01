import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import type { BackupPackage } from '@taori/shared';
import { buildServer } from '../src/server.js';
import { openDb } from '../src/db/index.js';
import { ControlClient } from '../src/control/client.js';
import { MemoryStore } from '../src/keystore.js';
import { messages } from '../src/db/schema.js';
import {
  ConversationsRepo,
  CostsRepo,
  FilesRepo,
  MemoriesRepo,
  MessagesRepo,
  ModelsRepo,
  PersonasRepo,
  PromptTemplatesRepo,
  ProvidersRepo,
  RoundtableMessagesRepo,
  RoundtablesRepo,
} from '../src/db/repos/index.js';

const bearer = 'test_bearer_e2';
const auth = { authorization: `Bearer ${bearer}` };

function newApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taori-e2-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const db = openDb(dbPath);
  const keystore = new MemoryStore();
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
    keystore,
    startedAt: Date.now(),
  });
  return { app, db, dbPath, keystore };
}

async function seedAll(args: {
  db: ReturnType<typeof openDb>;
  dbPath: string;
  keystore: MemoryStore;
}): Promise<{
  providerId: string;
  modelId: string;
  conversationId: string;
  assistantMessageId: string;
  fileId: string;
}> {
  const providersRepo = new ProvidersRepo(args.db);
  const modelsRepo = new ModelsRepo(args.db);
  const convRepo = new ConversationsRepo(args.db);
  const msgRepo = new MessagesRepo(args.db);
  const filesRepo = new FilesRepo(args.db);
  const memoriesRepo = new MemoriesRepo(args.db);
  const promptTemplatesRepo = new PromptTemplatesRepo(args.db);
  const personasRepo = new PersonasRepo(args.db);
  const costsRepo = new CostsRepo(args.db);
  const roundtablesRepo = new RoundtablesRepo(args.db);
  const roundtableMessagesRepo = new RoundtableMessagesRepo(args.db);

  const provider = providersRepo.create({
    name: 'Backup Provider',
    type: 'openrouter',
    base_url: 'https://example.invalid/v1',
    api_key: 'sk-test',
  });
  await args.keystore.write(provider.api_key_ref!, 'sk-test');
  const model = modelsRepo.create({
    provider_id: provider.id,
    model_name: 'backup-model',
    capability: 'chat',
    display_name: 'Backup Model',
    alias: 'backup-model',
    price_input_per_1m: 1,
    price_output_per_1m: 2,
    is_default_for: 'chat',
  });
  const conv = convRepo.create({ title: 'Backup Conversation', type: 'chat' });
  const user = msgRepo.insert({
    conversation_id: conv.id,
    role: 'user',
    content: 'hello backup',
    status: 'complete',
  });
  const assistant = msgRepo.insert({
    conversation_id: conv.id,
    role: 'assistant',
    content: 'image ready',
    model_id: model.id,
    status: 'complete',
  });

  const filesDir = path.join(path.dirname(args.dbPath), 'seed-files');
  fs.mkdirSync(filesDir, { recursive: true });
  const originalPath = path.join(filesDir, 'image.bin');
  await fsp.writeFile(originalPath, Buffer.from('backup-image', 'utf8'));
  const file = filesRepo.insert({
    conversation_id: conv.id,
    message_id: assistant.id,
    original_path: originalPath,
    mime_type: 'image/png',
    size_bytes: Buffer.byteLength('backup-image'),
    preview_data: 'preview',
  });
  msgRepo.finalize(assistant.id, {
    content: 'image ready',
    status: 'complete',
  });
  args.db
    .update(messages)
    .set({
      attachments: JSON.stringify([
        {
          kind: 'image',
          file_id: file.id,
          mime: 'image/png',
          width: 64,
          height: 64,
        },
      ]),
    })
    .where(eq(messages.id, assistant.id))
    .run();

  memoriesRepo.set('global', null, 'monthly_budget_usd', '12');
  memoriesRepo.set('session', conv.id, 'active_persona_id', 'per_missing');
  promptTemplatesRepo.create({
    name: 'Backup Template',
    description: 'for export',
    content: 'hello {{name}}',
  });
  personasRepo.create({
    name: 'Backup Persona',
    description: 'for export',
    prompt: '你是一位严格但简洁的评审。',
  });
  costsRepo.insert({
    conversation_id: conv.id,
    source_type: 'message',
    source_id: assistant.id,
    feature: 'chat',
    model_id: model.id,
    model_name_snapshot: model.model_name,
    input_tokens: 12,
    output_tokens: 24,
    price_input_per_1m_snapshot: 1,
    price_output_per_1m_snapshot: 2,
    price_per_call_snapshot: null,
    estimated_cost_usd: null,
    actual_cost_usd: 0.02,
    success: true,
    first_token_ms: 5,
    duration_ms: 99,
  });

  const roundtable = roundtablesRepo.insert({
    conversation_id: conv.id,
    topic: 'Backup Topic',
    mode: 'fast',
    participants: [
      {
        model_id: model.id,
        display_name: model.display_name,
        role_label: '支持者',
        persona_prompt: '从支持角度审视方案。',
      },
      {
        model_id: model.id,
        display_name: model.display_name,
        role_label: '质疑者',
        persona_prompt: '从风险角度审视方案。',
      },
    ],
    summarizer_model_id: model.id,
    analyzer_fallback: false,
    status: 'completed',
    estimated_cost_usd_low: 0.01,
    estimated_cost_usd_high: 0.03,
    origin_conversation_id: conv.id,
  });
  roundtablesRepo.setSummary(roundtable.id, {
    fallback: true,
    raw_text: 'backup summary',
  });
  roundtablesRepo.setStatus(roundtable.id, 'completed');
  roundtableMessagesRepo.insert({
    roundtable_id: roundtable.id,
    round: 1,
    participant_index: 0,
    model_id: model.id,
    content: 'backup viewpoint',
    status: 'complete',
  });

  void user;
  return {
    providerId: provider.id,
    modelId: model.id,
    conversationId: conv.id,
    assistantMessageId: assistant.id,
    fileId: file.id,
  };
}

describe('E2 backup / restore', () => {
  let app: FastifyInstance;
  let dbPath: string;
  let db: ReturnType<typeof openDb>;
  let keystore: MemoryStore;

  beforeEach(async () => {
    ({ app, db, dbPath, keystore } = newApp());
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it('exports a redacted backup package with inline file bytes', async () => {
    const seeded = await seedAll({ db, dbPath, keystore });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/export-data',
      headers: auth,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; backup: BackupPackage };
    expect(body.ok).toBe(true);
    expect(body.backup.format_version).toBe('taori-backup-v1');
    expect(body.backup.counts.providers).toBe(1);
    expect(body.backup.counts.files).toBe(1);
    expect(body.backup.data.providers[0]?.had_api_key).toBe(true);
    expect('api_key_ref' in body.backup.data.providers[0]!).toBe(false);
    expect(body.backup.data.files[0]?.id).toBe(seeded.fileId);
    expect(body.backup.data.files[0]?.data_b64).toBe(
      Buffer.from('backup-image', 'utf8').toString('base64'),
    );
  });

  it('clear-all-data wipes all tables and import-data restores them', async () => {
    const seeded = await seedAll({ db, dbPath, keystore });
    const exported = await app.inject({
      method: 'GET',
      url: '/v1/admin/export-data',
      headers: auth,
    });
    const backup = (exported.json() as { backup: BackupPackage }).backup;

    const cleared = await app.inject({
      method: 'POST',
      url: '/v1/admin/clear-all-data',
      headers: auth,
    });
    expect(cleared.statusCode).toBe(200);
    expect(new ProvidersRepo(db).list()).toHaveLength(0);
    expect(new ModelsRepo(db).list()).toHaveLength(0);
    expect(new ConversationsRepo(db).list()).toHaveLength(0);
    expect(new PromptTemplatesRepo(db).list()).toHaveLength(0);
    expect(new PersonasRepo(db).list()).toHaveLength(0);
    expect(new RoundtablesRepo(db).listByConversation(seeded.conversationId)).toHaveLength(0);

    const imported = await app.inject({
      method: 'POST',
      url: '/v1/admin/import-data',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: {
        strategy: 'overwrite',
        backup,
      },
    });
    expect(imported.statusCode).toBe(200);
    const importBody = imported.json() as {
      ok: boolean;
      data: { imported: { providers: number; files: number }; warnings: string[] };
    };
    expect(importBody.ok).toBe(true);
    expect(importBody.data.imported.providers).toBe(1);
    expect(importBody.data.imported.files).toBe(1);

    expect(new ProvidersRepo(db).list()).toHaveLength(1);
    expect(new ModelsRepo(db).list()).toHaveLength(1);
    expect(new PromptTemplatesRepo(db).list()).toHaveLength(1);
    expect(new PersonasRepo(db).list()).toHaveLength(1);
    const restoredMsgs = new MessagesRepo(db).listByConversation(seeded.conversationId);
    expect(restoredMsgs).toHaveLength(2);
    expect(restoredMsgs[1]?.attachments).toContain(seeded.fileId);
    const restoredFile = new FilesRepo(db).get(seeded.fileId);
    expect(restoredFile?.original_path).toBeTruthy();
    expect(fs.existsSync(restoredFile!.original_path!)).toBe(true);

    const dataRes = await app.inject({
      method: 'GET',
      url: `/v1/files/${seeded.fileId}/data`,
      headers: auth,
    });
    expect(dataRes.statusCode).toBe(200);
    expect((dataRes.json() as { data_b64: string }).data_b64).toBe(
      Buffer.from('backup-image', 'utf8').toString('base64'),
    );
  });

  it('supports skip and rename conflict strategies on repeated import', async () => {
    await seedAll({ db, dbPath, keystore });
    const exported = await app.inject({
      method: 'GET',
      url: '/v1/admin/export-data',
      headers: auth,
    });
    const backup = (exported.json() as { backup: BackupPackage }).backup;

    const skipRes = await app.inject({
      method: 'POST',
      url: '/v1/admin/import-data',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: {
        strategy: 'skip',
        backup,
      },
    });
    expect(skipRes.statusCode).toBe(200);
    const skipBody = skipRes.json() as {
      data: { skipped: { providers: number; conversations: number } };
    };
    expect(skipBody.data.skipped.providers).toBeGreaterThan(0);
    expect(skipBody.data.skipped.conversations).toBeGreaterThan(0);

    const renameRes = await app.inject({
      method: 'POST',
      url: '/v1/admin/import-data',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: {
        strategy: 'rename',
        backup,
      },
    });
    expect(renameRes.statusCode).toBe(200);
    const renameBody = renameRes.json() as {
      data: { renamed: { providers: number; conversations: number; messages: number } };
    };
    expect(renameBody.data.renamed.providers).toBeGreaterThan(0);
    expect(renameBody.data.renamed.conversations).toBeGreaterThan(0);
    expect(renameBody.data.renamed.messages).toBeGreaterThan(0);
    expect(new ProvidersRepo(db).list()).toHaveLength(2);
    expect(new ConversationsRepo(db).list()).toHaveLength(2);
    expect(
      new PromptTemplatesRepo(db).list().some((row) => row.name.includes('（导入）')),
    ).toBe(true);
  });
});
