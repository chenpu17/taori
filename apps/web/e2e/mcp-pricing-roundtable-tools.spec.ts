import { test, expect, type Page, type TestInfo } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  authedFetch,
  readSidecarEnv,
  resetSidecar,
  type SidecarEnv,
} from './_helpers';
import { startMockOpenAI } from './_mock-openai-server';

const MOCK_PORT = 17931;
const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}/v1`;

let env: SidecarEnv;
let server: ReturnType<typeof startMockOpenAI> | null = null;
let tmpDir = '';
let mcpScriptPath = '';

test.beforeAll(() => {
  server = startMockOpenAI(MOCK_PORT, { mcpToolCalls: true });
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taori-e2e-mcp-'));
  mcpScriptPath = path.join(tmpDir, 'mock-mcp-server.mjs');
  fs.writeFileSync(mcpScriptPath, mockMcpServerSource());
  env = readSidecarEnv();
});

test.afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

test.beforeEach(async () => {
  await resetSidecar(env);
});

async function seedToolModels(): Promise<string[]> {
  const pr = await authedFetch(env, '/v1/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Roundtable Tool Mock',
      type: 'openai',
      base_url: MOCK_URL,
      api_key: 'sk-test',
    }),
  });
  expect(pr.ok).toBeTruthy();
  const provider = (await pr.json()) as { id: string };
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const mr = await authedFetch(env, '/v1/models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider_id: provider.id,
        model_name: ['mock-strategy', 'mock-user', 'mock-tech'][i],
        capability: 'chat',
        display_name: ['Strategy Tool', 'User Tool', 'Tech Tool'][i],
        supports_tools: true,
        ...(i === 0 ? { is_default_for: 'chat' } : {}),
        price_input_per_1m: 1,
        price_output_per_1m: 2,
      }),
    });
    expect(mr.ok).toBeTruthy();
    ids.push(((await mr.json()) as { id: string }).id);
  }
  return ids;
}

async function addMcpServerFromUi(page: Page): Promise<void> {
  await page.getByTestId('open-settings').click();
  await expect(page.getByTestId('control-center')).toBeVisible();
  await page.getByTestId('settings-tab-tools').click();
  await expect(page.getByTestId('settings-tools')).toBeVisible();
  await page.getByTestId('mcp-server-name').fill('E2E Echo MCP');
  await page.getByTestId('mcp-server-command').fill(process.execPath);
  await page.getByTestId('mcp-server-args').fill(mcpScriptPath);
  await page.getByTestId('mcp-server-add').click();
  await expect(page.locator('[data-testid^="mcp-server-mcp_"]').first()).toContainText('健康：ok', {
    timeout: 20_000,
  });
  await expect(page.locator('[data-testid^="settings-tool-mcp."]').first()).toBeVisible({
    timeout: 10_000,
  });
}

async function attachFullPage(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await testInfo.attach(name, {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
}

async function expectNoFeatureLayoutOverflow(page: Page, label: string): Promise<void> {
  const problems = await page.evaluate(() => {
    const selectors = [
      '[data-testid="control-center"]',
      '[data-testid="settings-tools"]',
      '[data-testid="settings-mcp"]',
      '[data-testid="model-center"]',
      '[data-testid="model-editor"]',
      '[data-testid="roundtable-panel"]',
      '[data-testid="roundtable-grid"]',
      '[data-testid^="roundtable-tool-traces-"]',
    ];
    const viewportWidth = document.documentElement.clientWidth;
    const result: Array<Record<string, unknown>> = [];
    const bodyOverflow = document.documentElement.scrollWidth - viewportWidth;
    if (bodyOverflow > 3) {
      result.push({ selector: 'document', issue: 'horizontal_overflow', overflow: bodyOverflow });
    }
    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) {
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        if (rect.left < -3 || rect.right > viewportWidth + 3) {
          result.push({ selector, issue: 'outside_viewport', left: rect.left, right: rect.right, viewportWidth });
        }
        if (el.scrollWidth - el.clientWidth > 3 && style.overflowX === 'visible') {
          result.push({ selector, issue: 'unmanaged_horizontal_overflow', overflow: el.scrollWidth - el.clientWidth });
        }
      }
    }
    return result;
  });
  expect(problems, label).toEqual([]);
}

test('web UI adds MCP server, refreshes tools, and edits pricing_meta JSON', async ({ page }, testInfo) => {
  const [modelId] = await seedToolModels();
  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  await addMcpServerFromUi(page);
  await page.locator('.control-center__content').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  const mcpMetrics = await page.evaluate(() => {
    const controls = [...document.querySelectorAll('.settings-mcp-form input, .settings-mcp-form button')].map((el) => {
      const rect = (el as HTMLElement).getBoundingClientRect();
      return { height: rect.height, width: rect.width, text: (el as HTMLInputElement).value || el.textContent || '' };
    });
    const serverCard = document.querySelector('[data-testid^="mcp-server-mcp_"]') as HTMLElement | null;
    return {
      controls,
      serverCard: serverCard
        ? {
            width: serverCard.getBoundingClientRect().width,
            scrollWidth: serverCard.scrollWidth,
          }
        : null,
    };
  });
  expect(mcpMetrics.controls.length).toBe(4);
  for (const control of mcpMetrics.controls) {
    expect(control.height).toBeGreaterThanOrEqual(26);
    expect(control.height).toBeLessThanOrEqual(44);
  }
  expect(mcpMetrics.serverCard?.scrollWidth).toBeLessThanOrEqual((mcpMetrics.serverCard?.width ?? 0) + 3);
  await expectNoFeatureLayoutOverflow(page, 'MCP settings layout');
  await attachFullPage(page, testInfo, 'mcp-settings-visible');

  await page.getByTestId('control-center-nav-models').click();
  await expect(page.getByTestId('model-center')).toBeVisible();
  await page.getByTestId(`model-edit-${modelId}`).click();
  await expect(page.getByTestId('model-editor')).toBeVisible();
  await page.getByTestId('model-editor-pricing-meta').fill(
    JSON.stringify(
      {
        version: 1,
        unit: 'call',
        tiers: [{ label: 'standard', match: { mode: 'roundtable' }, price_usd: 0.003 }],
        notes: 'E2E complex pricing',
      },
      null,
      2,
    ),
  );
  const editorMetrics = await page.evaluate(() => {
    const editor = document.querySelector('[data-testid="model-editor"]') as HTMLElement | null;
    const textarea = document.querySelector('[data-testid="model-editor-pricing-meta"]') as HTMLElement | null;
    return {
      editor: editor
        ? {
            width: editor.getBoundingClientRect().width,
            height: editor.getBoundingClientRect().height,
            scrollHeight: editor.scrollHeight,
          }
        : null,
      textarea: textarea
        ? {
            width: textarea.getBoundingClientRect().width,
            height: textarea.getBoundingClientRect().height,
            fontFamily: getComputedStyle(textarea).fontFamily,
          }
        : null,
    };
  });
  expect(editorMetrics.editor?.height).toBeLessThanOrEqual(900);
  expect(editorMetrics.textarea?.height).toBeGreaterThanOrEqual(160);
  expect(editorMetrics.textarea?.fontFamily.toLowerCase()).toContain('mono');
  await expectNoFeatureLayoutOverflow(page, 'pricing_meta editor layout');
  await attachFullPage(page, testInfo, 'pricing-meta-editor-visible');
  await page.getByTestId('model-editor-save').click();
  await expect(page.getByTestId('model-editor')).toHaveCount(0);
  await expect(page.getByTestId('model-matrix')).toBeVisible();
  await expect(page.locator('.badge--price_changed').filter({ hasText: 'pricing_meta' }).first()).toBeVisible();
  const matrixMetrics = await page.evaluate(() => {
    const scroller = document.querySelector('.model-matrix-scroll') as HTMLElement | null;
    const header = [...document.querySelectorAll('.model-matrix th')].find((el) => el.textContent?.includes('复杂价格')) as HTMLElement | undefined;
    const badge = [...document.querySelectorAll('.badge--price_changed')].find((el) => el.textContent?.includes('pricing_meta')) as HTMLElement | undefined;
    return {
      scroller: scroller
        ? {
            width: scroller.getBoundingClientRect().width,
            scrollWidth: scroller.scrollWidth,
            overflowX: getComputedStyle(scroller).overflowX,
          }
        : null,
      header: header
        ? {
            width: header.getBoundingClientRect().width,
            height: header.getBoundingClientRect().height,
          }
        : null,
      badge: badge
        ? {
            width: badge.getBoundingClientRect().width,
            height: badge.getBoundingClientRect().height,
            whiteSpace: getComputedStyle(badge).whiteSpace,
          }
        : null,
    };
  });
  expect(matrixMetrics.scroller?.overflowX).toMatch(/auto|scroll/);
  expect(matrixMetrics.header?.width).toBeGreaterThanOrEqual(96);
  expect(matrixMetrics.badge?.width).toBeGreaterThanOrEqual(72);
  expect(matrixMetrics.badge?.height).toBeLessThanOrEqual(24);
  expect(matrixMetrics.badge?.whiteSpace).toBe('nowrap');
  await expectNoFeatureLayoutOverflow(page, 'model matrix complex pricing column');
  await attachFullPage(page, testInfo, 'model-matrix-pricing-meta-visible');

  const modelsRes = await authedFetch(env, '/v1/models');
  const models = ((await modelsRes.json()) as { models: Array<{ id: string; pricing_meta?: { notes?: string } | null }> }).models;
  expect(models.find((m) => m.id === modelId)?.pricing_meta?.notes).toBe('E2E complex pricing');
});

test('roundtable participant uses MCP tool and renders tool trace in web panel', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await seedToolModels();
  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await addMcpServerFromUi(page);
  await page.getByTestId('settings-close').click();

  await page.getByTestId('composer-input').fill('请用 MCP 工具补充证据，讨论这个技术方案是否值得推进');
  await page.getByTestId('composer-roundtable').click();
  const dlg = page.getByTestId('roundtable-launch-dialog');
  await expect(dlg).toBeVisible();
  await dlg.getByTestId('roundtable-launch-start').click();
  await expect(dlg.getByTestId('roundtable-preview')).toBeVisible({ timeout: 20_000 });
  await dlg.getByTestId('roundtable-launch-continue').click();

  const panel = page.getByTestId('roundtable-panel');
  await expect(panel).toBeVisible();
  await panel.getByTestId('roundtable-action-start-round').click();
  await expect(panel.locator('[data-testid^="roundtable-tool-traces-"]').first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(panel.locator('[data-testid^="roundtable-tool-traces-"]').first()).toContainText('E2E Echo');
  await expect(panel.getByTestId('roundtable-action-next-round')).toBeVisible({ timeout: 40_000 });
  await expect(panel.locator('[data-testid^="roundtable-tool-traces-"]').first()).toContainText('完成');
  const traceMetrics = await page.evaluate(() => {
    return [...document.querySelectorAll('[data-testid^="roundtable-tool-traces-"]')].map((el) => {
      const rect = (el as HTMLElement).getBoundingClientRect();
      return {
        width: rect.width,
        height: rect.height,
        text: (el.textContent ?? '').slice(0, 160),
        scrollWidth: (el as HTMLElement).scrollWidth,
      };
    });
  });
  expect(traceMetrics.length).toBeGreaterThanOrEqual(3);
  for (const item of traceMetrics) {
    expect(item.width).toBeGreaterThan(250);
    expect(item.height).toBeGreaterThan(40);
    expect(item.scrollWidth).toBeLessThanOrEqual(item.width + 3);
    expect(item.text).toContain('MCP');
  }
  await expectNoFeatureLayoutOverflow(page, 'roundtable MCP tool trace layout');
  await attachFullPage(page, testInfo, 'roundtable-mcp-tool-traces-visible');

  await panel.getByTestId('roundtable-action-next-round').click();
  await expect(panel.locator('[data-testid^="roundtable-tool-traces-"][data-testid$="-1"]').first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(panel.locator('[data-testid^="roundtable-tool-traces-"]').first()).toContainText('MCP');
  await expectNoFeatureLayoutOverflow(page, 'roundtable second round keeps first round tool traces');
  await attachFullPage(page, testInfo, 'roundtable-second-round-traces-visible');
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
    send(message.id, { tools: [{ name: 'echo', description: 'E2E Echo MCP', inputSchema: { type: 'object' } }] });
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
