import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSidecarEnv, resetSidecar, seedDefaultModel } from './_helpers';

const env = readSidecarEnv();
let tmpDir = '';
let scriptPath = '';

test.beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taori-e2e-mcp-management-'));
  scriptPath = path.join(tmpDir, 'logging-mcp-server.mjs');
  fs.writeFileSync(scriptPath, loggingMcpServerSource());
});

test.afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

test.beforeEach(async () => {
  await resetSidecar(env);
});

test('P2 MCP management: user can connect managed Bocha search without editing raw bridge fields', async ({ page }) => {
  await seedDefaultModel(env);
  await page.addInitScript(() => {
    localStorage.setItem('tip_image_first_seen', 'true');
    localStorage.setItem('tip_fallback_first_seen', 'true');
    localStorage.setItem('tip_cost_first_seen', 'true');
    localStorage.setItem('tip_roundtable_first_seen', 'true');
  });
  await page.goto('/');
  await page.getByTestId('open-settings').click();
  await expect(page.getByTestId('control-center')).toBeVisible();
  await page.getByTestId('settings-tab-tools').click();

  await page.getByTestId('mcp-bocha-api-key').fill('sk-bocha-demo');
  await page.getByTestId('mcp-bocha-save').click();

  const bochaCard = page.getByTestId('settings-search-bocha');
  await expect(bochaCard).toContainText('搏查搜索');
  await expect(page.getByTestId('settings-bocha-status')).toBeVisible({ timeout: 20_000 });
  await expect(bochaCard).toContainText('更新 API Key');
  await expect(page.getByTestId('mcp-server-command')).toHaveValue('');
  await expect(page.getByTestId('mcp-server-args')).toHaveValue('');
  await expect(page.getByTestId('mcp-server-env')).toHaveValue('');
});

test('P2 MCP management: user can inspect, edit, and restart a local MCP server', async ({ page }) => {
  test.setTimeout(90_000);
  await seedDefaultModel(env);
  await page.addInitScript(() => {
    localStorage.setItem('tip_image_first_seen', 'true');
    localStorage.setItem('tip_fallback_first_seen', 'true');
    localStorage.setItem('tip_cost_first_seen', 'true');
    localStorage.setItem('tip_roundtable_first_seen', 'true');
  });
  await page.goto('/');
  await page.getByTestId('open-settings').click();
  await expect(page.getByTestId('control-center')).toBeVisible();
  await page.getByTestId('settings-tab-tools').click();

  await page.getByTestId('mcp-server-name').fill('Inspect MCP');
  await page.getByTestId('mcp-server-command').fill(process.execPath);
  await page.getByTestId('mcp-server-args').fill(scriptPath);
  await page.getByTestId('mcp-server-env').fill('MCP_SAMPLE=1');
  await page.getByTestId('mcp-server-add').click();

  const card = page.locator('[data-testid^="mcp-server-mcp_"]').first();
  await expect(card).toContainText('健康：正常', { timeout: 20_000 });
  await card.getByRole('button', { name: '查看详情' }).click();
  await expect(card.getByTestId(/mcp-server-tools-/)).toContainText('mcp.');
  await expect(card.getByTestId(/mcp-server-logs-/)).toContainText('mock stderr ready');

  await card.getByRole('button', { name: '编辑' }).click();
  await card.getByTestId(/mcp-server-edit-name-/).fill('Inspect MCP Edited');
  await card.getByTestId(/mcp-server-edit-env-/).fill('MCP_SAMPLE=2');
  await card.getByRole('button', { name: '保存并重载' }).click();
  await expect(card).toContainText('Inspect MCP Edited', { timeout: 20_000 });
  await expect(card.getByTestId(/mcp-server-logs-/)).toContainText('session closed');

  await card.getByRole('button', { name: '重启' }).click();
  await expect(card.getByTestId(/mcp-server-logs-/)).toContainText('spawn', { timeout: 20_000 });
});

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
        { name: 'echo', description: 'Echo text', inputSchema: { type: 'object', properties: {}, additionalProperties: true } }
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
