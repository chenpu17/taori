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
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildServer } from '../src/server.js';
import { openDb } from '../src/db/index.js';
import { ControlClient } from '../src/control/client.js';
import { MemoryStore } from '../src/keystore.js';
import { ProvidersRepo, ModelsRepo, ConversationsRepo, MessagesRepo, FilesRepo, MemoriesRepo } from '../src/db/repos/index.js';
import { cost_records, messages as messagesTable, files as filesTable } from '../src/db/schema.js';
import { detectImageCommand, detectImageIntent, isIntentDisabledUntilNow } from '../src/intent.js';
import type { FastifyInstance } from 'fastify';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const bearer = 'test_bearer_m24';

describe('M2.4 — intent detection', () => {
  it('detectImageCommand only matches explicit slash commands', () => {
    expect(detectImageCommand('/image a cat').hit).toBe(true);
    expect(detectImageCommand('/draw a robot').hit).toBe(true);
    expect(detectImageCommand('/img cyberpunk skyline').hit).toBe(true);
    expect(detectImageCommand('生成机器人的图片').hit).toBe(false);
    expect(detectImageCommand('generate an image of a robot').hit).toBe(false);
  });

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
    expect(detectImageIntent('生成机器人的图片').hit).toBe(true);
    expect(detectImageIntent('帮我生成一个机器人的图片').hit).toBe(true);
    expect(detectImageIntent('我已经配置好模型，请生成机器人的图片').hit).toBe(true);
    expect(detectImageIntent('做一张海报').hit).toBe(true);
    expect(detectImageIntent('sketch a cyberpunk skyline').hit).toBe(true);
    expect(detectImageIntent('render a 3D logo').hit).toBe(true);
    expect(detectImageIntent('create an illustration of a fox').hit).toBe(true);
    expect(detectImageIntent('generate an image of a robot').hit).toBe(true);
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
    expect(detectImageIntent('这个模型支持生成图片吗').hit).toBe(false);
    expect(detectImageIntent('不要生成图片').hit).toBe(false);
    expect(detectImageIntent('不要给我生成图片').hit).toBe(false);
    expect(detectImageIntent('请不要生成机器人的图片').hit).toBe(false);
    expect(detectImageIntent('do not generate an image').hit).toBe(false);
    expect(detectImageIntent("don't generate an image").hit).toBe(false);
    expect(detectImageIntent('please do not draw a robot').hit).toBe(false);
    expect(detectImageIntent('can you generate images?').hit).toBe(false);
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
  let tmpDir: string;
  let dbPath: string;
  let db: ReturnType<typeof openDb>;
  let keystore: MemoryStore;
  let conversationId: string;
  let userMsgId: string;
  let imageModelId: string;
  let chatModelId: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taori-m24-'));
    dbPath = path.join(tmpDir, 'test.db');
    db = openDb(dbPath);
    keystore = new MemoryStore();
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
    fs.rmSync(tmpDir, { recursive: true, force: true });
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

  it('does not route natural-language image requests to picker for non-tool chat models', async () => {
    const models = new ModelsRepo(db);
    const providers = new ProvidersRepo(db);
    const provider = providers.list()[0]!;
    const nonToolChat = models.create({
      provider_id: provider.id,
      model_name: 'gpt-no-tools',
      capability: 'chat',
      display_name: 'GPT no tools',
      supports_tools: false,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat',
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
        'x-test-force-classification': 'network',
      },
      payload: {
        model_id: nonToolChat.id,
        messages: [{ role: 'user', content: '生成机器人的图片' }],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).not.toContain('"type":"capability_route"');
    expect(res.payload).toContain('"message_id":"msg_');
  });

  it('does not route natural-language image requests to picker for tool-capable chat models', async () => {
    const models = new ModelsRepo(db);
    const providers = new ProvidersRepo(db);
    const provider = providers.list()[0]!;
    const toolChat = models.create({
      provider_id: provider.id,
      model_name: 'gpt-tools',
      capability: 'chat',
      display_name: 'GPT tools',
      supports_tools: true,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat',
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
        'x-test-force-classification': 'network',
      },
      payload: {
        model_id: toolChat.id,
        messages: [{ role: 'user', content: '生成机器人的图片' }],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).not.toContain('"type":"capability_route"');
    expect(res.payload).toContain('"message_id":"msg_');
  });

  it('executes image_generate when a tool-capable chat model calls it', async () => {
    const models = new ModelsRepo(db);
    const providers = new ProvidersRepo(db);
    const provider = providers.list()[0]!;
    const toolChat = models.create({
      provider_id: provider.id,
      model_name: 'gpt-tools-upstream',
      capability: 'chat',
      display_name: 'GPT tools upstream',
      supports_tools: true,
    });

    const toolCallBody =
      `data: ${JSON.stringify({ id: '1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_img_1', type: 'function', function: { name: 'image_generate', arguments: '' } }] }, finish_reason: null }] })}\n\n` +
      `data: ${JSON.stringify({ id: '1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"prompt":"cute duck"}' } }] }, finish_reason: null }] })}\n\n` +
      `data: ${JSON.stringify({ id: '1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } })}\n\n` +
      `data: [DONE]\n\n`;
    const finalTextBody =
      `data: ${JSON.stringify({ id: '1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] })}\n\n` +
      `data: ${JSON.stringify({ id: '1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } })}\n\n` +
      `data: [DONE]\n\n`;
    let chatCalls = 0;
    let imageCalls = 0;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (String(url).includes('/images/generations')) {
        imageCalls++;
        const rawBody = typeof init?.body === 'string' ? init.body : String(init?.body ?? '{}');
        const body = JSON.parse(rawBody) as { prompt?: string };
        expect(body.prompt).toBe('cute duck');
        return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('fake-png').toString('base64') }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      chatCalls++;
      const rawBody = typeof init?.body === 'string' ? init.body : String(init?.body ?? '{}');
      const body = JSON.parse(rawBody) as { tools?: Array<{ function?: { name?: string } }> };
      if (chatCalls === 1) {
        const toolNames = body.tools?.map((t) => t.function?.name) ?? [];
        expect(toolNames).toContain('image_generate');
      }
      return new Response(chatCalls === 1 ? toolCallBody : finalTextBody, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat',
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
        payload: {
          model_id: toolChat.id,
          messages: [{ role: 'user', content: '帮我生成一张可爱鸭鸭的图片' }],
        },
      });
      expect(res.statusCode).toBe(200);
      expect(chatCalls).toBe(2);
      expect(imageCalls).toBe(1);
      expect(res.payload).toContain('"ok"');
      expect(res.payload).toContain('"type":"tool_image_result"');
      expect(res.payload).not.toContain('"type":"capability_route"');
      const metaLine = res.payload
        .split('\n')
        .find((line) => line.startsWith('8:') && line.includes('"type":"meta"'));
      const meta = JSON.parse(metaLine!.slice(2))[0] as { conversation_id: string };
      const persisted = new MessagesRepo(db).listByConversation(meta.conversation_id);
      expect(persisted.map((m) => m.role)).toEqual(['user', 'assistant']);
      const attachments = JSON.parse(persisted[1]!.attachments ?? '[]') as Array<{ kind?: string; file_id?: string }>;
      expect(attachments[0]?.kind).toBe('image');
      expect(attachments[0]?.file_id).toBeTruthy();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('lets a Huawei MaaS chat model call an Ark image model through tools', async () => {
    const models = new ModelsRepo(db);
    const providers = new ProvidersRepo(db);
    const huawei = providers.create({
      name: 'Huawei MaaS',
      type: 'huawei_maas',
      base_url: 'https://huawei.example.com/openai/v1',
      api_key: 'hw-test-key',
    });
    await keystore.write(huawei.api_key_ref!, 'hw-test-key');
    const ark = providers.create({
      name: 'Volcengine Ark',
      type: 'volcengine_ark',
      base_url: 'https://ark.example.com/api/v3',
      api_key: 'ark-test-key',
    });
    await keystore.write(ark.api_key_ref!, 'ark-test-key');
    const huaweiChat = models.create({
      provider_id: huawei.id,
      model_name: 'glm-5.1',
      capability: 'chat',
      display_name: 'GLM 5.1',
      supports_tools: true,
    });
    models.create({
      provider_id: ark.id,
      model_name: 'doubao-seedream-4-0',
      capability: 'image',
      display_name: 'Seedream 4.0',
      price_per_call: 0.01,
    });

    const toolCallBody =
      `data: ${JSON.stringify({ id: '1', object: 'chat.completion.chunk', created: 1, model: 'glm-5.1', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_img_1', type: 'function', function: { name: 'image_generate', arguments: '' } }] }, finish_reason: null }] })}\n\n` +
      `data: ${JSON.stringify({ id: '1', object: 'chat.completion.chunk', created: 1, model: 'glm-5.1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"prompt":"cute duck"}' } }] }, finish_reason: null }] })}\n\n` +
      `data: ${JSON.stringify({ id: '1', object: 'chat.completion.chunk', created: 1, model: 'glm-5.1', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } })}\n\n` +
      `data: [DONE]\n\n`;
    const finalTextBody =
      `data: ${JSON.stringify({ id: '1', object: 'chat.completion.chunk', created: 1, model: 'glm-5.1', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] })}\n\n` +
      `data: ${JSON.stringify({ id: '1', object: 'chat.completion.chunk', created: 1, model: 'glm-5.1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } })}\n\n` +
      `data: [DONE]\n\n`;
    let chatCalls = 0;
    let imageCalls = 0;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const rawBody = typeof init?.body === 'string' ? init.body : String(init?.body ?? '{}');
      const body = JSON.parse(rawBody) as { model?: string; prompt?: string; tools?: Array<{ function?: { name?: string } }> };
      if (String(url) === 'https://ark.example.com/api/v3/images/generations') {
        imageCalls++;
        expect(body.model).toBe('doubao-seedream-4-0');
        expect(body.prompt).toBe('cute duck');
        return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('ark-png').toString('base64') }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      expect(String(url)).toBe('https://huawei.example.com/openai/v1/chat/completions');
      chatCalls++;
      expect(body.model).toBe('glm-5.1');
      if (chatCalls === 1) {
        const toolNames = body.tools?.map((t) => t.function?.name) ?? [];
        expect(toolNames).toContain('image_generate');
      }
      return new Response(chatCalls === 1 ? toolCallBody : finalTextBody, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat',
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
        payload: {
          model_id: huaweiChat.id,
          messages: [{ role: 'user', content: '帮我生成一张可爱鸭鸭的图片' }],
        },
      });
      expect(res.statusCode).toBe(200);
      expect(chatCalls).toBe(2);
      expect(imageCalls).toBe(1);
      expect(res.payload).toContain('"type":"tool_image_result"');
      expect(res.payload).not.toContain('"type":"capability_route"');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('honors the global image_model_default preference for LLM tool calls', async () => {
    const models = new ModelsRepo(db);
    const providers = new ProvidersRepo(db);
    const memories = new MemoriesRepo(db);
    const huawei = providers.create({
      name: 'Huawei MaaS',
      type: 'huawei_maas',
      base_url: 'https://huawei.example.com/openai/v1',
      api_key: 'hw-test-key',
    });
    await keystore.write(huawei.api_key_ref!, 'hw-test-key');
    const packy = providers.create({
      name: 'PackyAPI',
      type: 'openai',
      base_url: 'https://www.packyapi.test/v1',
      api_key: 'packy-test-key',
    });
    await keystore.write(packy.api_key_ref!, 'packy-test-key');
    const huaweiChat = models.create({
      provider_id: huawei.id,
      model_name: 'glm-5.1',
      capability: 'chat',
      display_name: 'GLM 5.1',
      supports_tools: true,
    });
    const packyImage = models.create({
      provider_id: packy.id,
      model_name: 'gpt-image-2',
      capability: 'image',
      display_name: 'GPT Image 2',
      price_per_image: null,
    });
    memories.set('global', null, 'image_model_default', packyImage.id);

    const toolCallBody =
      `data: ${JSON.stringify({ id: '1', object: 'chat.completion.chunk', created: 1, model: 'glm-5.1', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_img_1', type: 'function', function: { name: 'image_generate', arguments: '' } }] }, finish_reason: null }] })}\n\n` +
      `data: ${JSON.stringify({ id: '1', object: 'chat.completion.chunk', created: 1, model: 'glm-5.1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"prompt":"green icon"}' } }] }, finish_reason: null }] })}\n\n` +
      `data: ${JSON.stringify({ id: '1', object: 'chat.completion.chunk', created: 1, model: 'glm-5.1', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } })}\n\n` +
      `data: [DONE]\n\n`;
    const finalTextBody =
      `data: ${JSON.stringify({ id: '1', object: 'chat.completion.chunk', created: 1, model: 'glm-5.1', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] })}\n\n` +
      `data: ${JSON.stringify({ id: '1', object: 'chat.completion.chunk', created: 1, model: 'glm-5.1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } })}\n\n` +
      `data: [DONE]\n\n`;
    let chatCalls = 0;
    let imageCalls = 0;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const rawBody = typeof init?.body === 'string' ? init.body : String(init?.body ?? '{}');
      const body = JSON.parse(rawBody) as { model?: string; prompt?: string; tools?: Array<{ function?: { name?: string } }> };
      if (String(url) === 'https://www.packyapi.test/v1/images/generations') {
        imageCalls++;
        expect(body.model).toBe('gpt-image-2');
        expect(body.prompt).toBe('green icon');
        return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('packy-png').toString('base64') }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      expect(String(url)).toBe('https://huawei.example.com/openai/v1/chat/completions');
      chatCalls++;
      return new Response(chatCalls === 1 ? toolCallBody : finalTextBody, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat',
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
        payload: {
          model_id: huaweiChat.id,
          messages: [{ role: 'user', content: '生成绿色图标' }],
        },
      });
      expect(res.statusCode).toBe(200);
      expect(chatCalls).toBe(2);
      expect(imageCalls).toBe(1);
      const imageCost = db
        .select()
        .from(cost_records)
        .all()
        .find((r) => r.feature === 'image' && r.model_id === packyImage.id);
      expect(imageCost?.model_name_snapshot).toBe('gpt-image-2');
      expect(res.payload).toContain('"type":"tool_image_result"');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('normalizes Huawei MaaS data URI image responses before persisting', async () => {
    const providers = new ProvidersRepo(db);
    const models = new ModelsRepo(db);
    const prov = providers.create({
      name: 'Huawei MaaS',
      type: 'huawei_maas',
      base_url: 'https://api.modelarts-maas.com/openai/v1',
      api_key: 'hw-test-key',
    });
    await keystore.write(prov.api_key_ref!, 'hw-test-key');
    const huaweiImage = models.create({
      provider_id: prov.id,
      model_name: 'qwen-image',
      capability: 'image',
      display_name: 'Qwen Image',
      price_per_call: 0.02,
    });
    const payloadBytes = Buffer.from('fake-hw-png');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      expect(String(url)).toBe('https://api.modelarts-maas.com/v1/images/generations');
      const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string; prompt?: string };
      expect(body.model).toBe('qwen-image');
      expect(body.prompt).toBe('a robot');
      return new Response(
        JSON.stringify({
          data: [{ b64_json: `data:image/jpg;base64,${payloadBytes.toString('base64')}` }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    try {
      const res = await invokeImage(null, huaweiImage.id);
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        data: { ok: boolean; output?: { file_id: string; assistant_message_id: string } };
      };
      expect(body.data.ok).toBe(true);

      const fileRow = db.select().from(filesTable).all().find((f) => f.id === body.data.output!.file_id);
      expect(fileRow?.mime_type).toBe('image/jpeg');
      expect(path.extname(fileRow!.original_path)).toBe('.jpg');
      expect(fs.readFileSync(fileRow!.original_path)).toEqual(payloadBytes);

      const msgRow = db.select().from(messagesTable).all().find((m) => m.id === body.data.output!.assistant_message_id);
      const attachments = JSON.parse(msgRow?.attachments ?? '[]') as Array<{ data_b64?: string; mime?: string }>;
      expect(attachments[0]?.mime).toBe('image/jpeg');
      expect(attachments[0]?.data_b64).toBe(payloadBytes.toString('base64'));
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('routes explicit /image commands to picker even for tool-capable chat models', async () => {
    const models = new ModelsRepo(db);
    const providers = new ProvidersRepo(db);
    const provider = providers.list()[0]!;
    const toolChat = models.create({
      provider_id: provider.id,
      model_name: 'gpt-tools-command',
      capability: 'chat',
      display_name: 'GPT tools command',
      supports_tools: true,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: {
        model_id: toolChat.id,
        messages: [{ role: 'user', content: '/image a robot' }],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('"type":"capability_route"');
    expect(res.payload).toContain('"prompt":"a robot"');
  });
});
