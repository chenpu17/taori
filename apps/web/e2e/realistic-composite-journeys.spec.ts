/**
 * Realistic composite journeys that chain multiple user-facing features.
 *
 * These are intentionally not API-only checks: each flow drives the Web UI and
 * lets the renderer talk to the isolated sidecar the same way the desktop app
 * does. The API calls here only seed BYOK-style configuration and verify
 * persisted state after the visible interaction has completed.
 */
import { test, expect } from '@playwright/test';
import {
  authedFetch,
  readSidecarEnv,
  resetSidecar,
  type SidecarEnv,
} from './_helpers';
import { startMockOpenAI } from './_mock-openai-server';

const MOCK_PORT = 17908;
const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}/v1`;

let server: ReturnType<typeof startMockOpenAI> | null = null;
let env: SidecarEnv;

test.beforeAll(() => {
  server = startMockOpenAI(MOCK_PORT, {
    fixedReply: '收到，我会按当前 Persona 和上下文继续处理。',
  });
  env = readSidecarEnv();
});

test.afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
});

test.beforeEach(async () => {
  await resetSidecar(env);
});

async function seedProvider(name = 'Composite Mock'): Promise<string> {
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

async function forceCostConfirm(): Promise<void> {
  await authedFetch(env, '/v1/memories', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      scope: 'global',
      scope_id: null,
      key: 'cost_confirm_threshold_usd',
      value: '0.0000000001',
    }),
  });
}

test('template + persona + cost gate: user switches to cheaper model and continues the same work thread', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const providerId = await seedProvider('Composite Cost Mock');
  const expensiveId = await seedModel(providerId, {
    model_name: 'mock-expensive-planner',
    display_name: 'Expensive Planner',
    capability: 'chat',
    is_default_for: 'chat',
    price_input_per_1m: 100,
    price_output_per_1m: 200,
  });
  const cheapId = await seedModel(providerId, {
    model_name: 'mock-cheap-reviewer',
    display_name: 'Cheap Reviewer',
    capability: 'chat',
    price_input_per_1m: 0.1,
    price_output_per_1m: 0.2,
  });
  await forceCostConfirm();

  await authedFetch(env, '/v1/prompt-templates', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: '上线评审模板',
      description: '把真实业务问题转成评审请求',
      content: '请用 {{角色}} 视角评审 {{主题}}，输出风险和下一步。',
    }),
  });
  const personaRes = await authedFetch(env, '/v1/personas', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: '风险评审官',
      description: '优先识别风险',
      prompt: '你是一名风险评审官，先指出不确定性，再给出可执行建议。',
    }),
  });
  const persona = (await personaRes.json()) as { id: string };

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('active-model')).toHaveValue(expensiveId);

  await page.getByTestId('open-template-picker').click();
  await page.getByTestId('template-picker-item').first().click();
  await expect(page.getByTestId('template-vars-overlay')).toBeVisible();
  await page.getByTestId('template-var-input-角色').fill('产品经理');
  await page.getByTestId('template-var-input-主题').fill('多模型 fallback 上线');
  await page.getByTestId('template-vars-apply').click();
  await expect(page.getByTestId('composer-input')).toHaveValue(
    '请用 产品经理 视角评审 多模型 fallback 上线，输出风险和下一步。',
  );

  await page.getByTestId('persona-select').selectOption(persona.id);
  await expect(page.getByTestId('persona-memory-scope')).toHaveText('待绑定');

  const chatReq = page.waitForRequest((req) => req.url().endsWith('/v1/chat') && req.method() === 'POST');
  await page.getByTestId('composer-send').click();
  await expect(page.getByTestId('cost-confirm-dialog')).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId('cost-confirm-cheaper')).toBeEnabled();
  await page.getByTestId('cost-confirm-cheaper').click();
  const firstBody = JSON.parse((await chatReq).postData() ?? '{}') as {
    model_id?: string;
    persona_id?: string;
    messages?: Array<{ content?: string }>;
  };
  expect(firstBody.model_id).toBe(cheapId);
  expect(firstBody.persona_id).toBe(persona.id);
  expect(firstBody.messages?.at(-1)?.content).toContain('多模型 fallback 上线');

  await expect(page.locator('.msg.assistant').last()).toContainText('收到，我会按当前 Persona', {
    timeout: 20_000,
  });
  await expect(page.getByTestId('active-model')).toHaveValue(cheapId);
  await expect(page.getByTestId('persona-memory-scope')).toHaveText('本会话');

  const convId = await page.getByTestId('chat-panel').getAttribute('data-active-conv');
  expect(convId).toBeTruthy();
  const personaMemory = await authedFetch(
    env,
    `/v1/memories?scope=session&scope_id=${encodeURIComponent(convId!)}&key=active_persona_id`,
  ).then((r) => r.json() as Promise<{ data: { value: string | null } }>);
  expect(personaMemory.data.value).toBe(persona.id);

  await page.getByTestId('composer-input').fill('继续补充上线前的验收清单');
  await page.getByTestId('composer-send').click();
  await expect(page.getByTestId('cost-confirm-dialog')).toBeVisible({ timeout: 5_000 });
  const secondReq = page.waitForRequest((req) => req.url().endsWith('/v1/chat') && req.method() === 'POST');
  await page.getByTestId('cost-confirm-continue').click();
  const secondBody = JSON.parse((await secondReq).postData() ?? '{}') as {
    model_id?: string;
    conversation_id?: string;
    persona_id?: string;
  };
  expect(secondBody.model_id).toBe(cheapId);
  expect(secondBody.conversation_id).toBe(convId);
  expect(secondBody.persona_id).toBe(persona.id);
  await expect(page.locator('.msg.assistant').last()).toContainText('收到，我会按当前 Persona', {
    timeout: 20_000,
  });
});

test('image workflow: session image-model memory skips picker on the next explicit image request', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const providerId = await seedProvider('Composite Image Mock');
  await seedModel(providerId, {
    model_name: 'mock-chat',
    display_name: 'Chat',
    capability: 'chat',
    is_default_for: 'chat',
    price_input_per_1m: 0.5,
    price_output_per_1m: 1.5,
  });
  const imageId = await seedModel(providerId, {
    model_name: 'mock-image',
    display_name: 'Image',
    capability: 'image',
    is_default_for: 'image',
    price_per_call: 0.04,
  });

  await page.route('**/v1/tools/invoke', async (route) => {
    await route.continue({
      headers: {
        ...route.request().headers(),
        'x-test-force-image-result': 'success',
      },
    });
  });

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  await page.getByTestId('composer-input').fill('/image 生成第一张产品海报');
  await page.getByTestId('composer-send').click();
  const picker = page.getByTestId('image-picker-dialog');
  await expect(picker).toBeVisible({ timeout: 10_000 });
  await expect(picker.getByTestId(`image-model-radio-${imageId}`)).toBeChecked();
  await picker.getByTestId('image-memory-session').check();
  await picker.getByTestId('image-picker-submit').click();
  await expect(page.getByTestId('cost-confirm-dialog')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('cost-confirm-continue').click();
  await expect(page.getByTestId('msg-tool-images')).toHaveCount(1, { timeout: 20_000 });

  const convId = await page.getByTestId('chat-panel').getAttribute('data-active-conv');
  expect(convId).toBeTruthy();
  const imageMemory = await authedFetch(
    env,
    `/v1/memories?scope=session&scope_id=${encodeURIComponent(convId!)}&key=image_model`,
  ).then((r) => r.json() as Promise<{ data: { value: string | null } }>);
  expect(imageMemory.data.value).toBe(imageId);

  await page.getByTestId('composer-input').fill('/image 再生成一张横版封面');
  await page.getByTestId('composer-send').click();
  await expect(page.getByTestId('image-picker-dialog')).toHaveCount(0);
  await expect(page.getByTestId('cost-confirm-dialog')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('cost-confirm-continue').click();
  await expect(page.getByTestId('msg-tool-images')).toHaveCount(2, { timeout: 20_000 });
  await expect(page.getByTestId('chat-panel')).toHaveAttribute('data-active-conv', convId!);
});

test('image workflow: session memory is isolated from new chats and restored when returning', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const providerId = await seedProvider('Composite Image Isolation Mock');
  await seedModel(providerId, {
    model_name: 'mock-chat',
    display_name: 'Chat',
    capability: 'chat',
    is_default_for: 'chat',
    price_input_per_1m: 0.5,
    price_output_per_1m: 1.5,
  });
  const imageId = await seedModel(providerId, {
    model_name: 'mock-image',
    display_name: 'Image',
    capability: 'image',
    is_default_for: 'image',
    price_per_call: 0.04,
  });

  await page.route('**/v1/tools/invoke', async (route) => {
    await route.continue({
      headers: {
        ...route.request().headers(),
        'x-test-force-image-result': 'success',
      },
    });
  });

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  await page.getByTestId('composer-input').fill('/image 会话 A 的第一张图');
  await page.getByTestId('composer-send').click();
  const firstPicker = page.getByTestId('image-picker-dialog');
  await expect(firstPicker).toBeVisible({ timeout: 10_000 });
  await expect(firstPicker.getByTestId(`image-model-radio-${imageId}`)).toBeChecked();
  await firstPicker.getByTestId('image-memory-session').check();
  await firstPicker.getByTestId('image-picker-submit').click();
  await expect(page.getByTestId('cost-confirm-dialog')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('cost-confirm-continue').click();
  await expect(page.getByTestId('msg-tool-images')).toHaveCount(1, { timeout: 20_000 });

  const convA = await page.getByTestId('chat-panel').getAttribute('data-active-conv');
  expect(convA).toBeTruthy();

  await page.getByTestId('sidebar-new').click();
  await expect(page.getByTestId('chat-panel')).toHaveAttribute('data-active-conv', '');
  await page.getByTestId('composer-input').fill('/image 会话 B 的第一张图');
  await page.getByTestId('composer-send').click();
  const secondPicker = page.getByTestId('image-picker-dialog');
  await expect(secondPicker).toBeVisible({ timeout: 10_000 });
  await secondPicker.getByTestId('image-picker-cancel').click();
  await expect(secondPicker).toHaveCount(0);

  await page.locator(`[data-testid="conv-item"][data-conv-id="${convA}"]`).click();
  await expect(page.getByTestId('chat-panel')).toHaveAttribute('data-active-conv', convA!);
  await page.getByTestId('composer-input').fill('/image 回到会话 A 的第二张图');
  await page.getByTestId('composer-send').click();
  await expect(page.getByTestId('image-picker-dialog')).toHaveCount(0);
  await expect(page.getByTestId('cost-confirm-dialog')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('cost-confirm-continue').click();
  await expect(page.getByTestId('msg-tool-images')).toHaveCount(2, { timeout: 20_000 });
});

test('tool settings journey: disabling and re-enabling image generation updates chat guidance', async ({
  page,
}) => {
  const providerId = await seedProvider('Composite Tool Toggle Mock');
  await seedModel(providerId, {
    model_name: 'mock-tool-chat',
    display_name: 'Tool Chat',
    capability: 'chat',
    is_default_for: 'chat',
    supports_tools: true,
    price_input_per_1m: 0.5,
    price_output_per_1m: 1.5,
  });
  await seedModel(providerId, {
    model_name: 'mock-image',
    display_name: 'Image',
    capability: 'image',
    is_default_for: 'image',
    price_per_call: 0.04,
  });

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('preflight-image')).toHaveAttribute('data-state', 'ready');
  await expect(page.getByTestId('preflight-image')).toContainText('自主调用工具');

  await page.getByTestId('open-settings').click();
  await page.getByTestId('settings-tab-tools').click();
  const toggle = page.getByTestId('tool-toggle-builtin.image_generate');
  await expect(toggle).toContainText('已启用');
  await toggle.click();
  await expect(toggle).toContainText('已关闭');
  await page.getByTestId('settings-close').click();

  await expect(page.getByTestId('preflight-image')).toHaveAttribute('data-state', 'warn');
  await expect(page.getByTestId('preflight-image')).toContainText('工具已关闭');

  await page.getByTestId('composer-input').fill('/image 生成一张关闭工具后的测试图');
  await page.getByTestId('composer-send').click();
  await expect(page.getByTestId('image-picker-dialog')).toHaveCount(0);
  await expect(page.getByTestId('drop-error')).toContainText('图像生成工具已关闭', {
    timeout: 10_000,
  });

  await page.getByTestId('open-settings').click();
  await page.getByTestId('settings-tab-tools').click();
  await toggle.click();
  await expect(toggle).toContainText('已启用');
  await page.getByTestId('settings-close').click();

  await expect(page.getByTestId('preflight-image')).toHaveAttribute('data-state', 'ready');
  await expect(page.getByTestId('preflight-image')).toContainText('自主调用工具');
  await page.getByTestId('composer-input').fill('/image 生成一张重新启用后的测试图');
  await page.getByTestId('composer-send').click();
  await expect(page.getByTestId('image-picker-dialog')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('image-picker-cancel').click();
  await expect(page.getByTestId('image-picker-dialog')).toHaveCount(0);
});

test('danger-zone journey: clearing all data resets in-memory tool toggles before fresh setup', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const providerId = await seedProvider('Composite Clear Reset Mock');
  await seedModel(providerId, {
    model_name: 'mock-tool-chat',
    display_name: 'Tool Chat',
    capability: 'chat',
    is_default_for: 'chat',
    supports_tools: true,
    price_input_per_1m: 0.5,
    price_output_per_1m: 1.5,
  });
  await seedModel(providerId, {
    model_name: 'mock-image',
    display_name: 'Image',
    capability: 'image',
    is_default_for: 'image',
    price_per_call: 0.04,
  });

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('open-settings').click();
  await page.getByTestId('settings-tab-tools').click();
  const toggle = page.getByTestId('tool-toggle-builtin.image_generate');
  await expect(toggle).toContainText('已启用');
  await toggle.click();
  await expect(toggle).toContainText('已关闭');
  await page.getByTestId('settings-close').click();
  await expect(page.getByTestId('preflight-image')).toHaveAttribute('data-state', 'warn');

  page.on('dialog', (dialog) => void dialog.accept());
  await page.getByTestId('open-settings').click();
  await page.getByTestId('settings-tab-general').click();
  await page.getByTestId('settings-danger-arm').check();
  await page.getByTestId('settings-clear-all').click();
  await expect(page.getByTestId('onboarding')).toBeVisible({ timeout: 15_000 });

  const freshProviderId = await seedProvider('Composite Fresh Setup Mock');
  await seedModel(freshProviderId, {
    model_name: 'mock-tool-chat-fresh',
    display_name: 'Fresh Tool Chat',
    capability: 'chat',
    is_default_for: 'chat',
    supports_tools: true,
    price_input_per_1m: 0.5,
    price_output_per_1m: 1.5,
  });
  await seedModel(freshProviderId, {
    model_name: 'mock-image-fresh',
    display_name: 'Fresh Image',
    capability: 'image',
    is_default_for: 'image',
    price_per_call: 0.04,
  });

  await page.reload();
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('preflight-image')).toHaveAttribute('data-state', 'ready');
  await expect(page.getByTestId('preflight-image')).toContainText('自主调用工具');
});
