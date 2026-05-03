import { test, expect, type Page } from '@playwright/test';
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

test('web UI adds MCP server, refreshes tools, and edits pricing_meta JSON', async ({ page }) => {
  const [modelId] = await seedToolModels();
  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  await addMcpServerFromUi(page);
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
  await page.getByTestId('model-editor-save').click();
  await expect(page.getByTestId('model-editor')).toHaveCount(0);

  const modelsRes = await authedFetch(env, '/v1/models');
  const models = ((await modelsRes.json()) as { models: Array<{ id: string; pricing_meta?: { notes?: string } | null }> }).models;
  expect(models.find((m) => m.id === modelId)?.pricing_meta?.notes).toBe('E2E complex pricing');
});

test('roundtable participant uses MCP tool and renders tool trace in web panel', async ({ page }) => {
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
