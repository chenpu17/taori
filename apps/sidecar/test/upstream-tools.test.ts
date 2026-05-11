import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { openDb, type Db } from '../src/db/index.js';
import { CostsRepo } from '../src/db/repos/index.js';
import { CapabilityBus } from '../src/bus/index.js';
import { getVisibleToolNames } from '../src/chat/upstream-tools.js';

const createdDirs: string[] = [];

function makeBus(): { bus: CapabilityBus; db: Db; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taori-upstream-tools-'));
  createdDirs.push(dir);
  const db = openDb(path.join(dir, 'test.db'));
  const bus = new CapabilityBus(new CostsRepo(db));
  const schema = z.object({ query: z.string().optional() }).passthrough();

  bus.register({
    name: 'builtin.web_search',
    description: 'Search the public web',
    capability: 'web',
    source: 'builtin',
    source_id: 'builtin.web_search',
    enabled: true,
    inputSchema: schema,
    execute: async () => ({ output: { ok: true } }),
  });
  bus.register({
    name: 'mcp.bocha.search',
    description: 'Bocha Search',
    capability: 'mcp',
    source: 'mcp',
    source_id: 'mcp_bocha',
    enabled: true,
    inputSchema: schema,
    execute: async () => ({ output: { ok: true } }),
  });
  bus.register({
    name: 'builtin.web_fetch',
    description: 'Fetch a public URL',
    capability: 'web',
    source: 'builtin',
    source_id: 'builtin.web_fetch',
    enabled: true,
    inputSchema: z.object({ url: z.string() }),
    execute: async () => ({ output: { ok: true } }),
  });
  return { bus, db, dir };
}

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('preferred search tool selection', () => {
  it('prefers the configured search tool while keeping non-search tools visible', () => {
    const { bus } = makeBus();
    const visible = getVisibleToolNames({
      messageId: 'msg_1',
      conversationId: 'conv_1',
      sourceUserMessageId: 'msg_user',
      supportsTools: true,
      toolPolicy: {
        'builtin.web_search': true,
        'mcp.bocha.search': true,
        'builtin.web_fetch': true,
      },
      bus,
      imageModelId: null,
      filesRepo: null,
      log: console,
      defaultSearchToolName: 'mcp.bocha.search',
    });

    expect(visible).toContain('mcp.bocha.search');
    expect(visible).toContain('builtin.web_fetch');
    expect(visible).not.toContain('builtin.web_search');
  });

  it('falls back to builtin web search when the preferred tool is unavailable', () => {
    const { bus } = makeBus();
    const visible = getVisibleToolNames({
      messageId: 'msg_2',
      conversationId: 'conv_2',
      sourceUserMessageId: 'msg_user',
      supportsTools: true,
      toolPolicy: {
        'builtin.web_search': true,
        'mcp.bocha.search': false,
        'builtin.web_fetch': true,
      },
      bus,
      imageModelId: null,
      filesRepo: null,
      log: console,
      defaultSearchToolName: 'mcp.bocha.search',
    });

    expect(visible).toContain('builtin.web_search');
    expect(visible).toContain('builtin.web_fetch');
    expect(visible).not.toContain('mcp.bocha.search');
  });
});
