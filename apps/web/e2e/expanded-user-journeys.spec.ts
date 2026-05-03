/**
 * Expanded real-user journeys across chat, settings, monitoring-adjacent state,
 * tools, and model operations. These tests intentionally drive the Web UI; API
 * calls only seed BYOK-style providers/models and verify persisted state.
 */
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

const MOCK_PORT = 17911;
const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}/v1`;

let server: ReturnType<typeof startMockOpenAI> | null = null;
let env: SidecarEnv;

test.beforeAll(() => {
  server = startMockOpenAI(MOCK_PORT, {
    imageToolCalls: true,
    fixedReply: '真实用户旅程回复：已按当前配置处理。',
  });
  env = readSidecarEnv();
});

test.afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
});

test.beforeEach(async () => {
  await resetSidecar(env);
});

async function seedProvider(name = 'Expanded Journey Mock'): Promise<string> {
  const res = await authedFetch(env, '/v1/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name,
      type: 'openai',
      base_url: MOCK_URL,
      api_key: 'sk-test',
    }),
  });
  expect(res.ok).toBeTruthy();
  return ((await res.json()) as { id: string }).id;
}

async function seedModel(
  providerId: string,
  spec: {
    model_name: string;
    display_name: string;
    capability: 'chat' | 'image';
    is_default_for?: 'chat' | 'image' | null;
    price_input_per_1m?: number;
    price_output_per_1m?: number;
    price_per_call?: number;
    supports_tools?: boolean;
    supports_vision?: boolean;
  },
): Promise<string> {
  const res = await authedFetch(env, '/v1/models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider_id: providerId,
      supports_tools: spec.supports_tools ?? false,
      supports_vision: spec.supports_vision ?? false,
      ...spec,
    }),
  });
  expect(res.ok).toBeTruthy();
  return ((await res.json()) as { id: string }).id;
}

async function suppressTips(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('tip_image_first_seen', 'true');
    localStorage.setItem('tip_fallback_first_seen', 'true');
    localStorage.setItem('tip_cost_first_seen', 'true');
    localStorage.setItem('tip_roundtable_first_seen', 'true');
  });
}

async function maybeContinueCostDialog(page: Page): Promise<void> {
  const dialog = page.getByTestId('cost-confirm-dialog');
  try {
    await dialog.waitFor({ state: 'visible', timeout: 1500 });
    await page.getByTestId('cost-confirm-continue').click();
  } catch {
    /* no confirmation needed for this run */
  }
}

async function sendChat(page: Page, text: string): Promise<void> {
  const before = await page.locator('.msg.assistant').count();
  await page.getByTestId('composer-input').fill(text);
  await page.getByTestId('composer-send').click();
  await expect
    .poll(async () => await page.locator('.msg.assistant').count(), {
      timeout: 25_000,
    })
    .toBeGreaterThan(before);
}

test('settings to chat journey: new template and Persona are immediately usable in a multi-turn conversation', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const providerId = await seedProvider('Expanded Prompt Mock');
  await seedModel(providerId, {
    model_name: 'mock-prompt-chat',
    display_name: 'Prompt Chat',
    capability: 'chat',
    is_default_for: 'chat',
    price_input_per_1m: 0.5,
    price_output_per_1m: 1.5,
  });

  await suppressTips(page);
  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  await page.getByTestId('open-settings').click();
  await page.getByTestId('settings-tab-prompts').click();
  await expect(page.getByTestId('settings-prompt-templates')).toBeVisible();

  await page.getByTestId('template-name-input').fill('客户复盘模板');
  await page.getByTestId('template-description-input').fill('复盘客户会议');
  await page
    .getByTestId('template-content-input')
    .fill('请面向 {{客户}} 复盘 {{主题}}，输出风险、承诺和下一次行动。');
  await page.getByTestId('template-save').click();
  await expect(page.getByTestId('template-card').filter({ hasText: '客户复盘模板' })).toBeVisible();

  await page.getByTestId('persona-name-input').fill('客户成功教练');
  await page.getByTestId('persona-description-input').fill('关注客户承诺');
  await page
    .getByTestId('persona-prompt-input')
    .fill('你是客户成功教练，优先识别客户承诺、风险和下一步跟进人。');
  await page.getByTestId('persona-save').click();
  await expect(page.getByTestId('persona-card').filter({ hasText: '客户成功教练' })).toBeVisible();
  await page.getByTestId('settings-close').click();

  await page.getByTestId('open-template-picker').click();
  await page.getByTestId('template-picker-item').filter({ hasText: '客户复盘模板' }).click();
  await expect(page.getByTestId('template-vars-overlay')).toBeVisible();
  await page.getByTestId('template-var-input-客户').fill('Acme');
  await page.getByTestId('template-var-input-主题').fill('旗舰版试点');
  await page.getByTestId('template-vars-apply').click();
  await expect(page.getByTestId('composer-input')).toHaveValue(
    '请面向 Acme 复盘 旗舰版试点，输出风险、承诺和下一次行动。',
  );

  await page.getByTestId('persona-select').selectOption({ label: '客户成功教练' });
  const personaId = await page.getByTestId('persona-select').inputValue();
  expect(personaId).toBeTruthy();

  const firstReq = page.waitForRequest((req) => req.url().endsWith('/v1/chat') && req.method() === 'POST');
  await page.getByTestId('composer-send').click();
  const firstBody = JSON.parse((await firstReq).postData() ?? '{}') as {
    persona_id?: string;
    messages?: Array<{ content?: string }>;
  };
  expect(firstBody.persona_id).toBe(personaId);
  expect(firstBody.messages?.at(-1)?.content).toContain('Acme');
  await expect(page.locator('.msg.assistant').last()).toContainText('真实用户旅程回复', {
    timeout: 20_000,
  });
  await expect(page.getByTestId('persona-memory-scope')).toHaveText('本会话');

  const convId = await page.getByTestId('chat-panel').getAttribute('data-active-conv');
  expect(convId).toBeTruthy();
  const secondReq = page.waitForRequest((req) => req.url().endsWith('/v1/chat') && req.method() === 'POST');
  await page.getByTestId('composer-input').fill('继续补一个下周跟进计划');
  await page.getByTestId('composer-send').click();
  const secondBody = JSON.parse((await secondReq).postData() ?? '{}') as {
    conversation_id?: string;
    persona_id?: string;
  };
  expect(secondBody.conversation_id).toBe(convId);
  expect(secondBody.persona_id).toBe(personaId);
});

test('model operations journey: correcting tool support changes chat guidance and enables image tool use', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const providerId = await seedProvider('Expanded Model Ops Mock');
  const chatId = await seedModel(providerId, {
    model_name: 'mock-needs-tools-correction',
    display_name: 'Needs Tools Correction',
    capability: 'chat',
    is_default_for: 'chat',
    supports_tools: false,
    price_input_per_1m: 0.5,
    price_output_per_1m: 1.5,
  });
  await seedModel(providerId, {
    model_name: 'mock-image-tool-target',
    display_name: 'Image Tool Target',
    capability: 'image',
    is_default_for: 'image',
    price_per_call: 0.01,
  });

  await suppressTips(page);
  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('active-model')).toHaveValue(chatId);
  await expect(page.getByTestId('preflight-image')).toHaveAttribute('data-state', 'warn');
  await expect(page.getByTestId('preflight-image')).toContainText('不支持工具');

  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
  await page.getByTestId('cmd-palette-input').fill('模型中心');
  await page.locator('[data-testid="cmd-result"][data-category="models-center"]').first().click();
  await expect(page.getByTestId('model-center')).toBeVisible();

  await page.getByTestId(`model-edit-${chatId}`).click();
  await expect(page.getByTestId('model-editor')).toBeVisible();
  await page.getByTestId('model-editor-alias').fill('Tool Ready Chat');
  await page.getByTestId('model-editor-supports-tools').check();
  await page.getByTestId('model-editor-save').click();
  await expect(page.getByTestId('model-editor')).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByTestId(`model-row-${chatId}`)).toContainText('Tool Ready Chat');
  await page.getByTestId('settings-close').click();

  await expect(page.getByTestId('active-model')).toHaveValue(chatId);
  await expect(page.getByTestId('active-model')).toContainText('Tool Ready Chat');
  await expect(page.getByTestId('preflight-image')).toHaveAttribute('data-state', 'ready', {
    timeout: 10_000,
  });
  await expect(page.getByTestId('preflight-image')).toContainText('自主调用工具');

  await page.getByTestId('composer-input').fill('请生成一张客户成功复盘海报');
  await page.getByTestId('composer-send').click();
  await maybeContinueCostDialog(page);
  await expect(page.getByTestId('msg-tool-images')).toHaveCount(1, { timeout: 30_000 });
  await expect(page.locator('.msg.assistant').last()).toContainText('真实用户旅程回复', {
    timeout: 20_000,
  });
});

test('data continuity journey: backup restores renamed, pinned, and tagged conversations through the UI', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const providerId = await seedProvider('Expanded Backup Mock');
  await seedModel(providerId, {
    model_name: 'mock-backup-chat',
    display_name: 'Backup Chat',
    capability: 'chat',
    is_default_for: 'chat',
    price_input_per_1m: 0.5,
    price_output_per_1m: 1.5,
  });

  await suppressTips(page);
  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await sendChat(page, '备份恢复用的第一条客户复盘');

  page.once('dialog', (d) => void d.accept('Acme 复盘会话'));
  await page.getByTestId('conv-rename').first().click();
  const firstConv = page.getByTestId('conv-item').filter({ hasText: 'Acme 复盘会话' });
  await expect(firstConv).toBeVisible({ timeout: 10_000 });
  await firstConv.getByTestId('conv-pin').click();
  await firstConv.getByTestId('conv-tag-edit').click();
  await firstConv.getByTestId('conv-tag-input').fill('客户, 重要');
  await firstConv.getByTestId('conv-tag-save').click();
  await expect(firstConv.getByTestId('conv-tag-chip')).toHaveCount(2);

  await page.getByTestId('sidebar-new').click();
  await sendChat(page, '临时会话，导入覆盖后应该消失');
  await expect(page.getByTestId('conv-item')).toHaveCount(2, { timeout: 10_000 });

  await page.getByTestId('open-settings').click();
  await expect(page.getByTestId('settings-danger-zone')).toBeVisible();
  const downloadPromise = page.waitForEvent('download', { timeout: 10_000 });
  await page.getByTestId('settings-export-backup').click();
  const download = await downloadPromise;
  const backupPath = path.join(os.tmpdir(), `taori-expanded-backup-${Date.now()}.json`);
  await download.saveAs(backupPath);

  page.once('dialog', (d) => void d.accept());
  await page.getByTestId('settings-close').click();
  const temporaryConv = page.getByTestId('conv-item').filter({ hasText: '临时会话' });
  await expect(temporaryConv).toBeVisible();
  await temporaryConv.getByTestId('conv-delete').click();
  await expect(page.getByTestId('conv-item')).toHaveCount(1, { timeout: 10_000 });

  await page.getByTestId('open-settings').click();
  await page.getByTestId('settings-import-strategy').selectOption('overwrite');
  await page.getByTestId('settings-import-file').setInputFiles(backupPath);
  await page.waitForLoadState('networkidle');

  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('conv-item')).toHaveCount(2, { timeout: 10_000 });
  const restored = page.getByTestId('conv-item').filter({ hasText: 'Acme 复盘会话' });
  await expect(restored).toBeVisible();
  await expect(restored).toHaveAttribute('data-conv-pinned', 'true');
  await expect(restored.getByTestId('conv-tag-chip')).toHaveCount(2);
  await expect(page.getByTestId('conv-item').filter({ hasText: '临时会话' })).toBeVisible();

  fs.rmSync(backupPath, { force: true });
});
