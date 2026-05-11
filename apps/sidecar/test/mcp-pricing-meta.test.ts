import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { openDb } from '../src/db/index.js';
import { ControlClient } from '../src/control/client.js';
import { MemoryStore } from '../src/keystore.js';
import { ProvidersRepo } from '../src/db/repos/index.js';
import type { FastifyInstance } from 'fastify';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const bearer = 'test_bearer_mcp_pricing';

describe('MCP stdio + pricing_meta', () => {
  let app: FastifyInstance;
  let dbPath: string;
  let db: ReturnType<typeof openDb>;
  let tmpDir: string;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `taori-mcp-pricing-${Date.now()}-${Math.random()}.db`);
    db = openDb(dbPath);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taori-mcp-pricing-'));
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
      keystore: new MemoryStore(),
      startedAt: Date.now(),
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${bearer}`, ...extra };
  }

  it('refreshes a local stdio MCP server, registers its tool, and invokes through Capability Bus', async () => {
    const scriptPath = path.join(tmpDir, 'mock-mcp-server.mjs');
    fs.writeFileSync(scriptPath, mockMcpServerSource());

    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/mcp/servers',
      headers: authHeaders({ 'content-type': 'application/json' }),
      payload: JSON.stringify({
        name: 'Mock MCP',
        command: process.execPath,
        args: [scriptPath],
      }),
    });
    expect(createRes.statusCode).toBe(201);
    const created = createRes.json() as { server: { id: string } };

    const refreshRes = await app.inject({
      method: 'POST',
      url: `/v1/mcp/servers/${created.server.id}/refresh`,
      headers: authHeaders(),
    });
    expect(refreshRes.statusCode).toBe(200);
    const refreshBody = refreshRes.json() as {
      ok: boolean;
      server: { health_status: string; tools_count: number };
      tools: Array<{ name: string }>;
    };
    expect(refreshBody.ok).toBe(true);
    expect(refreshBody.server.health_status).toBe('ok');
    expect(refreshBody.server.tools_count).toBe(1);

    const toolName = refreshBody.tools[0]!.name;
    const toolsRes = await app.inject({
      method: 'GET',
      url: '/v1/tools',
      headers: authHeaders(),
    });
    expect(toolsRes.payload).toContain(toolName);

    const invokeRes = await app.inject({
      method: 'POST',
      url: '/v1/tools/invoke',
      headers: authHeaders({ 'content-type': 'application/json' }),
      payload: JSON.stringify({
        name: toolName,
        input: { text: 'hello mcp' },
        conversation_id: null,
      }),
    });
    expect(invokeRes.statusCode).toBe(200);
    const invokeBody = invokeRes.json() as { data: { ok: boolean; output: unknown } };
    expect(invokeBody.data.ok).toBe(true);
    expect(JSON.stringify(invokeBody.data.output)).toContain('hello mcp');

    const invalidInvokeRes = await app.inject({
      method: 'POST',
      url: '/v1/tools/invoke',
      headers: authHeaders({ 'content-type': 'application/json' }),
      payload: JSON.stringify({
        name: toolName,
        input: { text: 42 },
        conversation_id: null,
      }),
    });
    expect(invalidInvokeRes.statusCode).toBe(200);
    const invalidBody = invalidInvokeRes.json() as {
      data: { ok: boolean; error: { classification: string; message: string } };
    };
    expect(invalidBody.data.ok).toBe(false);
    expect(invalidBody.data.error.classification).toBe('validation_error');

    const healthRes = await app.inject({
      method: 'GET',
      url: '/v1/tools/health',
      headers: authHeaders(),
    });
    expect(healthRes.statusCode).toBe(200);
    const healthBody = healthRes.json() as {
      rows: Array<{
        tool_name: string;
        calls_24h: number;
        failures_24h: number;
        last_failure_classification: string | null;
      }>;
    };
    const row = healthBody.rows.find((item) => item.tool_name === toolName);
    expect(row?.calls_24h).toBe(2);
    expect(row?.failures_24h).toBe(1);
    expect(row?.last_failure_classification).toBe('validation_error');
  });

  it('classifies MCP server crashes during tool calls', async () => {
    const scriptPath = path.join(tmpDir, 'crashing-mcp-server.mjs');
    fs.writeFileSync(scriptPath, crashingMcpServerSource());

    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/mcp/servers',
      headers: authHeaders({ 'content-type': 'application/json' }),
      payload: JSON.stringify({
        name: 'Crashing MCP',
        command: process.execPath,
        args: [scriptPath],
      }),
    });
    const created = createRes.json() as { server: { id: string } };
    const refreshRes = await app.inject({
      method: 'POST',
      url: `/v1/mcp/servers/${created.server.id}/refresh`,
      headers: authHeaders(),
    });
    expect(refreshRes.statusCode).toBe(200);
    const refreshBody = refreshRes.json() as { ok: boolean; tools: Array<{ name: string }> };
    expect(refreshBody.ok).toBe(true);
    expect(refreshBody.tools.length).toBeGreaterThan(0);
    const toolName = refreshBody.tools[0]!.name;

    const invokeRes = await app.inject({
      method: 'POST',
      url: '/v1/tools/invoke',
      headers: authHeaders({ 'content-type': 'application/json' }),
      payload: JSON.stringify({
        name: toolName,
        input: {},
        conversation_id: null,
      }),
    });
    const body = invokeRes.json() as {
      data: { ok: boolean; error: { classification: string; message: string } };
    };
    expect(body.data.ok).toBe(false);
    expect(body.data.error.classification).toBe('mcp_crashed');
  });

  it('exposes MCP runtime tools and recent logs, and supports restart', async () => {
    const scriptPath = path.join(tmpDir, 'logging-mcp-server.mjs');
    fs.writeFileSync(scriptPath, loggingMcpServerSource());

    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/mcp/servers',
      headers: authHeaders({ 'content-type': 'application/json' }),
      payload: JSON.stringify({
        name: 'Logging MCP',
        command: process.execPath,
        args: [scriptPath],
      }),
    });
    expect(createRes.statusCode).toBe(201);
    const created = createRes.json() as { server: { id: string } };

    const refreshRes = await app.inject({
      method: 'POST',
      url: `/v1/mcp/servers/${created.server.id}/refresh`,
      headers: authHeaders(),
    });
    expect(refreshRes.statusCode).toBe(200);

    const runtimeRes = await app.inject({
      method: 'GET',
      url: `/v1/mcp/servers/${created.server.id}/runtime`,
      headers: authHeaders(),
    });
    expect(runtimeRes.statusCode).toBe(200);
    const runtimeBody = runtimeRes.json() as {
      ok: boolean;
      session_running: boolean;
      tools: Array<{ name: string }>;
      logs: Array<{ message: string }>;
    };
    expect(runtimeBody.ok).toBe(true);
    expect(runtimeBody.session_running).toBe(true);
    expect(runtimeBody.tools.some((tool) => tool.name.endsWith('.echo'))).toBe(true);
    expect(runtimeBody.logs.some((entry) => entry.message.includes('mock stderr ready'))).toBe(true);

    const restartRes = await app.inject({
      method: 'POST',
      url: `/v1/mcp/servers/${created.server.id}/restart`,
      headers: authHeaders(),
    });
    expect(restartRes.statusCode).toBe(200);

    const runtimeAfterRestartRes = await app.inject({
      method: 'GET',
      url: `/v1/mcp/servers/${created.server.id}/runtime`,
      headers: authHeaders(),
    });
    const runtimeAfterRestart = runtimeAfterRestartRes.json() as {
      logs: Array<{ message: string }>;
    };
    expect(runtimeAfterRestart.logs.some((entry) => entry.message.includes('session closed'))).toBe(true);
  });

  it('persists pricing_meta through model create and update', async () => {
    const provider = new ProvidersRepo(db).create({
      name: 'Pricing Provider',
      type: 'custom',
      base_url: 'https://example.invalid/v1',
    });

    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/models',
      headers: authHeaders({ 'content-type': 'application/json' }),
      payload: JSON.stringify({
        provider_id: provider.id,
        model_name: 'image-tiered',
        capability: 'image',
        display_name: 'Image Tiered',
        price_per_image: 0.04,
        pricing_meta: {
          version: 1,
          unit: 'image',
          tiers: [{ label: '1024', match: { size: '1024x1024' }, price_usd: 0.04 }],
          notes: 'resolution tier',
        },
      }),
    });
    expect(createRes.statusCode).toBe(201);
    const created = createRes.json() as { id: string; pricing_meta: { notes: string } };
    expect(created.pricing_meta.notes).toBe('resolution tier');

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/v1/models/${created.id}`,
      headers: authHeaders({ 'content-type': 'application/json' }),
      payload: JSON.stringify({
        pricing_meta: {
          version: 1,
          unit: 'image',
          tiers: [{ label: 'HD', match: { quality: 'hd' }, price_usd: 0.08 }],
          notes: 'quality tier',
        },
      }),
    });
    expect(patchRes.statusCode).toBe(200);
    const patched = patchRes.json() as { pricing_meta: { notes: string; tiers: Array<{ price_usd: number }> } };
    expect(patched.pricing_meta.notes).toBe('quality tier');
    expect(patched.pricing_meta.tiers[0]!.price_usd).toBe(0.08);
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
      tools: [
        {
          name: 'echo',
          description: 'Echo text',
          inputSchema: {
            type: 'object',
            properties: { text: { type: 'string', minLength: 1 } },
            required: ['text'],
            additionalProperties: false
          }
        }
      ]
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

function crashingMcpServerSource(): string {
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
    send(message.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'crash', version: '1' } });
  } else if (message.method === 'tools/list') {
    send(message.id, { tools: [{ name: 'crash', description: 'Crash now', inputSchema: { type: 'object' } }] });
  } else if (message.method === 'tools/call') {
    process.exit(42);
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

function loggingMcpServerSource(): string {
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
    console.error('mock stderr ready');
    send(message.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'mock', version: '1' } });
  } else if (message.method === 'tools/list') {
    console.error('tools listed');
    send(message.id, {
      tools: [
        {
          name: 'echo',
          description: 'Echo text',
          inputSchema: { type: 'object', properties: {}, additionalProperties: true }
        }
      ]
    });
  } else {
    send(message.id, {});
  }
}
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const idx = buffer.indexOf('\\r\\n\\r\\n');
    if (idx === -1) break;
    const head = buffer.slice(0, idx).toString('utf8');
    const match = /Content-Length:\\s*(\\d+)/i.exec(head);
    if (!match) throw new Error('Missing content length');
    const length = Number(match[1]);
    const start = idx + 4;
    if (buffer.length < start + length) break;
    const body = buffer.slice(start, start + length).toString('utf8');
    buffer = buffer.slice(start + length);
    handle(JSON.parse(body));
  }
});
`;
}
