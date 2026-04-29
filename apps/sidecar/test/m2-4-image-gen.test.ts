/**
 * M2.4 — image_generate tool + intent detection.
 *
 * Coverage:
 *   1. detectImageIntent — positive (zh/en/command) + negative whitelist.
 *   2. /v1/tools/invoke builtin.image_generate with X-Test-Force-Image-Result:
 *        - success → file row + assistant message + cost_records ok=true.
 *        - quota   → ok=false, classification=quota, cost=0.
 *        - billed_4xx → ok=false, classification=unknown, cost>0
 *          (spec §6.1: provider charged us anyway).
 *   3. Validation: rejects non-image model.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { openDb } from '../src/db/index.js';
import { ControlClient } from '../src/control/client.js';
import { MemoryStore } from '../src/keystore.js';
import { ProvidersRepo, ModelsRepo, ConversationsRepo, MessagesRepo, FilesRepo } from '../src/db/repos/index.js';
import { cost_records, messages as messagesTable, files as filesTable } from '../src/db/schema.js';
import { detectImageIntent, isIntentDisabledUntilNow } from '../src/intent.js';
import type { FastifyInstance } from 'fastify';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const bearer = 'test_bearer_m24';

describe('M2.4 — intent detection', () => {
  it('matches command/zh/en imperative patterns', () => {
    expect(detectImageIntent('/image a cat').hit).toBe(true);
    expect(detectImageIntent('画一张星空').hit).toBe(true);
    expect(detectImageIntent('画个机器人').hit).toBe(true);
    expect(detectImageIntent('生成图片：日落').hit).toBe(true);
    expect(detectImageIntent('draw a robot please').hit).toBe(true);
    expect(detectImageIntent('generate image of a forest').hit).toBe(true);
    // M2.5 — relaxed prefixes (the user's "帮我画一张机器人" complaint).
    expect(detectImageIntent('帮我画一张机器人').hit).toBe(true);
    expect(detectImageIntent('帮我画个机器人').hit).toBe(true);
    expect(detectImageIntent('给我画一张星空').hit).toBe(true);
    expect(detectImageIntent('请你画一张猫').hit).toBe(true);
    expect(detectImageIntent('帮我生成一张海报').hit).toBe(true);
    expect(detectImageIntent('做一张海报').hit).toBe(true);
    expect(detectImageIntent('sketch a cyberpunk skyline').hit).toBe(true);
    expect(detectImageIntent('render a 3D logo').hit).toBe(true);
    expect(detectImageIntent('create an illustration of a fox').hit).toBe(true);
  });

  it('rejects negative whitelist (references / past)', () => {
    expect(detectImageIntent('参考上次画的那张').hit).toBe(false);
    expect(detectImageIntent('like the one you drew before').hit).toBe(false);
    expect(detectImageIntent('已经画过了，再说说').hit).toBe(false);
    // Bare 已 (without 经) — spec 09-m2 §2.2 negation whitelist line 136.
    expect(detectImageIntent('已画过的那张能再发我看看吗').hit).toBe(false);
  });

  it('rejects pure conversational text', () => {
    expect(detectImageIntent('hello there').hit).toBe(false);
    expect(detectImageIntent('帮我看下这个代码').hit).toBe(false);
    expect(detectImageIntent('帮我生成一段代码').hit).toBe(false);
    expect(detectImageIntent('生成一段总结').hit).toBe(false);
  });

  it('isIntentDisabledUntilNow: handles null + future + past', () => {
    const now = Date.now();
    expect(isIntentDisabledUntilNow(null, now)).toBe(false);
    expect(isIntentDisabledUntilNow(String(now + 60_000), now)).toBe(true);
    expect(isIntentDisabledUntilNow(String(now - 60_000), now)).toBe(false);
    expect(isIntentDisabledUntilNow('not-a-number', now)).toBe(false);
  });
});

describe('M2.4 — image_generate via /v1/tools/invoke', () => {
  let app: FastifyInstance;
  let dbPath: string;
  let db: ReturnType<typeof openDb>;
  let conversationId: string;
  let userMsgId: string;
  let imageModelId: string;
  let chatModelId: string;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `taori-m24-${Date.now()}-${Math.random()}.db`);
    db = openDb(dbPath);
    const keystore = new MemoryStore();
    app = buildServer({
      config: {
        port: 0,
        bearer,
        dbPath,
        controlUrl: null,
        controlBearer: null,
        isDev: true,
        version: '0.0.0-test',
      },
      db,
      control: new ControlClient({ url: null, bearer: null }),
      keystore,
      startedAt: Date.now(),
    });
    await app.ready();

    const providers = new ProvidersRepo(db);
    const models = new ModelsRepo(db);
    const conversations = new ConversationsRepo(db);
    const messages = new MessagesRepo(db);

    const prov = providers.create({
      name: 'OpenAI',
      type: 'openai',
      base_url: 'https://api.openai.com/v1',
      api_key: 'sk-fake',
    });
    await keystore.write(prov.api_key_ref!, 'sk-fake');

    const imageModel = models.create({
      provider_id: prov.id,
      model_name: 'dall-e-3',
      capability: 'image',
      display_name: 'DALL-E 3',
      price_per_call: 0.04,
    });
    imageModelId = imageModel.id;
    const chatModel = models.create({
      provider_id: prov.id,
      model_name: 'gpt-4o',
      capability: 'chat',
      display_name: 'GPT-4o',
    });
    chatModelId = chatModel.id;

    const conv = conversations.create({ title: 'image test' });
    conversationId = conv.id;
    const userMsg = messages.insert({
      conversation_id: conv.id,
      role: 'user',
      content: 'draw a robot',
      status: 'complete',
    });
    userMsgId = userMsg.id;
  });

  afterEach(async () => {
    await app.close();
    fs.rmSync(dbPath, { force: true });
  });

  async function invokeImage(force: string | null, modelId = imageModelId) {
    const headers: Record<string, string> = {
      authorization: `Bearer ${bearer}`,
      'content-type': 'application/json',
    };
    if (force) headers['x-test-force-image-result'] = force;
    return app.inject({
      method: 'POST',
      url: '/v1/tools/invoke',
      headers,
      payload: JSON.stringify({
        name: 'builtin.image_generate',
        input: { prompt: 'a robot', model_id: modelId },
        conversation_id: conversationId,
        source_message_id: userMsgId,
      }),
    });
  }

  it('GET /v1/tools includes builtin.image_generate', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/tools',
      headers: { authorization: `Bearer ${bearer}` },
    });
    const body = res.json() as { data: Array<{ name: string; capability: string }> };
    const t = body.data.find((x) => x.name === 'builtin.image_generate');
    expect(t).toBeDefined();
    expect(t?.capability).toBe('image');
  });

  it('force=success → writes file + assistant message + ok cost record', async () => {
    const res = await invokeImage('success');
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; data: { ok: boolean; output?: { file_id: string; assistant_message_id: string } } };
    expect(body.data.ok).toBe(true);
    const out = body.data.output!;
    expect(out.file_id).toBeTruthy();
    expect(out.assistant_message_id).toBeTruthy();

    // file row
    const fileRow = db.select().from(filesTable).all().find((f) => f.id === out.file_id);
    expect(fileRow).toBeDefined();
    expect(fileRow?.mime_type).toBe('image/png');
    // assistant message row
    const msgRow = db.select().from(messagesTable).all().find((m) => m.id === out.assistant_message_id);
    expect(msgRow).toBeDefined();
    expect(msgRow?.role).toBe('assistant');
    expect(msgRow?.parent_message_id).toBe(userMsgId);
    // cost record success
    const costs = db.select().from(cost_records).all();
    const c = costs.find((r) => r.feature === 'image');
    expect(c).toBeDefined();
    expect(c?.success).toBe(true);
    expect((c?.actual_cost_usd ?? 0)).toBeGreaterThan(0);
    expect(c?.source_type).toBe('tool_call');
  });

  it('force=quota → ok=false, classification=quota, cost=0', async () => {
    const res = await invokeImage('quota');
    const body = res.json() as { data: { ok: boolean; error?: { classification: string } } };
    expect(body.data.ok).toBe(false);
    expect(body.data.error?.classification).toBe('quota');
    const c = db.select().from(cost_records).all().find((r) => r.feature === 'image');
    expect(c?.success).toBe(false);
    expect(c?.actual_cost_usd ?? 0).toBe(0);
  });

  it('force=billed_4xx → ok=false but cost>0 (provider charged us)', async () => {
    const res = await invokeImage('billed_4xx');
    const body = res.json() as { data: { ok: boolean; error?: { classification: string } } };
    expect(body.data.ok).toBe(false);
    const c = db.select().from(cost_records).all().find((r) => r.feature === 'image');
    expect(c?.success).toBe(false);
    expect((c?.actual_cost_usd ?? 0)).toBeGreaterThan(0);
  });

  it('rejects non-image model with validation_error', async () => {
    const res = await invokeImage('success', chatModelId);
    const body = res.json() as { data: { ok: boolean; error?: { classification: string; message: string } } };
    expect(body.data.ok).toBe(false);
    expect(body.data.error?.classification).toBe('validation_error');
    expect(body.data.error?.message).toMatch(/not an image model/);
  });

  it('rejects path-traversal in conversation_id (security)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tools/invoke',
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
        'x-test-force-image-result': 'success',
      },
      payload: JSON.stringify({
        name: 'builtin.image_generate',
        input: { prompt: 'x', model_id: imageModelId },
        conversation_id: '../../../etc/passwd',
        source_message_id: userMsgId,
      }),
    });
    const body = res.json() as { ok: boolean; error?: { classification: string; message: string }; data?: unknown };
    expect(body.ok).toBe(false);
    expect(body.error?.classification).toBe('validation_error');
    expect(body.error?.message).toMatch(/opaque token|invalid/);
  });
});
