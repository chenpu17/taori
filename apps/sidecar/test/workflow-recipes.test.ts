import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/server.js';
import { ControlClient } from '../src/control/client.js';
import { openDb } from '../src/db/index.js';
import { MemoryStore } from '../src/keystore.js';

const bearer = 'test_bearer_workflow_recipes';

function newApp() {
  const dbPath = path.join(os.tmpdir(), `taori-workflow-recipes-${Date.now()}-${Math.random()}.db`);
  const db = openDb(dbPath);
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
  });
  return { app, dbPath };
}

const spec = {
  schema_version: 1 as const,
  name: '网页调研报告',
  description: '搜索并输出调研报告',
  prompt_template: '请围绕 {{topic}} 输出结论和证据。',
  variables: [{ name: 'topic', label: '主题', required: true }],
  recommended_task: 'long_context' as const,
  model_strategy: 'recommend' as const,
  persona: { mode: 'none' as const },
  tools: { required: ['builtin.web_search'], optional: ['builtin.file_search'] },
  output_format: { kind: 'markdown' as const, sections: ['结论', '证据'] },
  budget: { mode: 'soft_cap' as const, max_estimated_usd: 0.2 },
  metadata: {},
};

describe('workflow recipe routes', () => {
  let app: FastifyInstance;
  let dbPath: string;

  beforeEach(async () => {
    ({ app, dbPath } = newApp());
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    fs.rmSync(dbPath, { force: true });
  });

  it('creates, lists, previews and exports a recipe', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/v1/workflow-recipes',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: { name: spec.name, description: spec.description, spec },
    });
    expect(create.statusCode).toBe(201);
    const recipe = JSON.parse(create.payload) as { id: string; name: string };
    expect(recipe.id).toMatch(/^wfr_/);

    const list = await app.inject({
      method: 'GET',
      url: '/v1/workflow-recipes',
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(list.statusCode).toBe(200);
    expect(JSON.parse(list.payload).workflow_recipes).toHaveLength(1);

    const preview = await app.inject({
      method: 'POST',
      url: `/v1/workflow-recipes/${recipe.id}/apply-preview`,
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: { variables: { topic: 'Taori' } },
    });
    expect(preview.statusCode).toBe(200);
    const body = JSON.parse(preview.payload) as {
      prompt: string;
      missing_variables: string[];
      tools: { required: Array<{ name: string; available: boolean }> };
    };
    expect(body.prompt).toBe('请围绕 Taori 输出结论和证据。');
    expect(body.missing_variables).toEqual([]);
    expect(body.tools.required[0]).toMatchObject({ name: 'builtin.web_search', available: true });

    const exported = await app.inject({
      method: 'GET',
      url: `/v1/workflow-recipes/${recipe.id}/export`,
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers['content-disposition']).toContain('.taori-recipe.json');
    expect(JSON.parse(exported.payload).spec.name).toBe(spec.name);
  });

  it('imports recipe JSON and rejects missing variables in preview', async () => {
    const imported = await app.inject({
      method: 'POST',
      url: '/v1/workflow-recipes/import',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: { spec },
    });
    expect(imported.statusCode).toBe(201);
    const recipe = JSON.parse(imported.payload) as { id: string };

    const preview = await app.inject({
      method: 'POST',
      url: `/v1/workflow-recipes/${recipe.id}/apply-preview`,
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: { variables: {} },
    });
    expect(preview.statusCode).toBe(200);
    expect(JSON.parse(preview.payload).missing_variables).toEqual(['topic']);
  });

  it('rejects unsupported schema versions', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/workflow-recipes/import',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: { spec: { ...spec, schema_version: 2 } },
    });

    expect(res.statusCode).toBe(400);
  });
});
