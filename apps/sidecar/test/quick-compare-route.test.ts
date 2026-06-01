import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { ControlClient } from '../src/control/client.js';
import { openDb } from '../src/db/index.js';
import {
  MessagesRepo,
  ModelsRepo,
  ProvidersRepo,
  QuickCompareRepo,
  RunEventsRepo,
} from '../src/db/repos/index.js';
import { MemoryStore } from '../src/keystore.js';

const bearer = 'test_bearer_quick_compare_route';
const auth = { authorization: `Bearer ${bearer}` };

describe('quick compare route', () => {
  let app: FastifyInstance;
  let dbPath: string;
  let db: ReturnType<typeof openDb>;
  let models: string[];
  let qcRepo: QuickCompareRepo;
  let msgRepo: MessagesRepo;
  let modelsRepo: ModelsRepo;
  let keystore: MemoryStore;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `taori-quick-compare-route-${Date.now()}-${Math.random()}.db`);
    db = openDb(dbPath);
    qcRepo = new QuickCompareRepo(db);
    msgRepo = new MessagesRepo(db);
    const providers = new ProvidersRepo(db);
    modelsRepo = new ModelsRepo(db);
    const provider = providers.create({
      name: 'No-key Provider',
      type: 'openai',
      base_url: 'https://example.com/v1',
    });
    models = [0, 1, 2].map((index) =>
      modelsRepo.create({
        provider_id: provider.id,
        model_name: `qc-${index}`,
        display_name: `QC ${index}`,
        capability: 'chat',
        price_input_per_1m: index + 1,
        price_output_per_1m: index + 2,
        context_length: index === 2 ? 100_000 : 8_000,
        supports_tools: index === 2,
        supports_json: index === 2,
      }).id,
    );
    keystore = new MemoryStore();
    app = buildServer({
      config: {
        port: 0,
        bearer,
        dbPath,
        controlUrl: null,
        controlBearer: null,
        isDev: false,
        version: '0.0.0-test',
        testHooks: { hermeticWeb: true },
      },
      db,
      control: new ControlClient({ url: null, bearer: null }),
      keystore,
      startedAt: Date.now(),
    });
    await app.ready();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
    fs.rmSync(dbPath, { force: true });
  });

  async function createCompare(payload?: Record<string, unknown>): Promise<{ compareId: string; outputIds: string[] }> {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/quick-compare',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: {
        model_ids: [models[0], models[1], models[2]],
        messages: [{ role: 'user', content: '比较三个方案' }],
        ...payload,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('"type":"qc.meta"');
    expect(res.body).toContain('"type":"qc.done"');
    expect(res.body).toContain('"execution_mode":"local_preview"');
    expect(res.body).toContain('"preview_reason":"api_key_missing"');
    const match = /"compare_id":"([^"]+)"/.exec(res.body);
    expect(match?.[1]).toBeTruthy();
    const outputs = qcRepo.listOutputs(match![1]!);
    const expectedOutputCount = Array.isArray(payload?.model_ids)
      ? payload.model_ids.length
      : Array.isArray(payload?.participant_configs)
        ? payload.participant_configs.length
        : 3;
    expect(outputs).toHaveLength(expectedOutputCount);
    expect(outputs.every((output) => output.status === 'complete')).toBe(true);
    expect(outputs.map((output) => output.content)).toEqual(
      expect.arrayContaining([expect.stringContaining('Quick Compare 本地预览')]),
    );
    return { compareId: match![1]!, outputIds: outputs.map((output) => output.id) };
  }

  it('streams compare annotations and persists outputs without assistant messages', async () => {
    await createCompare();
  });

  it('returns detail, adopts an output, and retries an output', async () => {
    const { compareId, outputIds } = await createCompare();

    const detailRes = await app.inject({
      method: 'GET',
      url: `/v1/quick-compare/${compareId}`,
      headers: auth,
    });
    expect(detailRes.statusCode).toBe(200);
    expect(detailRes.json().data.outputs).toHaveLength(3);

    const adoptRes = await app.inject({
      method: 'POST',
      url: `/v1/quick-compare/${compareId}/outputs/${outputIds[0]}/adopt`,
      headers: { ...auth, 'content-type': 'application/json' },
      payload: {},
    });
    expect(adoptRes.statusCode).toBe(200);
    const assistantId = adoptRes.json().data.assistant_message_id as string;
    expect(msgRepo.get(assistantId)?.role).toBe('assistant');
    expect(qcRepo.getRun(compareId)?.adopted_output_id).toBe(outputIds[0]);

    const retryRes = await app.inject({
      method: 'POST',
      url: `/v1/quick-compare/${compareId}/retry`,
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { output_id: outputIds[1] },
    });
    expect(retryRes.statusCode).toBe(200);
    expect(retryRes.body).toContain('"type":"qc.done"');
    expect(qcRepo.getOutput(outputIds[1])?.status).toBe('complete');
  });

  it('persists per-participant tool selections and reuses them on retry', async () => {
    const { compareId, outputIds } = await createCompare({
      participant_configs: [
        { model_id: models[0], tool_names: ['builtin.web_search'] },
        { model_id: models[1], tool_names: [] },
        { model_id: models[2], tool_names: ['builtin.web_search', 'builtin.web_fetch'] },
      ],
    });

    const outputs = qcRepo.listOutputs(compareId);
    expect(outputs[0]?.tool_names).toEqual([]);
    expect(outputs[1]?.tool_names).toEqual([]);
    expect(outputs[2]?.tool_names).toEqual(['builtin.web_search', 'builtin.web_fetch']);

    const retryRes = await app.inject({
      method: 'POST',
      url: `/v1/quick-compare/${compareId}/retry`,
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { output_id: outputIds[2] },
    });
    expect(retryRes.statusCode).toBe(200);
    expect(retryRes.body).toContain('"tool_names":["builtin.web_search","builtin.web_fetch"]');
    expect(qcRepo.getOutput(outputIds[2])?.tool_names).toEqual(['builtin.web_search', 'builtin.web_fetch']);
  });

  it('rejects retry when the output model provider has been disabled', async () => {
    const { compareId, outputIds } = await createCompare();
    const providers = new ProvidersRepo(db);
    const provider = providers.list()[0]!;
    providers.update(provider.id, { enabled: false });

    const retryRes = await app.inject({
      method: 'POST',
      url: `/v1/quick-compare/${compareId}/retry`,
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { output_id: outputIds[0] },
    });

    expect(retryRes.statusCode).toBe(400);
    expect(retryRes.json().message).toContain('已停用');
  });

  it('returns user-facing validation errors for ineligible requested models', async () => {
    const provider = new ProvidersRepo(db).list()[0]!;
    const disabledModel = modelsRepo.create({
      provider_id: provider.id,
      model_name: 'qc-disabled',
      display_name: 'Disabled Candidate',
      capability: 'chat',
      enabled: false,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/quick-compare',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: {
        model_ids: [models[0], disabledModel.id],
        messages: [{ role: 'user', content: '比较两个方案' }],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('Disabled Candidate');
    expect(res.json().message).not.toContain(disabledModel.id);
  });

  it('rejects requested models whose provider is disabled', async () => {
    const providers = new ProvidersRepo(db);
    const provider = providers.list()[0]!;
    providers.update(provider.id, { enabled: false });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/quick-compare',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: {
        model_ids: [models[0], models[1]],
        messages: [{ role: 'user', content: '比较两个方案' }],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('服务商');
    expect(res.json().message).toContain('已停用');
  });

  it('skips disabled providers during automatic quick compare model selection', async () => {
    const providers = new ProvidersRepo(db);
    const disabledProvider = providers.create({
      name: 'Disabled Cheap Provider',
      type: 'openai',
      base_url: 'https://disabled-cheap.example.com/v1',
    });
    providers.update(disabledProvider.id, { enabled: false });
    const disabledModel = modelsRepo.create({
      provider_id: disabledProvider.id,
      model_name: 'disabled-cheap',
      display_name: 'Disabled Cheap',
      capability: 'chat',
      price_input_per_1m: 0.001,
      price_output_per_1m: 0.001,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/quick-compare',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: {
        messages: [{ role: 'user', content: '自动选择模型比较' }],
      },
    });

    expect(res.statusCode).toBe(200);
    const match = /"compare_id":"([^"]+)"/.exec(res.body);
    expect(match?.[1]).toBeTruthy();
    const outputs = qcRepo.listOutputs(match![1]!);
    expect(outputs).toHaveLength(3);
    expect(outputs.map((output) => output.model_id)).not.toContain(disabledModel.id);
  });

  it('returns a current-model specific message when the first requested model is demoted', async () => {
    modelsRepo.recordFailure(models[0]!, 'network');
    modelsRepo.recordFailure(models[0]!, 'network');
    modelsRepo.recordFailure(models[0]!, 'network');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/quick-compare',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: {
        model_ids: [models[0], models[1]],
        messages: [{ role: 'user', content: '比较两个方案' }],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('当前会话模型暂不可用于 Quick Compare');
    expect(res.json().message).not.toContain(models[0]);
  });

  it('uses DeepSeek official tool loop for quick compare participants', async () => {
    const providers = new ProvidersRepo(db);
    const provider = providers.create({
      name: 'DeepSeek 官方',
      type: 'deepseek',
      base_url: 'https://api.deepseek.com',
      api_key: 'sk-deepseek-test',
    });
    await keystore.write(provider.api_key_ref!, 'sk-deepseek-test');
    const deepseekModel = modelsRepo.create({
      provider_id: provider.id,
      model_name: 'deepseek-v4-flash',
      display_name: 'DeepSeek V4 Flash',
      capability: 'chat',
      supports_tools: true,
    });

    let deepseekCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        stream?: boolean;
        messages?: Array<Record<string, unknown>>;
        tools?: Array<{ function?: { name?: string } }>;
      };
      if (String(url) === 'https://api.deepseek.com/chat/completions') {
        deepseekCalls++;
        expect(body.stream).toBe(false);
        if (deepseekCalls === 1) {
          expect(body.tools?.some((tool) => tool.function?.name === 'web_search')).toBe(true);
          return new Response(JSON.stringify({
            choices: [{
              message: {
                content: null,
                reasoning_content: 'Need web evidence.',
                tool_calls: [{
                  id: 'call_web_1',
                  type: 'function',
                  function: {
                    name: 'web_search',
                    arguments: '{"query":"quick compare deepseek"}',
                  },
                }],
              },
              finish_reason: 'tool_calls',
            }],
            usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        const hasReasoning = body.messages?.some((message) =>
          message.role === 'assistant' && message.reasoning_content === 'Need web evidence.',
        );
        expect(hasReasoning).toBe(true);
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: 'DeepSeek quick compare answer.',
            },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected fetch ${String(url)}`);
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/quick-compare',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: {
        model_ids: [deepseekModel.id, models[0]],
        participant_configs: [
          { model_id: deepseekModel.id, tool_names: ['builtin.web_search'] },
          { model_id: models[0], tool_names: [] },
        ],
        messages: [{ role: 'user', content: '比较两个方案' }],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(deepseekCalls).toBe(2);
    expect(res.body).toContain('DeepSeek quick compare answer.');
    expect(res.body).toContain('"type":"qc.tool_trace"');
  }, 15000);

  it('pre-searches current questions before quick compare participants stream', async () => {
    const providers = new ProvidersRepo(db);
    const provider = providers.create({
      name: 'OpenRouter',
      type: 'openrouter',
      base_url: 'https://openrouter.example.com/api/v1',
      api_key: 'sk-qc-web-context',
    });
    await keystore.write(provider.api_key_ref!, 'sk-qc-web-context');
    const model = modelsRepo.create({
      provider_id: provider.id,
      model_name: 'qc-web-context',
      display_name: 'QC Web Context',
      capability: 'chat',
      supports_tools: false,
    });
    const providerBodies: Array<{ messages?: Array<{ role?: string; content?: string }> }> = [];
    const sseBody =
      `data: ${JSON.stringify({ id: '1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { role: 'assistant', content: '已结合预搜索。' }, finish_reason: null }] })}\n\n` +
      `data: ${JSON.stringify({ id: '1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } })}\n\n` +
      `data: [DONE]\n\n`;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const asText = String(url);
      const hostname = new URL(asText).hostname;
      if (hostname === 'html.duckduckgo.com' || hostname === 'duckduckgo.com') {
        return new Response(
          `<!doctype html><html><body>
            <a class="result__a" href="https://example.com/sz-admission">深圳升学报名建议</a>
            <a class="result__snippet">深圳初升高报名与分数线测试结果。</a>
          </body></html>`,
          { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
        );
      }
      if (hostname === 'example.com') {
        return new Response(
          `<!doctype html><html><head><title>深圳升学报名建议</title></head><body>
            <h1>深圳升学报名建议</h1>
            <p>坂田、初升高、模拟考试 522 分与报名策略的确定性测试页面。</p>
          </body></html>`,
          { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
        );
      }
      expect(hostname).toBe('openrouter.example.com');
      providerBodies.push(JSON.parse(String(init?.body ?? '{}')));
      return new Response(sseBody, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/quick-compare',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: {
        model_ids: [model.id, models[0]],
        participant_configs: [
          { model_id: model.id, tool_names: [] },
          { model_id: models[0], tool_names: [] },
        ],
        messages: [{ role: 'user', content: '深圳初升高，模拟考试522分，家住坂田，如果要报名，什么建议？' }],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('"type":"qc.orchestration"');
    expect(res.body).toContain('"reason":"high_stakes_current"');
    expect(res.body).toContain('"external_info":"web_search_fetch"');
    expect(res.body).toContain('"cite_required":true');
    expect(res.body).toContain('"type":"qc.tool_trace"');
    expect(res.body).toContain('预搜索网页');
    const sentMessages = providerBodies[0]?.messages ?? [];
    expect(sentMessages.some((message) =>
      message.role === 'system' &&
      String(message.content ?? '').includes('系统已经按本轮编排计划完成联网预搜索') &&
      String(message.content ?? '').includes('深圳初升高') &&
      String(message.content ?? '').includes('web_page 1'),
    )).toBe(true);
    const compareId = /"compare_id":"([^"]+)"/.exec(res.body)?.[1];
    expect(compareId).toBeTruthy();
    const compare = qcRepo.getRun(compareId!);
    expect(compare).toBeTruthy();
    const events = new RunEventsRepo(db).listByRun(compare!.run_id);
    expect(events.some((event) =>
      event.kind === 'orchestration.plan' &&
      event.payload?.run_kind === 'quick_compare' &&
      event.payload?.reason === 'high_stakes_current',
    )).toBe(true);
    expect(events.some((event) => event.kind === 'tool.completed' && event.payload?.preflight === true)).toBe(true);
  }, 15000);

  it('pre-searches current questions before retrying a quick compare output', async () => {
    const providers = new ProvidersRepo(db);
    const provider = providers.create({
      name: 'OpenRouter',
      type: 'openrouter',
      base_url: 'https://openrouter.example.com/api/v1',
      api_key: 'sk-qc-retry-web-context',
    });
    const model = modelsRepo.create({
      provider_id: provider.id,
      model_name: 'qc-retry-web-context',
      display_name: 'QC Retry Web Context',
      capability: 'chat',
      supports_tools: false,
    });
    const { compareId } = await createCompare({
      model_ids: [model.id, models[0]],
      participant_configs: [
        { model_id: model.id, tool_names: [] },
        { model_id: models[0], tool_names: [] },
      ],
      messages: [{ role: 'user', content: '深圳初升高，模拟考试522分，家住坂田，如果要报名，什么建议？' }],
    });
    await keystore.write(provider.api_key_ref!, 'sk-qc-retry-web-context');
    const output = qcRepo.listOutputs(compareId).find((item) => item.model_id === model.id)!;
    const providerBodies: Array<{ messages?: Array<{ role?: string; content?: string }> }> = [];
    const sseBody =
      `data: ${JSON.stringify({ id: '1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { role: 'assistant', content: '重试已结合预搜索。' }, finish_reason: null }] })}\n\n` +
      `data: ${JSON.stringify({ id: '1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } })}\n\n` +
      `data: [DONE]\n\n`;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const asText = String(url);
      const hostname = new URL(asText).hostname;
      if (hostname === 'html.duckduckgo.com' || hostname === 'duckduckgo.com') {
        return new Response(
          `<!doctype html><html><body>
            <a class="result__a" href="https://example.com/sz-retry-admission">深圳升学重试报名建议</a>
            <a class="result__snippet">深圳初升高重试搜索结果。</a>
          </body></html>`,
          { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
        );
      }
      if (hostname === 'example.com') {
        return new Response(
          `<!doctype html><html><head><title>深圳升学重试报名建议</title></head><body>
            <h1>深圳升学重试报名建议</h1>
            <p>坂田、初升高与报名策略的 Quick Compare retry 测试页面。</p>
          </body></html>`,
          { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
        );
      }
      expect(hostname).toBe('openrouter.example.com');
      providerBodies.push(JSON.parse(String(init?.body ?? '{}')));
      return new Response(sseBody, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });

    const retryRes = await app.inject({
      method: 'POST',
      url: `/v1/quick-compare/${compareId}/retry`,
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { output_id: output.id },
    });

    expect(retryRes.statusCode).toBe(200);
    expect(retryRes.body).toContain('"type":"qc.orchestration"');
    expect(retryRes.body).toContain('"reason":"high_stakes_current"');
    expect(retryRes.body).toContain('"type":"qc.tool_trace"');
    expect(retryRes.body).toContain('预搜索网页');
    const sentMessages = providerBodies[0]?.messages ?? [];
    expect(sentMessages.some((message) =>
      message.role === 'system' &&
      String(message.content ?? '').includes('系统已经按本轮编排计划完成联网预搜索') &&
      String(message.content ?? '').includes('web_page 1'),
    )).toBe(true);
    const compare = qcRepo.getRun(compareId)!;
    const events = new RunEventsRepo(db).listByRun(compare.run_id);
    expect(events.some((event) =>
      event.kind === 'orchestration.plan' &&
      event.payload?.run_kind === 'quick_compare_retry' &&
      event.payload?.output_id === output.id,
    )).toBe(true);
  }, 15000);

  it('uses DeepSeek tool loop for hosted deepseek-v4 models on compatible providers', async () => {
    const providers = new ProvidersRepo(db);
    const provider = providers.create({
      name: '阿里云百炼',
      type: 'custom',
      base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      api_key: 'sk-bailian-test',
    });
    await keystore.write(provider.api_key_ref!, 'sk-bailian-test');
    const hostedModel = modelsRepo.create({
      provider_id: provider.id,
      model_name: 'deepseek-v4-flash',
      display_name: 'deepseek-v4-flash',
      capability: 'chat',
      supports_tools: true,
    });

    let calls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (String(url) !== 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions') {
        throw new Error(`unexpected fetch ${String(url)}`);
      }
      calls++;
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        stream?: boolean;
        messages?: Array<Record<string, unknown>>;
        tools?: Array<{ function?: { name?: string } }>;
      };
      expect(body.stream).toBe(false);
      if (calls === 1) {
        expect(body.tools?.some((tool) => tool.function?.name === 'web_search')).toBe(true);
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: '',
              reasoning_content: 'Need evidence first.',
              tool_calls: [{
                id: 'call_web_1',
                type: 'function',
                function: {
                  name: 'web_search',
                  arguments: '{"query":"hosted deepseek"}',
                },
              }],
            },
            finish_reason: 'tool_calls',
          }],
          usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      expect(body.messages?.some((message) =>
        message.role === 'assistant' && message.reasoning_content === 'Need evidence first.',
      )).toBe(true);
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: 'Hosted deepseek-v4 answer.',
          },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 18, completion_tokens: 6, total_tokens: 24 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/quick-compare',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: {
        model_ids: [hostedModel.id, models[0]],
        participant_configs: [
          { model_id: hostedModel.id, tool_names: ['builtin.web_search'] },
          { model_id: models[0], tool_names: [] },
        ],
        messages: [{ role: 'user', content: '比较两个方案' }],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(calls).toBe(2);
    expect(res.body).toContain('Hosted deepseek-v4 answer.');
  }, 15000);

  it('marks empty quick compare provider output as failed instead of complete', async () => {
    const providers = new ProvidersRepo(db);
    const provider = providers.create({
      name: 'OpenRouter',
      type: 'openrouter',
      base_url: 'https://openrouter.example.com/api/v1',
      api_key: 'sk-empty',
    });
    await keystore.write(provider.api_key_ref!, 'sk-empty');
    const model = modelsRepo.create({
      provider_id: provider.id,
      model_name: 'empty-model',
      display_name: 'Empty Model',
      capability: 'chat',
      supports_tools: true,
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      `data: ${JSON.stringify({ id: '1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 0, total_tokens: 4 } })}\n\n` +
      `data: [DONE]\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/quick-compare',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: {
        model_ids: [model.id, models[0]],
        participant_configs: [
          { model_id: model.id, tool_names: ['builtin.web_search'] },
          { model_id: models[0], tool_names: [] },
        ],
        messages: [{ role: 'user', content: '比较两个方案' }],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('"type":"qc.participant_failed"');
    const compareId = /"compare_id":"([^"]+)"/.exec(res.body)?.[1];
    expect(compareId).toBeTruthy();
    const outputs = qcRepo.listOutputs(compareId!);
    const failed = outputs.find((output) => output.model_id === model.id);
    expect(failed?.status).toBe('failed');
  });
});
