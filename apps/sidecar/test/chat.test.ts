import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildServer } from '../src/server.js';
import { openDb } from '../src/db/index.js';
import { ControlClient } from '../src/control/client.js';
import { MemoryStore } from '../src/keystore.js';
import { ConversationsRepo, FilesRepo, MessagesRepo, ProvidersRepo, ModelsRepo, RunEventsRepo } from '../src/db/repos/index.js';
import type { FastifyInstance } from 'fastify';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const bearer = 'test_bearer_chat';

function newApp() {
  const dbPath = path.join(os.tmpdir(), `taori-chat-${Date.now()}-${Math.random()}.db`);
  const db = openDb(dbPath);
  const keystore = new MemoryStore();
  const app = buildServer({
    config: { port: 0, bearer, dbPath, controlUrl: null, controlBearer: null, isDev: false, version: '0.0.0-test' },
    db,
    control: new ControlClient({ url: null, bearer: null }),
    keystore,
    startedAt: Date.now(),
  });
  return { app, db, dbPath, keystore };
}

describe('chat M1.2', () => {
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

  it('mock-path: persists user + assistant messages and conversation', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: { model_id: 'mdl_unknown', messages: [{ role: 'user', content: 'hello taori' }] },
    });
    expect(res.statusCode).toBe(200);
    // Extract conversation_id from the meta annotation.
    const metaLine = res.payload.split('\n').find((l) => l.startsWith('8:'));
    expect(metaLine).toBeTruthy();
    const metaArr = JSON.parse(metaLine!.slice(2)) as Array<{ type: string; conversation_id?: string; message_id?: string }>;
    const meta = metaArr.find((m) => m.type === 'meta');
    expect(meta?.conversation_id).toMatch(/^conv_/);
    expect(meta?.message_id).toMatch(/^msg_/);

    const convRepo = new ConversationsRepo(db);
    const msgRepo = new MessagesRepo(db);
    const conv = convRepo.get(meta!.conversation_id!);
    expect(conv).toBeTruthy();
    const msgs = msgRepo.listByConversation(meta!.conversation_id!);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.role).toBe('user');
    expect(msgs[0]!.content).toBe('hello taori');
    expect(msgs[0]!.status).toBe('complete');
    expect(msgs[1]!.role).toBe('assistant');
    expect(msgs[1]!.status).toBe('complete');
    expect(msgs[1]!.content).toContain('hello taori');
  });

  it('rejects chat requests with too many messages', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: {
        model_id: 'mdl_unknown',
        messages: Array.from({ length: 201 }, () => ({ role: 'user', content: 'hi' })),
      },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload)).toMatchObject({ code: 'validation_error' });
  });

  it('rejects chat requests with an oversized single message', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: {
        model_id: 'mdl_unknown',
        messages: [{ role: 'user', content: 'x'.repeat(200_001) }],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload)).toMatchObject({ code: 'validation_error' });
  });

  it('mock-path: records a run timeline for the chat turn', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: { model_id: 'mdl_unknown', messages: [{ role: 'user', content: 'timeline please' }] },
    });
    expect(res.statusCode).toBe(200);
    const meta = JSON.parse(res.payload.split('\n').find((l) => l.startsWith('8:'))!.slice(2))[0] as {
      conversation_id: string;
      message_id: string;
    };
    const events = new RunEventsRepo(db).listByConversation(meta.conversation_id);
    expect(events.map((e) => e.kind)).toEqual(expect.arrayContaining([
      'turn.started',
      'context.snapshot',
      'model.started',
      'model.completed',
      'cost.recorded',
      'turn.completed',
    ]));
    expect(new Set(events.map((e) => e.run_id)).size).toBe(1);

    const routeRes = await app.inject({
      method: 'GET',
      url: `/v1/conversations/${meta.conversation_id}/run-events`,
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(routeRes.statusCode).toBe(200);
    const body = JSON.parse(routeRes.payload) as { data: { events: Array<{ kind: string }> } };
    expect(body.data.events.some((e) => e.kind === 'turn.completed')).toBe(true);

    const runsRes = await app.inject({
      method: 'GET',
      url: `/v1/conversations/${meta.conversation_id}/runs`,
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(runsRes.statusCode).toBe(200);
    const runsBody = JSON.parse(runsRes.payload) as {
      data: {
        runs: Array<{
          id: string;
          status: string;
          kind: string;
          assistant_message_id: string | null;
          event_count: number;
        }>;
      };
    };
    expect(runsBody.data.runs).toHaveLength(1);
    expect(runsBody.data.runs[0]).toMatchObject({
      status: 'completed',
      kind: 'chat',
      assistant_message_id: meta.message_id,
    });
    expect(runsBody.data.runs[0]!.event_count).toBeGreaterThanOrEqual(6);
  });

  it('injects matching file chunks and records context.file_chunks event', async () => {
    const conv = new ConversationsRepo(db).create({ title: 'rag chat' });
    new FilesRepo(db).insert({
      conversation_id: conv.id,
      message_id: null,
      original_path: 'notes.md',
      mime_type: 'text/markdown',
      size_bytes: 100,
      extracted_text: 'Local RAG uses sqlite bm25 chunks so long files do not flood the prompt.',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: {
        conversation_id: conv.id,
        model_id: 'mdl_unknown',
        messages: [{ role: 'user', content: 'How does sqlite bm25 help local RAG?' }],
      },
    });

    expect(res.statusCode).toBe(200);
    const events = new RunEventsRepo(db).listByConversation(conv.id);
    const fileEvent = events.find((event) => event.kind === 'context.file_chunks');
    expect(fileEvent).toBeTruthy();
    expect(fileEvent?.payload?.chunks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file_id: expect.stringMatching(/^file_/) }),
      ]),
    );
    const contextEvent = events.find((event) => event.kind === 'context.snapshot');
    const sources = contextEvent?.payload?.context_sources as Array<{ type: string; active: boolean }> | undefined;
    expect(sources?.some((source) => source.type === 'file_chunk' && source.active)).toBe(true);
  });

  it('reuses existing conversation_id on follow-up turn', async () => {
    const r1 = await app.inject({
      method: 'POST',
      url: '/v1/chat',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: { model_id: 'mdl_x', messages: [{ role: 'user', content: 'first' }] },
    });
    const meta1 = JSON.parse(r1.payload.split('\n').find((l) => l.startsWith('8:'))!.slice(2))[0];
    const convId = meta1.conversation_id;

    const r2 = await app.inject({
      method: 'POST',
      url: '/v1/chat',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: {
        conversation_id: convId,
        model_id: 'mdl_x',
        messages: [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'reply1' },
          { role: 'user', content: 'second' },
        ],
      },
    });
    expect(r2.statusCode).toBe(200);
    const msgs = new MessagesRepo(db).listByConversation(convId);
    // user1 + assistant1 + user2 + assistant2
    expect(msgs).toHaveLength(4);
    expect(msgs.filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['first', 'second']);
  });

  it('upstream-path: uses keystore key + streamText (mocked fetch)', async () => {
    // Seed a real provider + model + key.
    const provRepo = new ProvidersRepo(db);
    const modRepo = new ModelsRepo(db);
    const provider = provRepo.create({
      name: 'OpenRouter',
      type: 'openrouter',
      base_url: 'https://openrouter.example.com/api/v1',
      api_key: 'sk-test-xyz',
    });
    await keystore.write(provider.api_key_ref!, 'sk-test-xyz');
    const model = modRepo.create({
      provider_id: provider.id,
      model_name: 'meta/llama-3-8b',
      capability: 'chat',
      display_name: 'Llama 3 8B',
    });

    // Mock the upstream OpenAI-compat /chat/completions stream response.
    const sseBody =
      `data: ${JSON.stringify({ id: '1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello' }, finish_reason: null }] })}\n\n` +
      `data: ${JSON.stringify({ id: '1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { content: ' world' }, finish_reason: null }] })}\n\n` +
      `data: ${JSON.stringify({ id: '1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })}\n\n` +
      `data: [DONE]\n\n`;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      expect(String(url)).toContain('openrouter.example.com');
      return new Response(sseBody, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: { model_id: model.id, messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res.statusCode).toBe(200);
    expect(fetchSpy).toHaveBeenCalled();
    const text = res.payload;
    expect(text).toContain('"Hello"');
    expect(text).toContain('" world"');
    // assistant message persisted with full content
    const meta = JSON.parse(text.split('\n').find((l) => l.startsWith('8:'))!.slice(2))[0];
    const msgs = new MessagesRepo(db).listByConversation(meta.conversation_id);
    const asst = msgs.find((m) => m.role === 'assistant')!;
    expect(asst.content).toBe('Hello world');
    expect(asst.status).toBe('complete');
    expect(asst.model_id).toBe(model.id);
  });

  it('upstream-path: records context_window before streaming to the provider', async () => {
    const provRepo = new ProvidersRepo(db);
    const modRepo = new ModelsRepo(db);
    const provider = provRepo.create({
      name: 'OpenRouter',
      type: 'openrouter',
      base_url: 'https://openrouter.example.com/api/v1',
      api_key: 'sk-test-context-window',
    });
    await keystore.write(provider.api_key_ref!, 'sk-test-context-window');
    const model = modRepo.create({
      provider_id: provider.id,
      model_name: 'tiny-real-path',
      capability: 'chat',
      display_name: 'Tiny Real Path',
      context_length: 900,
    });

    const sseBody =
      `data: ${JSON.stringify({ id: '1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }] })}\n\n` +
      `data: ${JSON.stringify({ id: '1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } })}\n\n` +
      `data: [DONE]\n\n`;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => (
      new Response(sseBody, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    ));

    const payloadMessages = Array.from({ length: 12 }, (_, index) => ({
      role: (index % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `history-${index} ${'长上下文'.repeat(80)}`,
    }));
    payloadMessages.push({
      role: 'user' as const,
      content: '请只回答 OK',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: { model_id: model.id, messages: payloadMessages },
    });
    expect(res.statusCode).toBe(200);
    expect(fetchSpy).toHaveBeenCalled();

    const meta = JSON.parse(res.payload.split('\n').find((l) => l.startsWith('8:'))!.slice(2))[0];
    const events = new RunEventsRepo(db).listByConversation(meta.conversation_id, 20);
    const snapshot = events.find((event) => event.kind === 'context.snapshot');
    expect(snapshot?.payload?.context_window).toMatchObject({
      strategy: 'sliding_window',
      model_context_length: 900,
    });
    const contextWindow = snapshot?.payload?.context_window as { omitted_message_count?: number } | undefined;
    expect(contextWindow?.omitted_message_count).toBeGreaterThan(0);
  });

  it('upstream-path: exposes refreshed MCP tools to ordinary chat and executes them', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taori-chat-mcp-'));
    try {
      const scriptPath = path.join(tmpDir, 'mock-mcp-server.mjs');
      fs.writeFileSync(scriptPath, mockMcpServerSource());

      const createMcp = await app.inject({
        method: 'POST',
        url: '/v1/mcp/servers',
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
        payload: JSON.stringify({
          name: 'Chat MCP',
          command: process.execPath,
          args: [scriptPath],
        }),
      });
      expect(createMcp.statusCode).toBe(201);
      const created = createMcp.json() as { server: { id: string } };

      const refreshMcp = await app.inject({
        method: 'POST',
        url: `/v1/mcp/servers/${created.server.id}/refresh`,
        headers: { authorization: `Bearer ${bearer}` },
      });
      expect(refreshMcp.statusCode).toBe(200);
      const refreshBody = refreshMcp.json() as { tools: Array<{ name: string }> };
      expect(refreshBody.tools[0]?.name).toMatch(/^mcp\./);

      const provRepo = new ProvidersRepo(db);
      const modRepo = new ModelsRepo(db);
      const provider = provRepo.create({
        name: 'OpenRouter',
        type: 'openrouter',
        base_url: 'https://openrouter.example.com/api/v1',
        api_key: 'sk-test-mcp',
      });
      await keystore.write(provider.api_key_ref!, 'sk-test-mcp');
      const model = modRepo.create({
        provider_id: provider.id,
        model_name: 'tool-chat',
        capability: 'chat',
        display_name: 'Tool Chat',
        supports_tools: true,
      });

      let chatCalls = 0;
      let mcpAiToolName = '';
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        chatCalls++;
        const rawBody = typeof init?.body === 'string' ? init.body : String(init?.body ?? '{}');
        const body = JSON.parse(rawBody) as { tools?: Array<{ function?: { name?: string } }> };
        if (chatCalls === 1) {
          const toolNames = body.tools?.map((t) => t.function?.name).filter(Boolean) ?? [];
          mcpAiToolName = toolNames.find((name) => String(name).startsWith(`mcp_${created.server.id}_`)) ?? '';
          expect(mcpAiToolName).toBeTruthy();
          const toolCallBody =
            `data: ${JSON.stringify({ id: '1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_mcp_1', type: 'function', function: { name: mcpAiToolName, arguments: '' } }] }, finish_reason: null }] })}\n\n` +
            `data: ${JSON.stringify({ id: '1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"text":"hello from chat"}' } }] }, finish_reason: null }] })}\n\n` +
            `data: ${JSON.stringify({ id: '1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } })}\n\n` +
            `data: [DONE]\n\n`;
          return new Response(toolCallBody, {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          });
        }
        const finalTextBody =
          `data: ${JSON.stringify({ id: '1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { role: 'assistant', content: 'mcp done' }, finish_reason: null }] })}\n\n` +
          `data: ${JSON.stringify({ id: '1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } })}\n\n` +
          `data: [DONE]\n\n`;
        return new Response(finalTextBody, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat',
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
        payload: {
          model_id: model.id,
          messages: [{ role: 'user', content: 'use my mcp echo tool' }],
        },
      });
      expect(res.statusCode).toBe(200);
      expect(fetchSpy).toHaveBeenCalled();
      expect(chatCalls).toBe(2);
      expect(res.payload).toContain('mcp done');
      expect(res.payload).toContain('"tool":"mcp.');
      expect(res.payload).toContain('echo:hello from chat');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('deepseek official tool loop preserves reasoning_content across tool roundtrips', async () => {
    const provRepo = new ProvidersRepo(db);
    const modRepo = new ModelsRepo(db);
    const provider = provRepo.create({
      name: 'DeepSeek',
      type: 'deepseek',
      base_url: 'https://api.deepseek.com',
      api_key: 'sk-deepseek-test',
    });
    await keystore.write(provider.api_key_ref!, 'sk-deepseek-test');
    const model = modRepo.create({
      provider_id: provider.id,
      model_name: 'deepseek-v4-flash',
      capability: 'chat',
      display_name: 'DeepSeek V4 Flash',
      supports_tools: true,
    });

    let callCount = 0;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      callCount++;
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        stream?: boolean;
        messages?: Array<Record<string, unknown>>;
        tools?: Array<{ function?: { name?: string } }>;
      };
      expect(String(_url)).toBe('https://api.deepseek.com/chat/completions');
      if (callCount === 1) {
        expect(body.stream).toBe(false);
        expect(body.tools?.some((tool) => tool.function?.name === 'web_search')).toBe(true);
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: null,
                  reasoning_content: 'Need current info before answering.',
                  tool_calls: [
                    {
                      id: 'call_web_1',
                      type: 'function',
                      function: {
                        name: 'web_search',
                        arguments: '{"query":"DeepSeek V4 Flash tool calling"}',
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
            usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (callCount === 2) {
        expect(body.stream).toBe(false);
        const assistantWithReasoning = body.messages?.find((message) =>
          message.role === 'assistant' && message.reasoning_content === 'Need current info before answering.',
        );
        expect(assistantWithReasoning).toBeTruthy();
        const toolResult = body.messages?.find((message) => message.role === 'tool');
        expect(toolResult).toBeTruthy();
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: 'According to the latest docs, it supports tool calls.',
                  reasoning_content: 'I have enough evidence now.',
                },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 18, completion_tokens: 6, total_tokens: 24 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`unexpected DeepSeek fetch call #${callCount}`);
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: {
        model_id: model.id,
        messages: [{ role: 'user', content: '查一下 DeepSeek V4 Flash 是否支持工具调用' }],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(res.payload).toContain('According to the latest docs, ');
    expect(res.payload).toContain('it supports tool calls.');
    expect(res.payload).toContain('"tool":"builtin.web_search"');
  });

  it('deepseek official tool loop allows multiple tool rounds before final answer', async () => {
    const provRepo = new ProvidersRepo(db);
    const modRepo = new ModelsRepo(db);
    const provider = provRepo.create({
      name: 'DeepSeek',
      type: 'deepseek',
      base_url: 'https://api.deepseek.com',
      api_key: 'sk-deepseek-test',
    });
    await keystore.write(provider.api_key_ref!, 'sk-deepseek-test');
    const model = modRepo.create({
      provider_id: provider.id,
      model_name: 'deepseek-v4-flash',
      capability: 'chat',
      display_name: 'DeepSeek V4 Flash',
      supports_tools: true,
    });

    let callCount = 0;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      callCount++;
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        stream?: boolean;
        messages?: Array<Record<string, unknown>>;
        tools?: Array<{ function?: { name?: string } }>;
      };
      expect(String(_url)).toBe('https://api.deepseek.com/chat/completions');
      expect(body.stream).toBe(false);
      if (callCount <= 3) {
        const priorToolMessages = body.messages?.filter((message) => message.role === 'tool') ?? [];
        expect(priorToolMessages).toHaveLength(callCount - 1);
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: null,
                  reasoning_content: `Round ${callCount} reasoning`,
                  tool_calls: [
                    {
                      id: `call_web_${callCount}`,
                      type: 'function',
                      function: {
                        name: 'web_search',
                        arguments: JSON.stringify({ query: `DeepSeek step ${callCount}` }),
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
            usage: { prompt_tokens: 10 + callCount, completion_tokens: 2, total_tokens: 12 + callCount },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      const allReasoningMessages = body.messages?.filter((message) => message.role === 'assistant') ?? [];
      expect(allReasoningMessages.some((message) => message.reasoning_content === 'Round 3 reasoning')).toBe(true);
      expect(body.messages?.filter((message) => message.role === 'tool')).toHaveLength(3);
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: 'Final answer after three searches.',
                reasoning_content: 'Enough evidence gathered.',
              },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 21, completion_tokens: 5, total_tokens: 26 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: {
        model_id: model.id,
        messages: [{ role: 'user', content: '多搜几次再回答' }],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    expect(res.payload).toContain('Final answer after three searches.');
    expect(res.payload).toContain('"tool":"builtin.web_search"');
  }, 15000);

  it('deepseek official tool loop finalizes with tool_choice none after repeated tool rounds', async () => {
    const provRepo = new ProvidersRepo(db);
    const modRepo = new ModelsRepo(db);
    const provider = provRepo.create({
      name: 'DeepSeek',
      type: 'deepseek',
      base_url: 'https://api.deepseek.com',
      api_key: 'sk-deepseek-test',
    });
    await keystore.write(provider.api_key_ref!, 'sk-deepseek-test');
    const model = modRepo.create({
      provider_id: provider.id,
      model_name: 'deepseek-v4-flash',
      capability: 'chat',
      display_name: 'DeepSeek V4 Flash',
      supports_tools: true,
    });

    let callCount = 0;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      callCount++;
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        stream?: boolean;
        messages?: Array<Record<string, unknown>>;
        tools?: Array<{ function?: { name?: string } }>;
        tool_choice?: string;
        thinking?: { type?: string };
      };
      expect(String(_url)).toBe('https://api.deepseek.com/chat/completions');
      expect(body.stream).toBe(false);
      if (callCount <= 8) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: null,
                  reasoning_content: `Round ${callCount} reasoning`,
                  tool_calls: [
                    {
                      id: `call_web_${callCount}`,
                      type: 'function',
                      function: {
                        name: 'web_search',
                        arguments: JSON.stringify({ query: `DeepSeek step ${callCount}` }),
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
            usage: { prompt_tokens: 10 + callCount, completion_tokens: 2, total_tokens: 12 + callCount },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      expect(body.tool_choice).toBe('none');
      expect(body).not.toHaveProperty('thinking');
      const lastMessage = body.messages?.at(-1);
      expect(lastMessage?.role).toBe('system');
      expect(String(lastMessage?.content ?? '')).toContain('Do not call any more tools');
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: 'Final answer from finalize request.',
              },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 30, completion_tokens: 4, total_tokens: 34 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: {
        model_id: model.id,
        messages: [{ role: 'user', content: '先多次搜索，再收口作答' }],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(9);
    expect(res.payload).toContain('Final answer from finalize request.');
  }, 20000);

  it('upstream-path: classifies upstream error and persists assistant as failed', async () => {
    const provRepo = new ProvidersRepo(db);
    const modRepo = new ModelsRepo(db);
    const provider = provRepo.create({
      name: 'OR',
      type: 'openrouter',
      base_url: 'https://openrouter.example.com/api/v1',
      api_key: 'sk-bad',
    });
    await keystore.write(provider.api_key_ref!, 'sk-bad');
    const model = modRepo.create({
      provider_id: provider.id,
      model_name: 'meta/llama',
      capability: 'chat',
      display_name: 'Llama',
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'invalid key' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: { model_id: model.id, messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res.statusCode).toBe(200);
    const lines = res.payload.split('\n').filter(Boolean);
    // either an error line `3:` or a finish-reason error in `d:`
    expect(lines.some((l) => l.startsWith('3:') || /finishReason":"error"/.test(l))).toBe(true);
    // Assistant row should be marked failed (or incomplete if abort timing)
    const meta = JSON.parse(lines.find((l) => l.startsWith('8:'))!.slice(2))[0];
    const msgs = new MessagesRepo(db).listByConversation(meta.conversation_id);
    const asst = msgs.find((m) => m.role === 'assistant')!;
    expect(['failed', 'complete']).toContain(asst.status);
  });

  it('upstream-path: treats zero-text completion as failed instead of silent success', async () => {
    const provRepo = new ProvidersRepo(db);
    const modRepo = new ModelsRepo(db);
    const provider = provRepo.create({
      name: 'OR',
      type: 'openrouter',
      base_url: 'https://openrouter.example.com/api/v1',
      api_key: 'sk-empty',
    });
    await keystore.write(provider.api_key_ref!, 'sk-empty');
    const model = modRepo.create({
      provider_id: provider.id,
      model_name: 'empty-stream',
      capability: 'chat',
      display_name: 'Empty Stream',
    });

    const sseBody =
      `data: ${JSON.stringify({ id: '1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n` +
      `data: ${JSON.stringify({ id: '1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 } })}\n\n` +
      `data: [DONE]\n\n`;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(sseBody, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: { model_id: model.id, messages: [{ role: 'user', content: 'hello' }] },
    });
    expect(res.statusCode).toBe(200);
    const lines = res.payload.split('\n').filter(Boolean);
    expect(lines.some((line) => line.includes('provider_error/unknown: 模型本次调用已完成，但没有返回任何可显示文本。请重试，或切换到另一模型继续。'))).toBe(true);
    expect(lines.some((line) => /finishReason":"error"/.test(line))).toBe(true);

    const meta = JSON.parse(lines.find((line) => line.startsWith('8:'))!.slice(2))[0];
    const msgs = new MessagesRepo(db).listByConversation(meta.conversation_id);
    const asst = msgs.find((m) => m.role === 'assistant')!;
    expect(asst.status).toBe('failed');
    expect(asst.error).toContain('没有返回任何可显示文本');
  });

  it('rejects image attachment for non-vision model with validation_error', async () => {
    const provRepo = new ProvidersRepo(db);
    const modRepo = new ModelsRepo(db);
    const provider = provRepo.create({
      name: 'OR',
      type: 'openrouter',
      base_url: 'https://openrouter.example.com/api/v1',
    });
    const model = modRepo.create({
      provider_id: provider.id,
      model_name: 'text-only',
      capability: 'chat',
      display_name: 'Text-only',
      supports_vision: false,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: {
        model_id: model.id,
        messages: [{ role: 'user', content: 'describe this' }],
        attachments: [{ kind: 'image', mime: 'image/png', data_b64: 'iVBOR' }],
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { code: string; message: string };
    expect(body.code).toBe('validation_error');
    expect(body.message).toMatch(/视觉|vision/);
  });

  it('accepts image attachment for vision-capable model and persists it on user row', async () => {
    const provRepo = new ProvidersRepo(db);
    const modRepo = new ModelsRepo(db);
    const provider = provRepo.create({
      name: 'OR',
      type: 'openrouter',
      base_url: 'https://openrouter.example.com/api/v1',
    });
    const model = modRepo.create({
      provider_id: provider.id,
      model_name: 'vision',
      capability: 'chat',
      display_name: 'Vision',
      supports_vision: true,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: {
        model_id: model.id,
        messages: [{ role: 'user', content: 'see this' }],
        attachments: [{ kind: 'image', mime: 'image/png', data_b64: 'iVBORw0K', name: 'a.png' }],
      },
    });
    expect(res.statusCode).toBe(200);
    const meta = JSON.parse(res.payload.split('\n').find((l) => l.startsWith('8:'))!.slice(2))[0];
    const msgs = new MessagesRepo(db).listByConversation(meta.conversation_id);
    const userRow = msgs.find((m) => m.role === 'user')!;
    expect(userRow.attachments).toBeTruthy();
    const parsed = JSON.parse(userRow.attachments!);
    expect(parsed[0].kind).toBe('image');
    expect(parsed[0].name).toBe('a.png');
  });

  it('accepts generated-image sized vision attachments instead of failing at the HTTP parser', async () => {
    const provRepo = new ProvidersRepo(db);
    const modRepo = new ModelsRepo(db);
    const provider = provRepo.create({
      name: 'OR',
      type: 'openrouter',
      base_url: 'https://openrouter.example.com/api/v1',
    });
    const model = modRepo.create({
      provider_id: provider.id,
      model_name: 'vision-large',
      capability: 'multimodal',
      display_name: 'Vision Large',
      supports_vision: true,
    });
    const largeB64 = 'a'.repeat(1_500_000);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        model_id: model.id,
        messages: [{ role: 'user', content: '请理解这张图片' }],
        attachments: [{ kind: 'image', mime: 'image/png', data_b64: largeB64, name: 'generated.png' }],
      }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('"message_id":"msg_');
    expect(res.payload).not.toContain('"code":"internal"');
  });
});

function mockMcpServerSource(): string {
  return `
let buffer = Buffer.alloc(0);
function send(id, result) {
  const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result }), 'utf8');
  process.stdout.write('Content-Length: ' + payload.byteLength + '\\r\\n\\r\\n');
  process.stdout.write(payload);
}
function handle(message) {
  if (!message.id) return;
  if (message.method === 'initialize') {
    send(message.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'mock', version: '1' } });
  } else if (message.method === 'tools/list') {
    send(message.id, {
      tools: [{
        name: 'echo',
        description: 'Echo text',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string', minLength: 1 } },
          required: ['text'],
          additionalProperties: false
        }
      }]
    });
  } else if (message.method === 'tools/call') {
    send(message.id, { content: [{ type: 'text', text: 'echo:' + (message.params?.arguments?.text ?? '') }] });
  }
}
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const sep = buffer.indexOf('\\r\\n\\r\\n');
    if (sep < 0) return;
    const header = buffer.slice(0, sep).toString('utf8');
    const match = /content-length:\\s*(\\d+)/i.exec(header);
    if (!match) return;
    const len = Number(match[1]);
    const start = sep + 4;
    const end = start + len;
    if (buffer.byteLength < end) return;
    const payload = buffer.slice(start, end).toString('utf8');
    buffer = buffer.slice(end);
    handle(JSON.parse(payload));
  }
});
`;
}
