import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/server.js';
import { ControlClient } from '../src/control/client.js';
import { MemoryStore } from '../src/keystore.js';
import { openDb, type Db } from '../src/db/index.js';
import { MemoriesRepo } from '../src/db/repos/index.js';
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

  it('web_search falls back to secondary DuckDuckGo endpoint after a timeout', async () => {
    await app.close();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('timed out'), { name: 'AbortError' }))
      .mockResolvedValueOnce(new Response(`
        <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fb">Fallback Title</a>
        <a class="result__snippet">Fallback snippet</a>
      `, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    app = await makeApp(db, dbPath);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/tools/invoke',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'builtin.web_search',
        input: { query: 'fallback search' },
      }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.ok).toBe(true);
    expect(res.json().data.output.results).toEqual([
      { title: 'Fallback Title', url: 'https://example.com/b', snippet: 'Fallback snippet' },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('html.duckduckgo.com/html/');
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('duckduckgo.com/html/');
  });

  it('web_search surfaces DuckDuckGo anti-bot blocks as actionable errors', async () => {
    await app.close();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          '<html><body><div class=\"anomaly-modal\">Unfortunately, bots use DuckDuckGo too.</div></body></html>',
          {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          },
        ),
      ),
    );
    app = await makeApp(db, dbPath);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/tools/invoke',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'builtin.web_search',
        input: { query: 'blocked search' },
      }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.ok).toBe(false);
    expect(res.json().data.error.message).toContain('DuckDuckGo blocked the automated search');
  });

  it('web_search falls back to Exa when DuckDuckGo is blocked', async () => {
    await app.close();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(
        '<html><body><div class="anomaly-modal">Unfortunately, bots use DuckDuckGo too.</div></body></html>',
        { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
      ))
      .mockResolvedValueOnce(new Response(
        '<html><body><div class="anomaly-modal">Unfortunately, bots use DuckDuckGo too.</div></body></html>',
        { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
      ))
      .mockResolvedValueOnce(new Response([
        'event: message',
        'data: {"result":{"content":[{"text":"Title: Exa Rescue\\nURL: https://example.com/exa-rescue\\nDescription: Exa fallback snippet"}]}}',
      ].join('\n'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    app = await makeApp(db, dbPath);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/tools/invoke',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'builtin.web_search',
        input: { query: 'blocked search rescue' },
      }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.ok).toBe(true);
    expect(res.json().data.output.engine).toBe('exa');
    expect(res.json().data.output.fallback_from).toBe('duckduckgo');
    expect(res.json().data.output.results[0]).toEqual({
      title: 'Exa Rescue',
      url: 'https://example.com/exa-rescue',
      snippet: 'Exa fallback snippet',
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('web_search falls back to Exa when DuckDuckGo returns no results', async () => {
    await app.close();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('<html><body>No results</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }))
      .mockResolvedValueOnce(new Response('<html><body>No results</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }))
      .mockResolvedValueOnce(new Response([
        'event: message',
        'data: {"result":{"content":[{"text":"Title: Exa Empty Rescue\\nURL: https://example.com/exa-empty-rescue\\nDescription: Exa fallback after empty DDG"}]}}',
      ].join('\n'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    app = await makeApp(db, dbPath);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/tools/invoke',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'builtin.web_search',
        input: { query: 'empty search rescue' },
      }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.ok).toBe(true);
    expect(res.json().data.output.engine).toBe('exa');
    expect(res.json().data.output.fallback_from).toBe('duckduckgo');
    expect(res.json().data.output.results[0]).toEqual({
      title: 'Exa Empty Rescue',
      url: 'https://example.com/exa-empty-rescue',
      snippet: 'Exa fallback after empty DDG',
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('web_search honors explicit engine override to Exa', async () => {
    await app.close();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response([
        'event: message',
        'data: {"result":{"content":[{"text":"Title: Forced Exa\\nURL: https://example.com/forced-exa\\nDescription: Forced Exa snippet"}]}}',
      ].join('\n'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    app = await makeApp(db, dbPath);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/tools/invoke',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'builtin.web_search',
        input: { query: 'forced exa', engine: 'exa' },
      }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.ok).toBe(true);
    expect(res.json().data.output.engine).toBe('exa');
    expect(res.json().data.output.results[0]?.url).toBe('https://example.com/forced-exa');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('mcp.exa.ai/mcp');
  });

  it('web_search uses Exa when configured via memory', async () => {
    await app.close();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response([
        'event: message',
        'data: {"result":{"content":[{"text":"Title: Exa Result\\nURL: https://example.com/exa\\nDescription: Exa snippet"}]}}',
      ].join('\n'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      })),
    );
    new MemoriesRepo(db).set('global', null, 'builtin_web_search_engine', 'exa');
    app = await makeApp(db, dbPath);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/tools/invoke',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'builtin.web_search',
        input: { query: 'exa search' },
      }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.ok).toBe(true);
    expect(res.json().data.output.engine).toBe('exa');
    expect(res.json().data.output.results[0]).toEqual({
      title: 'Exa Result',
      url: 'https://example.com/exa',
      snippet: 'Exa snippet',
    });
  });

  it('web_search uses Bocha when configured via memory', async () => {
    await app.close();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', {
        status: 200,
        headers: { 'mcp-session-id': 'bocha-session-1' },
      }))
      .mockResolvedValueOnce(new Response([
        'data: {"result":{"content":[{"text":"Title: Bocha Result\\nURL: https://example.com/bocha\\nDescription: Bocha snippet"}]}}',
      ].join('\n'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    const memories = new MemoriesRepo(db);
    memories.set('global', null, 'builtin_web_search_engine', 'bocha');
    memories.set('global', null, 'builtin_web_search_bocha_api_key', 'sk-bocha-test');
    app = await makeApp(db, dbPath);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/tools/invoke',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'builtin.web_search',
        input: { query: 'bocha search' },
      }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.ok).toBe(true);
    expect(res.json().data.output.engine).toBe('bocha');
    expect(res.json().data.output.results[0]).toEqual({
      title: 'Bocha Result',
      url: 'https://example.com/bocha',
      snippet: 'Bocha snippet',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('web_search rejects bocha without API key', async () => {
    await app.close();
    new MemoriesRepo(db).set('global', null, 'builtin_web_search_engine', 'bocha');
    app = await makeApp(db, dbPath);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/tools/invoke',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'builtin.web_search',
        input: { query: 'bocha search' },
      }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.ok).toBe(false);
    expect(res.json().data.error.classification).toBe('validation_error');
  });

  it('web_search falls back to Exa when Bocha returns an invalid key error', async () => {
    await app.close();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', {
        status: 200,
        headers: { 'mcp-session-id': 'bocha-session-1' },
      }))
      .mockResolvedValueOnce(new Response([
        'data: {"result":{"content":[{"text":"Bocha AI Search API HTTP error occurred: 401 Invalid API KEY"}]}}',
      ].join('\n'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      }))
      .mockResolvedValueOnce(new Response([
        'event: message',
        'data: {"result":{"content":[{"text":"Title: Exa Rescue\\nURL: https://example.com/exa-after-bocha\\nDescription: Exa fallback snippet"}]}}',
      ].join('\n'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    const memories = new MemoriesRepo(db);
    memories.set('global', null, 'builtin_web_search_engine', 'bocha');
    memories.set('global', null, 'builtin_web_search_bocha_api_key', 'sk-bocha-bad');
    app = await makeApp(db, dbPath);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/tools/invoke',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'builtin.web_search',
        input: { query: 'bocha fallback search' },
      }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.ok).toBe(true);
    expect(res.json().data.output.engine).toBe('exa');
    expect(res.json().data.output.fallback_from).toBe('bocha');
    expect(res.json().data.output.results[0]).toEqual({
      title: 'Exa Rescue',
      url: 'https://example.com/exa-after-bocha',
      snippet: 'Exa fallback snippet',
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
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
