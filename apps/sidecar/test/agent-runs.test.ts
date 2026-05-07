import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { buildServer } from '../src/server.js';
import { openDb } from '../src/db/index.js';
import { ControlClient } from '../src/control/client.js';
import { MemoryStore } from '../src/keystore.js';
import { CapabilityBus } from '../src/bus/index.js';
import {
  ConversationsRepo,
  CostsRepo,
  MessagesRepo,
  ModelsRepo,
  ProvidersRepo,
  RunEventsRepo,
  MemoriesRepo,
} from '../src/db/repos/index.js';
import type { FastifyInstance } from 'fastify';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const bearer = 'test_bearer_agent_runs';
const auth = { authorization: `Bearer ${bearer}` };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function newApp() {
  const dbPath = path.join(os.tmpdir(), `taori-agent-runs-${Date.now()}-${Math.random()}.db`);
  const db = openDb(dbPath);
  const bus = new CapabilityBus(new CostsRepo(db));
  bus.register({
    name: 'mcp.test.evidence',
    description: 'Test Evidence MCP',
    capability: 'mcp',
    source: 'mcp',
    source_id: 'test',
    enabled: true,
    inputSchema: z.object({}),
    async execute() {
      return { output: { ok: true } };
    },
  });
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
    keystore: new MemoryStore(),
    startedAt: Date.now(),
    bus,
  });
  return { app, db, dbPath };
}

describe('Agent runs derived from run_events', () => {
  let app: FastifyInstance;
  let db: ReturnType<typeof openDb>;
  let dbPath: string;
  let convs: ConversationsRepo;
  let messages: MessagesRepo;
  let runEvents: RunEventsRepo;

  beforeEach(async () => {
    ({ app, db, dbPath } = newApp());
    convs = new ConversationsRepo(db);
    messages = new MessagesRepo(db);
    runEvents = new RunEventsRepo(db);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    fs.rmSync(dbPath, { force: true });
  });

  it('derives completed, failed and incomplete run headers from append-only events', async () => {
    const conv = convs.create({ type: 'chat', title: 'Agent run derivation' });
    const user = messages.insert({
      conversation_id: conv.id,
      role: 'user',
      content: 'start',
      status: 'complete',
    });
    const completedAssistant = messages.insert({
      conversation_id: conv.id,
      role: 'assistant',
      content: 'done',
      status: 'complete',
    });
    const failedAssistant = messages.insert({
      conversation_id: conv.id,
      role: 'assistant',
      content: '',
      status: 'failed',
    });
    const incompleteAssistant = messages.insert({
      conversation_id: conv.id,
      role: 'assistant',
      content: 'partial',
      status: 'incomplete',
    });

    runEvents.append({
      run_id: 'run_completed',
      conversation_id: conv.id,
      message_id: completedAssistant.id,
      kind: 'turn.started',
      status: 'started',
      label: '用户回合开始',
      payload: {
        run_kind: 'chat',
        source_user_message_id: user.id,
        model_id: 'mdl_fast',
      },
    });
    await sleep(2);
    runEvents.append({
      run_id: 'run_completed',
      conversation_id: conv.id,
      message_id: completedAssistant.id,
      kind: 'context.snapshot',
      status: 'completed',
      label: '上下文快照',
    });
    await sleep(2);
    runEvents.append({
      run_id: 'run_completed',
      conversation_id: conv.id,
      message_id: completedAssistant.id,
      kind: 'turn.completed',
      status: 'completed',
      label: '用户回合完成',
      payload: { assistant_message_id: completedAssistant.id, message_status: 'complete' },
    });
    await sleep(2);

    runEvents.append({
      run_id: 'run_failed',
      conversation_id: conv.id,
      message_id: failedAssistant.id,
      kind: 'turn.started',
      status: 'started',
      label: '用户回合开始',
      payload: {
        run_kind: 'retry',
        parent_run_id: 'run_completed',
        source_user_message_id: user.id,
        model_id: 'mdl_retry',
        recovery_policy: 'retry_same_model',
      },
    });
    await sleep(2);
    runEvents.append({
      run_id: 'run_failed',
      conversation_id: conv.id,
      message_id: failedAssistant.id,
      kind: 'model.failed',
      status: 'failed',
      label: '模型调用失败',
      payload: { model_id: 'mdl_retry', classification: 'rate_limit' },
    });
    await sleep(2);
    runEvents.append({
      run_id: 'run_failed',
      conversation_id: conv.id,
      message_id: failedAssistant.id,
      kind: 'turn.failed',
      status: 'failed',
      label: '用户回合失败',
      payload: { assistant_message_id: failedAssistant.id },
    });
    await sleep(2);

    runEvents.append({
      run_id: 'run_incomplete',
      conversation_id: conv.id,
      message_id: incompleteAssistant.id,
      kind: 'turn.started',
      status: 'started',
      label: '用户回合开始',
      payload: {
        run_kind: 'continue',
        parent_run_id: 'run_failed',
        source_user_message_id: user.id,
        model_id: 'mdl_slow',
      },
    });
    await sleep(2);
    runEvents.append({
      run_id: 'run_incomplete',
      conversation_id: conv.id,
      message_id: incompleteAssistant.id,
      kind: 'turn.cancelled',
      status: 'cancelled',
      label: '用户回合已停止',
      payload: {
        assistant_message_id: incompleteAssistant.id,
        message_status: 'incomplete',
      },
    });

    const runs = runEvents.listRunsByConversation(conv.id);
    expect(runs.map((run) => run.id)).toEqual([
      'run_incomplete',
      'run_failed',
      'run_completed',
    ]);
    expect(runs[0]).toMatchObject({
      id: 'run_incomplete',
      kind: 'continue',
      status: 'incomplete',
      parent_run_id: 'run_failed',
      assistant_message_id: incompleteAssistant.id,
      model_id: 'mdl_slow',
    });
    expect(runs[1]).toMatchObject({
      id: 'run_failed',
      kind: 'retry',
      status: 'failed',
      parent_run_id: 'run_completed',
      recovery_policy: 'retry_same_model',
      model_id: 'mdl_retry',
    });
    expect(runs[2]).toMatchObject({
      id: 'run_completed',
      kind: 'chat',
      status: 'completed',
      user_message_id: user.id,
      assistant_message_id: completedAssistant.id,
      model_id: 'mdl_fast',
      event_count: 3,
    });

    const routeRes = await app.inject({
      method: 'GET',
      url: `/v1/conversations/${conv.id}/runs?limit=2`,
      headers: auth,
    });
    expect(routeRes.statusCode).toBe(200);
    const body = routeRes.json() as {
      data: { runs: Array<{ id: string; status: string }> };
    };
    expect(body.data.runs).toEqual([
      expect.objectContaining({ id: 'run_incomplete', status: 'incomplete' }),
      expect.objectContaining({ id: 'run_failed', status: 'failed' }),
    ]);
  });

  it('materializes agent_runs headers as events are appended', async () => {
    const conv = convs.create({ type: 'chat', title: 'Materialized runs' });
    const user = messages.insert({
      conversation_id: conv.id,
      role: 'user',
      content: 'start',
      status: 'complete',
    });
    const assistant = messages.insert({
      conversation_id: conv.id,
      role: 'assistant',
      content: '',
      status: 'streaming',
    });

    runEvents.append({
      run_id: 'run_header',
      conversation_id: conv.id,
      message_id: assistant.id,
      kind: 'turn.started',
      status: 'started',
      label: '用户回合开始',
      payload: {
        run_kind: 'chat',
        source_user_message_id: user.id,
        model_id: 'mdl_header',
      },
    });
    let runs = runEvents.listRunsByConversation(conv.id);
    expect(runs[0]).toMatchObject({
      id: 'run_header',
      status: 'created',
      event_count: 1,
      user_message_id: user.id,
    });

    await sleep(2);
    runEvents.append({
      run_id: 'run_header',
      conversation_id: conv.id,
      message_id: assistant.id,
      kind: 'model.started',
      status: 'started',
      label: '模型调用开始',
      payload: { model_id: 'mdl_header' },
    });
    await sleep(2);
    runEvents.append({
      run_id: 'run_header',
      conversation_id: conv.id,
      message_id: assistant.id,
      kind: 'turn.completed',
      status: 'completed',
      label: '用户回合完成',
      payload: { assistant_message_id: assistant.id },
    });

    runs = runEvents.listRunsByConversation(conv.id);
    expect(runs[0]).toMatchObject({
      id: 'run_header',
      status: 'completed',
      event_count: 3,
      assistant_message_id: assistant.id,
      model_id: 'mdl_header',
    });
  });

  it('GET /v1/runs/:id/resume-state reports incomplete runs as continuable', async () => {
    const provider = new ProvidersRepo(db).create({
      name: 'Mock Provider',
      type: 'custom',
      base_url: 'https://mock.example.com/v1',
    });
    const model = new ModelsRepo(db).create({
      provider_id: provider.id,
      model_name: 'mock-chat',
      capability: 'chat',
      display_name: 'Mock Chat',
    });
    const conv = convs.create({ type: 'chat', title: 'Resume state' });
    const user = messages.insert({
      conversation_id: conv.id,
      role: 'user',
      content: 'write a long answer',
      status: 'complete',
    });
    const partial = messages.insert({
      conversation_id: conv.id,
      role: 'assistant',
      content: 'partial answer',
      model_id: model.id,
      status: 'incomplete',
    });
    runEvents.append({
      run_id: 'run_resume_state',
      conversation_id: conv.id,
      message_id: partial.id,
      kind: 'turn.started',
      status: 'started',
      label: '用户回合开始',
      payload: {
        source_user_message_id: user.id,
        model_id: model.id,
      },
    });
    await sleep(2);
    runEvents.append({
      run_id: 'run_resume_state',
      conversation_id: conv.id,
      message_id: partial.id,
      kind: 'turn.cancelled',
      status: 'cancelled',
      label: '用户回合已停止',
      payload: {
        assistant_message_id: partial.id,
        message_status: 'incomplete',
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/runs/run_resume_state/resume-state',
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      data: {
        run_id: 'run_resume_state',
        conversation_id: conv.id,
        assistant_message_id: partial.id,
        message_status: 'incomplete',
        can_continue: true,
        recommended_action: 'continue',
        reason: null,
      },
    });
  });

  it('GET /v1/conversations/:id/runs returns 404 for missing conversations', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/conversations/conv_missing/runs',
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('not_found');
  });

  it('POST /v1/runs/:id/continue creates a child run without inserting a user message', async () => {
    const provider = new ProvidersRepo(db).create({
      name: 'Mock Provider',
      type: 'custom',
      base_url: 'https://mock.example.com/v1',
    });
    const model = new ModelsRepo(db).create({
      provider_id: provider.id,
      model_name: 'mock-chat',
      capability: 'chat',
      display_name: 'Mock Chat',
    });
    const conv = convs.create({ type: 'chat', title: 'Continue run' });
    const user = messages.insert({
      conversation_id: conv.id,
      role: 'user',
      content: 'write a long answer',
      status: 'complete',
    });
    const partial = messages.insert({
      conversation_id: conv.id,
      role: 'assistant',
      content: 'partial answer',
      model_id: model.id,
      status: 'incomplete',
    });
    runEvents.append({
      run_id: 'run_original_incomplete',
      conversation_id: conv.id,
      message_id: partial.id,
      kind: 'turn.started',
      status: 'started',
      label: '用户回合开始',
      payload: {
        run_kind: 'chat',
        source_user_message_id: user.id,
        model_id: model.id,
      },
    });
    await sleep(2);
    runEvents.append({
      run_id: 'run_original_incomplete',
      conversation_id: conv.id,
      message_id: partial.id,
      kind: 'turn.cancelled',
      status: 'cancelled',
      label: '用户回合已停止',
      payload: {
        assistant_message_id: partial.id,
        message_status: 'incomplete',
      },
    });

    const before = messages.listByConversation(conv.id);
    expect(before.filter((row) => row.role === 'user')).toHaveLength(1);
    expect(before.filter((row) => row.role === 'assistant')).toHaveLength(1);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/runs/run_original_incomplete/continue',
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('"type":"meta"');
    expect(res.payload).toContain('"run_id"');

    const after = messages.listByConversation(conv.id);
    expect(after.filter((row) => row.role === 'user')).toHaveLength(1);
    const assistants = after.filter((row) => row.role === 'assistant');
    expect(assistants).toHaveLength(2);
    expect(assistants[1]).toMatchObject({
      status: 'complete',
      model_id: model.id,
      parent_message_id: partial.id,
    });

    const runs = runEvents.listRunsByConversation(conv.id, 5);
    expect(runs[0]).toMatchObject({
      kind: 'continue',
      status: 'completed',
      parent_run_id: 'run_original_incomplete',
      user_message_id: user.id,
      assistant_message_id: assistants[1]!.id,
      model_id: model.id,
    });
  });

  it('POST /v1/runs/:id/continue requires confirmation before high-cost recovery', async () => {
    const provider = new ProvidersRepo(db).create({
      name: 'Mock Provider',
      type: 'custom',
      base_url: 'https://mock.example.com/v1',
    });
    const model = new ModelsRepo(db).create({
      provider_id: provider.id,
      model_name: 'expensive-continue-chat',
      capability: 'chat',
      display_name: 'Expensive Continue Chat',
      price_input_per_1m: 100,
      price_output_per_1m: 100,
    });
    const conv = convs.create({ type: 'chat', title: 'Continue cost gate' });
    new MemoriesRepo(db).set('global', null, 'cost_confirm_threshold_usd', '0.000001');
    const user = messages.insert({
      conversation_id: conv.id,
      role: 'user',
      content: 'write a high cost answer',
      status: 'complete',
    });
    const partial = messages.insert({
      conversation_id: conv.id,
      role: 'assistant',
      content: 'partial answer',
      model_id: model.id,
      status: 'incomplete',
    });
    runEvents.append({
      run_id: 'run_cost_continue_original',
      conversation_id: conv.id,
      message_id: partial.id,
      kind: 'turn.started',
      status: 'started',
      label: '用户回合开始',
      payload: {
        run_kind: 'chat',
        source_user_message_id: user.id,
        model_id: model.id,
        assistant_message_id: partial.id,
      },
    });
    runEvents.append({
      run_id: 'run_cost_continue_original',
      conversation_id: conv.id,
      message_id: partial.id,
      kind: 'turn.cancelled',
      status: 'cancelled',
      label: '用户回合已停止',
      payload: { assistant_message_id: partial.id, message_status: 'incomplete' },
    });

    const blocked = await app.inject({
      method: 'POST',
      url: '/v1/runs/run_cost_continue_original/continue',
      headers: auth,
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({
      code: 'cost_confirmation_required',
      details: {
        reason: 'threshold',
        model_id: model.id,
        conversation_id: conv.id,
      },
    });
    expect(messages.listByConversation(conv.id).filter((row) => row.role === 'assistant')).toHaveLength(1);

    const confirmed = await app.inject({
      method: 'POST',
      url: '/v1/runs/run_cost_continue_original/continue',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { confirmed_cost: true },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(messages.listByConversation(conv.id).filter((row) => row.role === 'assistant')).toHaveLength(2);
  });

  it('POST /v1/runs/:id/recover retries a failed run without inserting a user message', async () => {
    const provider = new ProvidersRepo(db).create({
      name: 'Mock Provider',
      type: 'custom',
      base_url: 'https://mock.example.com/v1',
    });
    const model = new ModelsRepo(db).create({
      provider_id: provider.id,
      model_name: 'mock-chat',
      capability: 'chat',
      display_name: 'Mock Chat',
    });
    const conv = convs.create({ type: 'chat', title: 'Recover run' });
    const user = messages.insert({
      conversation_id: conv.id,
      role: 'user',
      content: 'please recover this failed turn',
      status: 'complete',
    });
    const failed = messages.insert({
      conversation_id: conv.id,
      role: 'assistant',
      content: '',
      model_id: model.id,
      status: 'failed',
    });
    runEvents.append({
      run_id: 'run_original_failed',
      conversation_id: conv.id,
      message_id: failed.id,
      kind: 'turn.started',
      status: 'started',
      label: '用户回合开始',
      payload: {
        run_kind: 'chat',
        source_user_message_id: user.id,
        model_id: model.id,
        assistant_message_id: failed.id,
      },
    });
    await sleep(2);
    runEvents.append({
      run_id: 'run_original_failed',
      conversation_id: conv.id,
      message_id: failed.id,
      kind: 'model.failed',
      status: 'failed',
      label: '模型调用失败',
      payload: { model_id: model.id, classification: 'rate_limit' },
    });
    await sleep(2);
    runEvents.append({
      run_id: 'run_original_failed',
      conversation_id: conv.id,
      message_id: failed.id,
      kind: 'turn.failed',
      status: 'failed',
      label: '用户回合失败',
      payload: { assistant_message_id: failed.id },
    });

    const before = messages.listByConversation(conv.id);
    expect(before.filter((row) => row.role === 'user')).toHaveLength(1);
    expect(before.filter((row) => row.role === 'assistant')).toHaveLength(1);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/runs/run_original_failed/recover',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { action: 'retry_same_model' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('"type":"meta"');

    const after = messages.listByConversation(conv.id);
    expect(after.filter((row) => row.role === 'user')).toHaveLength(1);
    const assistants = after.filter((row) => row.role === 'assistant');
    expect(assistants).toHaveLength(2);
    expect(assistants[1]).toMatchObject({
      status: 'complete',
      model_id: model.id,
      parent_message_id: failed.id,
    });

    const runs = runEvents.listRunsByConversation(conv.id, 5);
    expect(runs[0]).toMatchObject({
      kind: 'retry',
      status: 'completed',
      parent_run_id: 'run_original_failed',
      recovery_policy: 'retry_same_model',
      user_message_id: user.id,
      assistant_message_id: assistants[1]!.id,
      model_id: model.id,
    });
    const childEvents = runEvents.listByRun(runs[0]!.id);
    expect(childEvents.map((event) => event.kind)).toContain('recovery.started');
    expect(childEvents.map((event) => event.kind)).toContain('recovery.completed');
  });

  it('POST /v1/runs/:id/recover requires confirmation before high-cost retry', async () => {
    const provider = new ProvidersRepo(db).create({
      name: 'Mock Provider',
      type: 'custom',
      base_url: 'https://mock.example.com/v1',
    });
    const model = new ModelsRepo(db).create({
      provider_id: provider.id,
      model_name: 'expensive-retry-chat',
      capability: 'chat',
      display_name: 'Expensive Retry Chat',
      price_input_per_1m: 100,
      price_output_per_1m: 100,
    });
    const conv = convs.create({ type: 'chat', title: 'Recover cost gate' });
    new MemoriesRepo(db).set('global', null, 'cost_confirm_threshold_usd', '0.000001');
    const user = messages.insert({
      conversation_id: conv.id,
      role: 'user',
      content: 'please retry high cost',
      status: 'complete',
    });
    const failed = messages.insert({
      conversation_id: conv.id,
      role: 'assistant',
      content: '',
      model_id: model.id,
      status: 'failed',
    });
    runEvents.append({
      run_id: 'run_cost_recover_original',
      conversation_id: conv.id,
      message_id: failed.id,
      kind: 'turn.started',
      status: 'started',
      label: '用户回合开始',
      payload: {
        run_kind: 'chat',
        source_user_message_id: user.id,
        model_id: model.id,
        assistant_message_id: failed.id,
      },
    });
    runEvents.append({
      run_id: 'run_cost_recover_original',
      conversation_id: conv.id,
      message_id: failed.id,
      kind: 'turn.failed',
      status: 'failed',
      label: '用户回合失败',
      payload: { assistant_message_id: failed.id, classification: 'rate_limit' },
    });

    const blocked = await app.inject({
      method: 'POST',
      url: '/v1/runs/run_cost_recover_original/recover',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { action: 'retry_same_model' },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({
      code: 'cost_confirmation_required',
      details: {
        reason: 'threshold',
        model_id: model.id,
        conversation_id: conv.id,
      },
    });
    expect(messages.listByConversation(conv.id).filter((row) => row.role === 'assistant')).toHaveLength(1);

    const confirmed = await app.inject({
      method: 'POST',
      url: '/v1/runs/run_cost_recover_original/recover',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { action: 'retry_same_model', confirmed_cost: true },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(messages.listByConversation(conv.id).filter((row) => row.role === 'assistant')).toHaveLength(2);
    const runs = runEvents.listRunsByConversation(conv.id, 5);
    expect(runs[0]).toMatchObject({
      kind: 'retry',
      status: 'completed',
      parent_run_id: 'run_cost_recover_original',
      recovery_policy: 'retry_same_model',
    });
  });

  it('POST /v1/runs/:id/recover switch_model requires confirmation for the target model', async () => {
    const provider = new ProvidersRepo(db).create({
      name: 'Mock Provider',
      type: 'custom',
      base_url: 'https://mock.example.com/v1',
    });
    const originalModel = new ModelsRepo(db).create({
      provider_id: provider.id,
      model_name: 'cheap-original-chat',
      capability: 'chat',
      display_name: 'Cheap Original Chat',
    });
    const targetModel = new ModelsRepo(db).create({
      provider_id: provider.id,
      model_name: 'expensive-switch-chat',
      capability: 'chat',
      display_name: 'Expensive Switch Chat',
      price_input_per_1m: 100,
      price_output_per_1m: 100,
    });
    const conv = convs.create({ type: 'chat', title: 'Switch cost gate' });
    new MemoriesRepo(db).set('global', null, 'cost_confirm_threshold_usd', '0.000001');
    const user = messages.insert({
      conversation_id: conv.id,
      role: 'user',
      content: 'please switch model after this failure',
      status: 'complete',
    });
    const failed = messages.insert({
      conversation_id: conv.id,
      role: 'assistant',
      content: '',
      model_id: originalModel.id,
      status: 'failed',
    });
    runEvents.append({
      run_id: 'run_cost_switch_original',
      conversation_id: conv.id,
      message_id: failed.id,
      kind: 'turn.started',
      status: 'started',
      label: '用户回合开始',
      payload: {
        run_kind: 'chat',
        source_user_message_id: user.id,
        model_id: originalModel.id,
        assistant_message_id: failed.id,
      },
    });
    runEvents.append({
      run_id: 'run_cost_switch_original',
      conversation_id: conv.id,
      message_id: failed.id,
      kind: 'turn.failed',
      status: 'failed',
      label: '用户回合失败',
      payload: { assistant_message_id: failed.id, classification: 'rate_limit' },
    });

    const blocked = await app.inject({
      method: 'POST',
      url: '/v1/runs/run_cost_switch_original/recover',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { action: 'switch_model', model_id: targetModel.id },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({
      code: 'cost_confirmation_required',
      details: {
        reason: 'threshold',
        model_id: targetModel.id,
        conversation_id: conv.id,
      },
    });
    expect(messages.listByConversation(conv.id).filter((row) => row.role === 'assistant')).toHaveLength(1);

    const confirmed = await app.inject({
      method: 'POST',
      url: '/v1/runs/run_cost_switch_original/recover',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { action: 'switch_model', model_id: targetModel.id, confirmed_cost: true },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(messages.listByConversation(conv.id).filter((row) => row.role === 'assistant')).toHaveLength(2);
    const runs = runEvents.listRunsByConversation(conv.id, 5);
    expect(runs[0]).toMatchObject({
      kind: 'retry',
      status: 'completed',
      parent_run_id: 'run_cost_switch_original',
      recovery_policy: 'switch_model',
      model_id: targetModel.id,
    });
  });

  it('POST /v1/runs/:id/recover compact_context requires confirmation before compact retry', async () => {
    const provider = new ProvidersRepo(db).create({
      name: 'Mock Provider',
      type: 'custom',
      base_url: 'https://mock.example.com/v1',
    });
    const model = new ModelsRepo(db).create({
      provider_id: provider.id,
      model_name: 'expensive-compact-chat',
      capability: 'chat',
      display_name: 'Expensive Compact Chat',
      price_input_per_1m: 100,
      price_output_per_1m: 100,
    });
    const conv = convs.create({ type: 'chat', title: 'Compact cost gate' });
    new MemoriesRepo(db).set('global', null, 'cost_confirm_threshold_usd', '0.000001');
    for (let i = 0; i < 4; i++) {
      messages.insert({
        conversation_id: conv.id,
        role: 'user',
        content: `old compact question ${i} ${'上下文'.repeat(80)}`,
        status: 'complete',
      });
      messages.insert({
        conversation_id: conv.id,
        role: 'assistant',
        content: `old compact answer ${i} ${'回答'.repeat(80)}`,
        model_id: model.id,
        status: 'complete',
      });
    }
    const sourceUser = messages.insert({
      conversation_id: conv.id,
      role: 'user',
      content: 'please compact and recover the failed answer',
      status: 'complete',
    });
    const failed = messages.insert({
      conversation_id: conv.id,
      role: 'assistant',
      content: '',
      model_id: model.id,
      status: 'failed',
    });
    runEvents.append({
      run_id: 'run_cost_compact_original',
      conversation_id: conv.id,
      message_id: failed.id,
      kind: 'turn.started',
      status: 'started',
      label: '用户回合开始',
      payload: {
        run_kind: 'chat',
        source_user_message_id: sourceUser.id,
        model_id: model.id,
        assistant_message_id: failed.id,
      },
    });
    runEvents.append({
      run_id: 'run_cost_compact_original',
      conversation_id: conv.id,
      message_id: failed.id,
      kind: 'turn.failed',
      status: 'failed',
      label: '用户回合失败',
      payload: { assistant_message_id: failed.id, classification: 'unknown' },
    });

    const blocked = await app.inject({
      method: 'POST',
      url: '/v1/runs/run_cost_compact_original/recover',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { action: 'compact_context' },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({
      code: 'cost_confirmation_required',
      details: {
        reason: 'threshold',
        model_id: model.id,
        conversation_id: conv.id,
      },
    });
    const before = messages.listByConversation(conv.id);
    expect(before.filter((row) => row.role === 'assistant' && row.status === 'streaming')).toHaveLength(0);

    const confirmed = await app.inject({
      method: 'POST',
      url: '/v1/runs/run_cost_compact_original/recover',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { action: 'compact_context', confirmed_cost: true },
    });
    expect(confirmed.statusCode).toBe(200);
    const runs = runEvents.listRunsByConversation(conv.id, 5);
    expect(runs[0]).toMatchObject({
      kind: 'retry',
      status: 'completed',
      parent_run_id: 'run_cost_compact_original',
      recovery_policy: 'compact_context',
      model_id: model.id,
    });
    const started = runEvents.listByRun(runs[0]!.id).find((event) => event.kind === 'recovery.started');
    expect(started?.payload).toMatchObject({
      action: 'compact_context',
      compacted_message_count: 8,
    });
  });

  it('POST /v1/runs/:id/recover skip_tool requires confirmation when monthly budget is reached', async () => {
    const provider = new ProvidersRepo(db).create({
      name: 'Mock Provider',
      type: 'custom',
      base_url: 'https://mock.example.com/v1',
    });
    const model = new ModelsRepo(db).create({
      provider_id: provider.id,
      model_name: 'budget-skip-tool-chat',
      capability: 'chat',
      display_name: 'Budget Skip Tool Chat',
      supports_tools: true,
    });
    const conv = convs.create({ type: 'chat', title: 'Skip tool budget gate' });
    const memories = new MemoriesRepo(db);
    memories.set('global', null, 'monthly_budget_usd', '0.01');
    new CostsRepo(db).insert({
      conversation_id: conv.id,
      source_type: 'message',
      source_id: null,
      feature: 'chat',
      model_id: model.id,
      model_name_snapshot: model.model_name,
      input_tokens: 1,
      output_tokens: 1,
      price_input_per_1m_snapshot: null,
      price_output_per_1m_snapshot: null,
      price_per_call_snapshot: null,
      estimated_cost_usd: 0.02,
      actual_cost_usd: 0.02,
      success: true,
      duration_ms: 1,
    });
    const user = messages.insert({
      conversation_id: conv.id,
      role: 'user',
      content: 'please recover without the failed evidence tool',
      status: 'complete',
    });
    const failed = messages.insert({
      conversation_id: conv.id,
      role: 'assistant',
      content: '',
      model_id: model.id,
      status: 'failed',
    });
    runEvents.append({
      run_id: 'run_budget_skip_original',
      conversation_id: conv.id,
      message_id: failed.id,
      kind: 'turn.started',
      status: 'started',
      label: '用户回合开始',
      payload: {
        run_kind: 'chat',
        source_user_message_id: user.id,
        model_id: model.id,
        assistant_message_id: failed.id,
      },
    });
    runEvents.append({
      run_id: 'run_budget_skip_original',
      conversation_id: conv.id,
      message_id: failed.id,
      kind: 'tool.failed',
      status: 'failed',
      label: '证据工具',
      summary: 'tool timeout',
      payload: { tool: 'mcp.test.evidence', ok: false, output: 'tool timeout' },
    });
    runEvents.append({
      run_id: 'run_budget_skip_original',
      conversation_id: conv.id,
      message_id: failed.id,
      kind: 'turn.failed',
      status: 'failed',
      label: '用户回合失败',
      payload: { assistant_message_id: failed.id, classification: 'tool_timeout' },
    });

    const blocked = await app.inject({
      method: 'POST',
      url: '/v1/runs/run_budget_skip_original/recover',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { action: 'skip_tool' },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({
      code: 'cost_confirmation_required',
      details: {
        reason: 'budget',
        model_id: model.id,
        conversation_id: conv.id,
        monthly_budget_usd: 0.01,
        month_spent_usd: 0.02,
      },
    });
    expect(messages.listByConversation(conv.id).filter((row) => row.role === 'assistant')).toHaveLength(1);

    const confirmed = await app.inject({
      method: 'POST',
      url: '/v1/runs/run_budget_skip_original/recover',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { action: 'skip_tool', confirmed_cost: true },
    });
    expect(confirmed.statusCode).toBe(200);
    const runs = runEvents.listRunsByConversation(conv.id, 5);
    expect(runs[0]).toMatchObject({
      kind: 'retry',
      status: 'completed',
      parent_run_id: 'run_budget_skip_original',
      recovery_policy: 'skip_tool',
      model_id: model.id,
    });
    const snapshot = runEvents.listByRun(runs[0]!.id).find((event) => event.kind === 'context.snapshot');
    const payload = snapshot?.payload as { disabled_tool_names?: string[] } | undefined;
    expect(payload?.disabled_tool_names ?? []).toContain('mcp.test.evidence');
  });

  it('POST /v1/runs/:id/recover compact_context retries with compacted history metadata', async () => {
    const provider = new ProvidersRepo(db).create({
      name: 'Mock Provider',
      type: 'custom',
      base_url: 'https://mock.example.com/v1',
    });
    const model = new ModelsRepo(db).create({
      provider_id: provider.id,
      model_name: 'mock-compact-chat',
      capability: 'chat',
      display_name: 'Mock Compact Chat',
      context_length: 1200,
    });
    const conv = convs.create({ type: 'chat', title: 'Compact recover run' });
    for (let i = 0; i < 6; i++) {
      messages.insert({
        conversation_id: conv.id,
        role: 'user',
        content: `old question ${i} ${'背景材料'.repeat(60)}`,
        status: 'complete',
      });
      messages.insert({
        conversation_id: conv.id,
        role: 'assistant',
        content: `old answer ${i} ${'回答内容'.repeat(60)}`,
        model_id: model.id,
        status: 'complete',
      });
    }
    const sourceUser = messages.insert({
      conversation_id: conv.id,
      role: 'user',
      content: 'please recover with compacted context',
      status: 'complete',
    });
    const failed = messages.insert({
      conversation_id: conv.id,
      role: 'assistant',
      content: '',
      model_id: model.id,
      status: 'failed',
    });
    runEvents.append({
      run_id: 'run_original_context_failed',
      conversation_id: conv.id,
      message_id: failed.id,
      kind: 'turn.started',
      status: 'started',
      label: '用户回合开始',
      payload: {
        run_kind: 'chat',
        source_user_message_id: sourceUser.id,
        model_id: model.id,
        assistant_message_id: failed.id,
      },
    });
    await sleep(2);
    runEvents.append({
      run_id: 'run_original_context_failed',
      conversation_id: conv.id,
      message_id: failed.id,
      kind: 'turn.failed',
      status: 'failed',
      label: '用户回合失败',
      payload: { assistant_message_id: failed.id, classification: 'unknown' },
    });

    const before = messages.listByConversation(conv.id);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/runs/run_original_context_failed/recover',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { action: 'compact_context' },
    });
    expect(res.statusCode).toBe(200);

    const after = messages.listByConversation(conv.id);
    expect(after.filter((row) => row.role === 'user')).toHaveLength(
      before.filter((row) => row.role === 'user').length,
    );
    const runs = runEvents.listRunsByConversation(conv.id, 5);
    expect(runs[0]).toMatchObject({
      kind: 'retry',
      status: 'completed',
      parent_run_id: 'run_original_context_failed',
      recovery_policy: 'compact_context',
      user_message_id: sourceUser.id,
      model_id: model.id,
    });
    const childEvents = runEvents.listByRun(runs[0]!.id);
    const started = childEvents.find((event) => event.kind === 'recovery.started');
    expect(started?.payload).toMatchObject({
      action: 'compact_context',
      compacted_message_count: 12,
    });
    const snapshot = childEvents.find((event) => event.kind === 'context.snapshot');
    const contextWindow = snapshot?.payload?.context_window as { sent_message_count?: number } | undefined;
    expect(contextWindow?.sent_message_count).toBeLessThan(before.length);
  });

  it('POST /v1/runs/:id/recover skip_tool retries with the failed tool disabled', async () => {
    const provider = new ProvidersRepo(db).create({
      name: 'Mock Provider',
      type: 'custom',
      base_url: 'https://mock.example.com/v1',
    });
    const model = new ModelsRepo(db).create({
      provider_id: provider.id,
      model_name: 'mock-skip-tool-chat',
      capability: 'chat',
      display_name: 'Mock Skip Tool Chat',
      supports_tools: true,
    });
    const conv = convs.create({ type: 'chat', title: 'Skip tool recover run' });
    const user = messages.insert({
      conversation_id: conv.id,
      role: 'user',
      content: 'please recover without the failed evidence tool',
      status: 'complete',
    });
    const failed = messages.insert({
      conversation_id: conv.id,
      role: 'assistant',
      content: '',
      model_id: model.id,
      status: 'failed',
    });
    runEvents.append({
      run_id: 'run_original_tool_failed',
      conversation_id: conv.id,
      message_id: failed.id,
      kind: 'turn.started',
      status: 'started',
      label: '用户回合开始',
      payload: {
        run_kind: 'chat',
        source_user_message_id: user.id,
        model_id: model.id,
        assistant_message_id: failed.id,
      },
    });
    await sleep(2);
    runEvents.append({
      run_id: 'run_original_tool_failed',
      conversation_id: conv.id,
      message_id: failed.id,
      kind: 'tool.failed',
      status: 'failed',
      label: '证据工具',
      summary: 'tool timeout',
      payload: { tool: 'mcp.test.evidence', ok: false, output: 'tool timeout' },
    });
    await sleep(2);
    runEvents.append({
      run_id: 'run_original_tool_failed',
      conversation_id: conv.id,
      message_id: failed.id,
      kind: 'turn.failed',
      status: 'failed',
      label: '用户回合失败',
      payload: { assistant_message_id: failed.id, classification: 'unknown' },
    });

    const before = messages.listByConversation(conv.id);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/runs/run_original_tool_failed/recover',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { action: 'skip_tool' },
    });
    expect(res.statusCode).toBe(200);

    const after = messages.listByConversation(conv.id);
    expect(after.filter((row) => row.role === 'user')).toHaveLength(
      before.filter((row) => row.role === 'user').length,
    );
    const runs = runEvents.listRunsByConversation(conv.id, 5);
    expect(runs[0]).toMatchObject({
      kind: 'retry',
      status: 'completed',
      parent_run_id: 'run_original_tool_failed',
      recovery_policy: 'skip_tool',
      user_message_id: user.id,
      model_id: model.id,
    });
    const childEvents = runEvents.listByRun(runs[0]!.id);
    const started = childEvents.find((event) => event.kind === 'recovery.started');
    expect(started?.payload).toMatchObject({
      action: 'skip_tool',
      skipped_tool_name: 'mcp.test.evidence',
      skipped_tool_label: '证据工具',
    });
    const snapshot = childEvents.find((event) => event.kind === 'context.snapshot');
    const payload = snapshot?.payload as {
      active_tool_names?: string[];
      disabled_tool_names?: string[];
    } | undefined;
    expect(payload?.active_tool_names ?? []).not.toContain('mcp.test.evidence');
    expect(payload?.disabled_tool_names ?? []).toContain('mcp.test.evidence');
  });

  it('POST /v1/runs/:id/recover skip_tool rejects runs without a failed tool', async () => {
    const provider = new ProvidersRepo(db).create({
      name: 'Mock Provider',
      type: 'custom',
      base_url: 'https://mock.example.com/v1',
    });
    const model = new ModelsRepo(db).create({
      provider_id: provider.id,
      model_name: 'mock-no-tool-chat',
      capability: 'chat',
      display_name: 'Mock No Tool Chat',
    });
    const conv = convs.create({ type: 'chat', title: 'No tool recover run' });
    const user = messages.insert({
      conversation_id: conv.id,
      role: 'user',
      content: 'please recover without tool failure',
      status: 'complete',
    });
    const failed = messages.insert({
      conversation_id: conv.id,
      role: 'assistant',
      content: '',
      model_id: model.id,
      status: 'failed',
    });
    runEvents.append({
      run_id: 'run_original_no_tool_failed',
      conversation_id: conv.id,
      message_id: failed.id,
      kind: 'turn.started',
      status: 'started',
      label: '用户回合开始',
      payload: {
        run_kind: 'chat',
        source_user_message_id: user.id,
        model_id: model.id,
        assistant_message_id: failed.id,
      },
    });
    await sleep(2);
    runEvents.append({
      run_id: 'run_original_no_tool_failed',
      conversation_id: conv.id,
      message_id: failed.id,
      kind: 'turn.failed',
      status: 'failed',
      label: '用户回合失败',
      payload: { assistant_message_id: failed.id, classification: 'unknown' },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/runs/run_original_no_tool_failed/recover',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { action: 'skip_tool' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      code: 'conflict',
    });
  });

  it('records context window truncation in context.snapshot for small context models', async () => {
    const provider = new ProvidersRepo(db).create({
      name: 'Mock Provider',
      type: 'custom',
      base_url: 'https://mock.example.com/v1',
    });
    const model = new ModelsRepo(db).create({
      provider_id: provider.id,
      model_name: 'tiny-context',
      capability: 'chat',
      display_name: 'Tiny Context',
      context_length: 900,
    });
    const payloadMessages = Array.from({ length: 12 }, (_, index) => ({
      role: (index % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `history-${index} ${'长上下文'.repeat(80)}`,
    }));
    payloadMessages.push({
      role: 'user',
      content: '请只回答 OK',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: {
        conversation_id: 'conv_tiny_context',
        model_id: model.id,
        messages: payloadMessages,
      },
    });
    expect(res.statusCode).toBe(200);

    const events = runEvents.listByConversation('conv_tiny_context', 20);
    const snapshot = events.find((event) => event.kind === 'context.snapshot');
    expect(snapshot?.payload?.context_window).toMatchObject({
      strategy: 'sliding_window',
      model_context_length: 900,
    });
    const contextWindow = snapshot?.payload?.context_window as { omitted_message_count?: number } | undefined;
    expect(contextWindow?.omitted_message_count).toBeGreaterThan(0);
  });
});
