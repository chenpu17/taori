import { test, expect } from '@playwright/test';
import {
  authedFetch,
  readSidecarEnv,
  resetSidecar,
  type SidecarEnv,
} from './_helpers';
import { startMockOpenAI } from './_mock-openai-server';

const MOCK_PORT = 17899;
const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}/v1`;

let server: ReturnType<typeof startMockOpenAI> | null = null;
let env: SidecarEnv;

test.beforeAll(async () => {
  server = startMockOpenAI(MOCK_PORT);
  env = readSidecarEnv();
});

test.afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
});

async function seedDefaultChatModel(): Promise<void> {
  const pr = await authedFetch(env, '/v1/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'C3 mock',
      type: 'openai',
      base_url: MOCK_URL,
      api_key: 'sk-test',
    }),
  });
  const provider = (await pr.json()) as { id: string };
  await authedFetch(env, '/v1/models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider_id: provider.id,
      model_name: 'mock-default',
      capability: 'chat',
      display_name: 'Mock Default',
      is_default_for: 'chat',
      price_input_per_1m: 0.5,
      price_output_per_1m: 1.5,
    }),
  });
}

test('C3 模板可在套用前填空并写入 composer', async ({ page }) => {
  await resetSidecar(env);
  await seedDefaultChatModel();

  await authedFetch(env, '/v1/prompt-templates', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: '分析模板',
      description: '测试变量填空',
      content: '请从 {{行业}} 的角度分析 {{问题}}，给出 3 条建议。',
    }),
  });

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('open-template-picker').click();
  await expect(page.getByTestId('template-picker-overlay')).toBeVisible();
  await page.getByTestId('template-picker-item').first().click();
  await expect(page.getByTestId('template-vars-overlay')).toBeVisible();
  await page.getByTestId('template-var-input-行业').fill('SaaS');
  await page.getByTestId('template-var-input-问题').fill('续费流失');
  await expect(page.getByTestId('template-var-preview')).toContainText(
    '请从 SaaS 的角度分析 续费流失，给出 3 条建议。',
  );
  await page.getByTestId('template-vars-apply').click();
  await expect(page.getByTestId('composer-input')).toHaveValue(
    '请从 SaaS 的角度分析 续费流失，给出 3 条建议。',
  );
});

test('C3 Persona 可在首轮会话绑定，并在切回会话后恢复', async ({ page }) => {
  await resetSidecar(env);
  await seedDefaultChatModel();

  const personaRes = await authedFetch(env, '/v1/personas', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: '严格评审',
      description: '偏风险视角',
      prompt: '你是一位严格的架构评审，优先指出边界、风险与回滚路径。',
    }),
  });
  const persona = (await personaRes.json()) as { id: string };

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('persona-select').selectOption(persona.id);
  await expect(page.getByTestId('persona-memory-scope')).toHaveText('待绑定');
  await page.getByTestId('composer-input').fill('请评审这个迁移方案');
  await page.getByTestId('composer-send').click();
  await expect(page.getByTestId('streaming-indicator')).toHaveCount(0, {
    timeout: 30_000,
  });
  await expect(page.getByTestId('persona-memory-scope')).toHaveText('本会话');

  const convId = await page.getByTestId('chat-panel').getAttribute('data-active-conv');
  expect(convId).toBeTruthy();

  const memoryRes = await authedFetch(
    env,
    `/v1/memories?scope=session&scope_id=${encodeURIComponent(convId!)}&key=active_persona_id`,
  );
  const memoryBody = (await memoryRes.json()) as {
    data: { value: string | null };
  };
  expect(memoryBody.data.value).toBe(persona.id);

  await page.getByTestId('sidebar-new').click();
  await page.locator('[data-testid="conv-item"]').first().click();
  await expect(page.getByTestId('persona-select')).toHaveValue(persona.id);
  await expect(page.getByTestId('persona-memory-scope')).toHaveText('本会话');
});

test('C3 待绑定 Persona 在刷新后仍保留，并继续绑定到首轮会话', async ({ page }) => {
  await resetSidecar(env);
  await seedDefaultChatModel();

  const personaRes = await authedFetch(env, '/v1/personas', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'OpenClaw 风格',
      description: '行动导向',
      prompt: '你是一位少废话、有判断、行动优先的个人助手。',
    }),
  });
  const persona = (await personaRes.json()) as { id: string };

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('persona-select').selectOption(persona.id);
  await expect(page.getByTestId('persona-memory-scope')).toHaveText('待绑定');

  await page.reload();
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('persona-select')).toHaveValue(persona.id);
  await expect(page.getByTestId('persona-memory-scope')).toHaveText('待绑定');

  await page.getByTestId('composer-input').fill('刷新后继续发送首条消息');
  await page.getByTestId('composer-send').click();
  await expect(page.getByTestId('streaming-indicator')).toHaveCount(0, {
    timeout: 30_000,
  });
  await expect(page.getByTestId('persona-memory-scope')).toHaveText('本会话');
});
