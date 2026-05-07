import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { authedFetch, readSidecarEnv, resetSidecar, type SidecarEnv } from './_helpers';
import { startMockOpenAI } from './_mock-openai-server';

const MOCK_PORT = 17937;
const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}/v1`;

let env: SidecarEnv;
let server: ReturnType<typeof startMockOpenAI> | null = null;
let tmpDir = '';
let mcpScriptPath = '';
let capturedToolNames: string[][] = [];

test.beforeAll(() => {
  server = startMockOpenAI(MOCK_PORT, {
    mcpToolCalls: true,
    failAfterToolResult: true,
    fixedReply: '已跳过失败工具，继续给出不依赖该工具的回答。',
    onChatRequest: (body) => {
      const names = (body.tools ?? [])
        .map((item) => {
          if (!item || typeof item !== 'object') return null;
          const fn = (item as { function?: { name?: unknown } }).function;
          return typeof fn?.name === 'string' ? fn.name : null;
        })
        .filter((name): name is string => Boolean(name));
      capturedToolNames.push(names);
    },
  });
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taori-e2e-skip-tool-'));
  mcpScriptPath = path.join(tmpDir, 'failing-mcp-server.mjs');
  fs.writeFileSync(mcpScriptPath, failingMcpServerSource());
  env = readSidecarEnv();
});

test.afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

test.beforeEach(async ({ page }) => {
  capturedToolNames = [];
  await resetSidecar(env);
  await page.addInitScript(() => {
    localStorage.setItem('tip_image_first_seen', 'true');
    localStorage.setItem('tip_fallback_first_seen', 'true');
    localStorage.setItem('tip_cost_first_seen', 'true');
    localStorage.setItem('tip_roundtable_first_seen', 'true');
  });
  await seedToolChatModel();
});

async function seedToolChatModel(): Promise<void> {
  const pr = await authedFetch(env, '/v1/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Skip Tool Mock',
      type: 'openai',
      base_url: MOCK_URL,
      api_key: 'sk-test',
    }),
  });
  expect(pr.ok).toBeTruthy();
  const provider = (await pr.json()) as { id: string };
  const mr = await authedFetch(env, '/v1/models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider_id: provider.id,
      model_name: 'skip-tool-chat',
      capability: 'chat',
      display_name: 'Skip Tool Chat',
      is_default_for: 'chat',
      supports_tools: true,
      price_input_per_1m: 1,
      price_output_per_1m: 2,
    }),
  });
  expect(mr.ok).toBeTruthy();
}

async function addFailingMcpServerFromUi(page: Page): Promise<void> {
  await page.getByTestId('open-settings').click();
  await expect(page.getByTestId('control-center')).toBeVisible();
  await page.getByTestId('settings-tab-tools').click();
  await expect(page.getByTestId('settings-tools')).toBeVisible();
  await page.getByTestId('mcp-server-name').fill('Failing Evidence MCP');
  await page.getByTestId('mcp-server-command').fill(process.execPath);
  await page.getByTestId('mcp-server-args').fill(mcpScriptPath);
  await page.getByTestId('mcp-server-add').click();
  await expect(page.locator('[data-testid^="mcp-server-mcp_"]').first()).toContainText('健康：ok', {
    timeout: 20_000,
  });
  await expect(page.locator('[data-testid^="settings-tool-mcp."]').first()).toBeVisible({
    timeout: 10_000,
  });
  await page.getByTestId('settings-close').click();
  await expect(page.getByTestId('control-center')).toHaveCount(0);
}

test('M2.1 skip_tool recovery continues without adding a user message', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await addFailingMcpServerFromUi(page);

  let recoverBody: { action?: string; tool_name?: string } | null = null;
  await page.route('**/v1/runs/*/recover', async (route) => {
    const raw = route.request().postData();
    recoverBody = raw ? JSON.parse(raw) as { action?: string; tool_name?: string } : null;
    await route.continue();
  });

  await page.getByTestId('composer-input').fill('请使用 MCP 工具获取证据，然后总结。');
  await page.getByTestId('composer-send').click();

  await expect(page.getByTestId('failure-decision-card')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('fdc-skip-tool')).toBeVisible();
  await page.getByTestId('fdc-skip-tool').click();

  await expect(page.getByTestId('failure-decision-card')).toHaveCount(0, { timeout: 30_000 });
  await expect(page.locator('.msg.user')).toHaveCount(1);
  await expect(page.locator('.msg.assistant')).toHaveCount(2);
  await expect(page.locator('.msg.assistant').last()).toContainText('已跳过失败工具', {
    timeout: 30_000,
  });
  await expect.poll(() => recoverBody?.action).toBe('skip_tool');
  expect(recoverBody?.tool_name).toMatch(/^mcp\./);
  expect(capturedToolNames.some((names) => names.some((name) => name.startsWith('mcp_')))).toBe(true);
  expect(capturedToolNames.at(-1)?.some((name) => name.startsWith('mcp_'))).toBe(false);

  const convRes = await authedFetch(env, '/v1/conversations');
  const convBody = (await convRes.json()) as { conversations: Array<{ id: string }> };
  const conversationId = convBody.conversations[0]?.id;
  expect(conversationId).toBeTruthy();
  const runsRes = await authedFetch(env, `/v1/conversations/${conversationId}/runs?limit=5`);
  const runsBody = (await runsRes.json()) as {
    data: { runs: Array<{ recovery_policy: string | null; status: string }> };
  };
  expect(runsBody.data.runs[0]).toMatchObject({
    recovery_policy: 'skip_tool',
    status: 'completed',
  });

  await page.getByTestId('open-run-timeline').click();
  const topRun = page.getByTestId('run-timeline-panel').getByTestId('run-group').first();
  await expect(topRun.locator('[data-testid="run-event"][data-kind="turn.started"]')).toContainText(
    '跳过工具重试开始',
  );
});

function failingMcpServerSource(): string {
  return `
let buffer = Buffer.alloc(0);
function send(id, result) {
  const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result }), 'utf8');
  process.stdout.write('Content-Length: ' + payload.byteLength + '\\r\\n\\r\\n');
  process.stdout.write(payload);
}
function sendError(id, message) {
  const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message } }), 'utf8');
  process.stdout.write('Content-Length: ' + payload.byteLength + '\\r\\n\\r\\n');
  process.stdout.write(payload);
}
function handle(message) {
  if (!message.id) return;
  if (message.method === 'initialize') {
    send(message.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'failing', version: '1' } });
  } else if (message.method === 'tools/list') {
    send(message.id, { tools: [{ name: 'evidence', description: 'Failing Evidence MCP', inputSchema: { type: 'object' } }] });
  } else if (message.method === 'tools/call') {
    sendError(message.id, 'planned MCP tool failure');
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
