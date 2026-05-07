import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/server.js';
import { ControlClient } from '../src/control/client.js';
import { MemoryStore } from '../src/keystore.js';
import { openDb, type Db } from '../src/db/index.js';
import { __test__ as webSearchTest } from '../src/bus/builtins/web_search.js';

const bearer = 'test_bearer_web_tools';

describe('builtin web tools', () => {
  let app: FastifyInstance;
  let db: Db;
  let tmpDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taori-web-tools-'));
    dbPath = path.join(tmpDir, 'test.db');
    db = openDb(dbPath);
    app = await makeApp(db, dbPath);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('lists web tools and persists manual enabled toggles', async () => {
    const list = await app.inject({
      method: 'GET',
      url: '/v1/tools',
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().data.map((t: { name: string }) => t.name)).toContain('builtin.web_search');
    expect(list.json().data.map((t: { name: string }) => t.name)).toContain('builtin.web_fetch');

    const off = await app.inject({
      method: 'PUT',
      url: '/v1/tools/builtin.web_fetch/enabled',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ enabled: false }),
    });
    expect(off.statusCode).toBe(200);
    expect(off.json().data.enabled).toBe(false);

    await app.close();
    app = await makeApp(db, dbPath);
    const listAfterRestart = await app.inject({
      method: 'GET',
      url: '/v1/tools',
      headers: { authorization: `Bearer ${bearer}` },
    });
    const webFetch = listAfterRestart.json().data.find((t: { name: string }) => t.name === 'builtin.web_fetch');
    expect(webFetch.enabled).toBe(false);
  });

  it('web_fetch blocks localhost/private targets before network access', async () => {
    const fetchMock = vi.fn();
    await app.close();
    vi.stubGlobal('fetch', fetchMock);
    app = await makeApp(db, dbPath);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tools/invoke',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'builtin.web_fetch',
        input: { url: 'http://127.0.0.1:17900/health' },
      }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.ok).toBe(false);
    expect(res.json().data.error.classification).toBe('permission_denied');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('web_fetch returns readable markdown for public HTML', async () => {
    await app.close();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('<html><head><title>Example</title></head><body><h1>Hello</h1><p>World</p></body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
      ),
    );
    app = await makeApp(db, dbPath);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tools/invoke',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'builtin.web_fetch',
        input: { url: 'https://93.184.216.34/page', max_chars: 2000 },
      }),
    });
    expect(res.json().data.ok).toBe(true);
    expect(res.json().data.output.title).toBe('Example');
    expect(res.json().data.output.content).toContain('# Hello');
  });

  it('parses DuckDuckGo html result links', () => {
    const html = `
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa">Example &amp; Title</a>
      <a class="result__snippet">Snippet &amp; details</a>
    `;
    const results = webSearchTest.parseDuckDuckGo(html, 5);
    expect(results).toEqual([
      { title: 'Example & Title', url: 'https://example.com/a', snippet: 'Snippet & details' },
    ]);
  });
});

async function makeApp(db: Db, dbPath: string): Promise<FastifyInstance> {
  const app = buildServer({
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
  return app;
}
