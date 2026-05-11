import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildServer } from '../src/server.js';
import { openDb } from '../src/db/index.js';
import { ControlClient } from '../src/control/client.js';
import { MemoryStore } from '../src/keystore.js';
import { MemoriesRepo, ModelsRepo, PersonasRepo, ProvidersRepo } from '../src/db/repos/index.js';
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

  it('seeds builtin personas on first list without duplicating them', async () => {
    const first = await app.inject({
      method: 'GET',
      url: '/v1/personas',
      headers: auth,
    });
    expect(first.statusCode).toBe(200);
    const firstPersonas = (first.json() as { personas: Array<{ name: string; description: string | null; prompt: string }> }).personas;
    expect(firstPersonas).toHaveLength(6);
    expect(firstPersonas.map((persona) => persona.name).sort()).toEqual([
      'OpenClaw 行动派助手',
      '初中教育专家',
      '哲学家',
      '小学教育专家',
      '数学家',
      '架构评审助手',
    ]);
    expect(firstPersonas.find((persona) => persona.name === '架构评审助手')!.description).toContain('示例 Persona');
    expect(firstPersonas.find((persona) => persona.name === '架构评审助手')!.prompt).toContain('模块边界');
    expect(firstPersonas.find((persona) => persona.name === 'OpenClaw 行动派助手')!.description).toContain('OpenClaw');
    const openClawPrompt = firstPersonas.find((persona) => persona.name === 'OpenClaw 行动派助手')!.prompt;
    expect(openClawPrompt).toContain('# Core Truths');
    expect(openClawPrompt).toContain('# Operating Style');
    expect(openClawPrompt).toContain('# Memory and Boundaries');
    expect(openClawPrompt).toContain('不要以寒暄开场');
    expect(openClawPrompt).toContain('记忆系统用来服务用户，不用来膨胀人格');
    expect(firstPersonas.find((persona) => persona.name === '哲学家')!.prompt).toContain('价值判断');
    expect(firstPersonas.find((persona) => persona.name === '数学家')!.prompt).toContain('反例');
    expect(firstPersonas.find((persona) => persona.name === '初中教育专家')!.description).toContain('初中阶段');
    expect(firstPersonas.find((persona) => persona.name === '小学教育专家')!.prompt).toContain('小学生');

    const second = await app.inject({
      method: 'GET',
      url: '/v1/personas',
      headers: auth,
    });
    expect(second.statusCode).toBe(200);
    const secondPersonas = (second.json() as { personas: Array<{ id: string }> }).personas;
    expect(secondPersonas).toHaveLength(6);

    for (const persona of secondPersonas) {
      const deleted = await app.inject({
        method: 'DELETE',
        url: `/v1/personas/${persona.id}`,
        headers: auth,
      });
      expect(deleted.statusCode).toBe(204);
    }

    const afterDelete = await app.inject({
      method: 'GET',
      url: '/v1/personas',
      headers: auth,
    });
    expect(afterDelete.statusCode).toBe(200);
    expect((afterDelete.json() as { personas: unknown[] }).personas).toHaveLength(0);
  });

  it('adds newer builtin personas once for older installs without duplicating existing defaults', async () => {
    const memoriesRepo = new MemoriesRepo(db);
    memoriesRepo.set('global', null, 'personas.default_seeded.v1', '1');
    new PersonasRepo(db).create({
      name: '架构评审助手',
      description: '示例 Persona：偏严格，帮助检查模块边界、风险与落地路径。',
      prompt: '你是一位严格但务实的软件架构评审。回答时优先指出模块边界、接口契约、状态归属、依赖方向、风险、验证方式和可回滚路径。避免泛泛鼓励，给出可以直接执行的建议。',
    });

    const first = await app.inject({
      method: 'GET',
      url: '/v1/personas',
      headers: auth,
    });
    expect(first.statusCode).toBe(200);
    const names = (first.json() as { personas: Array<{ name: string }> }).personas.map((persona) => persona.name).sort();
    expect(names).toEqual([
      'OpenClaw 行动派助手',
      '初中教育专家',
      '哲学家',
      '小学教育专家',
      '数学家',
      '架构评审助手',
    ]);

    const second = await app.inject({
      method: 'GET',
      url: '/v1/personas',
      headers: auth,
    });
    expect(second.statusCode).toBe(200);
    expect((second.json() as { personas: Array<{ name: string }> }).personas.map((persona) => persona.name).sort()).toEqual([
      'OpenClaw 行动派助手',
      '初中教育专家',
      '哲学家',
      '小学教育专家',
      '数学家',
      '架构评审助手',
    ]);
  });

  it('upgrades untouched legacy OpenClaw persona to SOUL prompt without resurrecting deleted legacy persona', async () => {
    const memoriesRepo = new MemoriesRepo(db);
    const personasRepo = new PersonasRepo(db);
    memoriesRepo.set('global', null, 'personas.default_seeded.v1', '1');
    memoriesRepo.set('global', null, 'personas.openclaw_seeded.v1', '1');
    personasRepo.create({
      name: 'OpenClaw 行动派助手',
      description: '受 OpenClaw 灵魂启发：少废话、有判断、先查再问、行动导向、重隐私边界。',
      prompt:
        '你是一位受 OpenClaw 气质启发的个人 AI 助手。直接进入答案，不用“好问题”“乐意帮忙”这类套话开场。要有判断和偏好：能明确给建议，发现坏主意时尽早指出，但保持尊重。默认先自己查上下文、读材料、整理线索，再在必要时提问。回答以行动为先：优先给可执行下一步、决策建议、命令或检查路径，而不是空泛讨论。简洁优先，只有在深度真的有用时才展开。可以有一点自然的机智，但不要油腻、不要企业腔。重视隐私、安全和边界：对外部或高风险动作保持谨慎，对本地分析、整理和推进工作可以主动。你的目标不是显得热情，而是把事做成，并让人愿意长期信任你。',
    });

    const upgradedRes = await app.inject({
      method: 'GET',
      url: '/v1/personas',
      headers: auth,
    });
    expect(upgradedRes.statusCode).toBe(200);
    const upgraded = (upgradedRes.json() as { personas: Array<{ id: string; name: string; prompt: string }> }).personas.find(
      (persona) => persona.name === 'OpenClaw 行动派助手',
    );
    expect(upgraded?.prompt).toContain('# Core Truths');
    expect(upgraded?.prompt).toContain('记忆系统用来服务用户，不用来膨胀人格');

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v1/personas/${upgraded!.id}`,
      headers: auth,
    });
    expect(deleted.statusCode).toBe(204);

    const afterDelete = await app.inject({
      method: 'GET',
      url: '/v1/personas',
      headers: auth,
    });
    expect(afterDelete.statusCode).toBe(200);
    expect(
      (afterDelete.json() as { personas: Array<{ name: string }> }).personas.some(
        (persona) => persona.name === 'OpenClaw 行动派助手',
      ),
    ).toBe(false);
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
