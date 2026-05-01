import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildServer } from '../src/server.js';
import { openDb } from '../src/db/index.js';
import { ControlClient } from '../src/control/client.js';
import { MemoryStore } from '../src/keystore.js';
import { MemoriesRepo, ModelsRepo, ProvidersRepo } from '../src/db/repos/index.js';
import type { FastifyInstance } from 'fastify';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const bearer = 'test_bearer_c3';
const auth = { authorization: `Bearer ${bearer}` };
const authJson = {
  authorization: `Bearer ${bearer}`,
  'content-type': 'application/json',
};

function newApp() {
  const dbPath = path.join(os.tmpdir(), `taori-c3-${Date.now()}-${Math.random()}.db`);
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

function streamReply(text: string): string {
  return (
    `data: ${JSON.stringify({
      id: '1',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'mock',
      choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
    })}\n\n`
    + `data: ${JSON.stringify({
      id: '1',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'mock',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })}\n\n`
    + 'data: [DONE]\n\n'
  );
}

describe('C3 prompt templates + personas', () => {
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
    fs.rmSync(dbPath, { force: true });
    vi.restoreAllMocks();
  });

  it('supports CRUD for prompt_templates and personas', async () => {
    const tplCreate = await app.inject({
      method: 'POST',
      url: '/v1/prompt-templates',
      headers: authJson,
      payload: {
        name: '分析模板',
        description: '带变量',
        content: '请分析 {{topic}} 的风险。',
      },
    });
    expect(tplCreate.statusCode).toBe(201);
    const template = tplCreate.json() as { id: string; name: string };
    expect(template.id).toMatch(/^ptpl_/);

    const tplList = await app.inject({
      method: 'GET',
      url: '/v1/prompt-templates',
      headers: auth,
    });
    expect(tplList.statusCode).toBe(200);
    expect((tplList.json() as { prompt_templates: unknown[] }).prompt_templates).toHaveLength(1);

    const tplPatch = await app.inject({
      method: 'PATCH',
      url: `/v1/prompt-templates/${template.id}`,
      headers: authJson,
      payload: { name: '分析模板 v2' },
    });
    expect(tplPatch.statusCode).toBe(200);
    expect((tplPatch.json() as { name: string }).name).toBe('分析模板 v2');

    const personaCreate = await app.inject({
      method: 'POST',
      url: '/v1/personas',
      headers: authJson,
      payload: {
        name: '严格评审',
        description: '偏架构审查',
        prompt: '你是一位严格的架构评审，优先指出边界、风险与回滚路径。',
      },
    });
    expect(personaCreate.statusCode).toBe(201);
    const persona = personaCreate.json() as { id: string; name: string };
    expect(persona.id).toMatch(/^per_/);

    const personaPatch = await app.inject({
      method: 'PATCH',
      url: `/v1/personas/${persona.id}`,
      headers: authJson,
      payload: { name: '严格评审 v2' },
    });
    expect(personaPatch.statusCode).toBe(200);
    expect((personaPatch.json() as { name: string }).name).toBe('严格评审 v2');

    const personaDelete = await app.inject({
      method: 'DELETE',
      url: `/v1/personas/${persona.id}`,
      headers: auth,
    });
    expect(personaDelete.statusCode).toBe(204);

    const tplDelete = await app.inject({
      method: 'DELETE',
      url: `/v1/prompt-templates/${template.id}`,
      headers: auth,
    });
    expect(tplDelete.statusCode).toBe(204);
  });

  it('persists conversation persona binding and injects system prompt into upstream chat', async () => {
    const provider = new ProvidersRepo(db).create({
      name: 'OpenAI',
      type: 'openai',
      base_url: 'https://mock-openai.example/v1',
      api_key: 'sk-test',
    });
    await keystore.write(provider.api_key_ref!, 'sk-test');
    const model = new ModelsRepo(db).create({
      provider_id: provider.id,
      model_name: 'mock-chat',
      capability: 'chat',
      display_name: 'Mock Chat',
    });

    const personaRes = await app.inject({
      method: 'POST',
      url: '/v1/personas',
      headers: authJson,
      payload: {
        name: '严格评审',
        prompt: '你是一位严格的架构评审，优先指出边界、风险与回滚路径。',
      },
    });
    const persona = personaRes.json() as { id: string; prompt: string };

    const seenBodies: Array<{ messages?: Array<{ role: string; content: string }> }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const raw = typeof init?.body === 'string' ? init.body : '';
      if (raw) {
        seenBodies.push(JSON.parse(raw) as { messages?: Array<{ role: string; content: string }> });
      }
      return new Response(streamReply('persona reply'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });

    const first = await app.inject({
      method: 'POST',
      url: '/v1/chat',
      headers: authJson,
      payload: {
        model_id: model.id,
        persona_id: persona.id,
        messages: [{ role: 'user', content: '请评审这个方案' }],
      },
    });
    expect(first.statusCode).toBe(200);
    const meta = JSON.parse(
      first.payload.split('\n').find((line) => line.startsWith('8:'))!.slice(2),
    )[0] as { conversation_id: string };
    const convId = meta.conversation_id;
    expect(
      new MemoriesRepo(db).get('session', convId, 'active_persona_id'),
    ).toBe(persona.id);

    const second = await app.inject({
      method: 'POST',
      url: '/v1/chat',
      headers: authJson,
      payload: {
        conversation_id: convId,
        model_id: model.id,
        messages: [
          { role: 'user', content: '请评审这个方案' },
          { role: 'assistant', content: 'persona reply' },
          { role: 'user', content: '继续补充风险' },
        ],
      },
    });
    expect(second.statusCode).toBe(200);
    expect(seenBodies).toHaveLength(2);
    expect(seenBodies[0]!.messages?.[0]).toEqual({
      role: 'system',
      content: persona.prompt,
    });
    expect(seenBodies[1]!.messages?.[0]).toEqual({
      role: 'system',
      content: persona.prompt,
    });
  });
});
