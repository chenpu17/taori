/**
 * Workflow authoring user journeys.
 *
 * These scenarios cover users creating their own workflow assets from the Web
 * UI, then immediately using and changing those assets inside ongoing chat
 * work. API calls only seed BYOK-style model configuration.
 */
import { test, expect, type Locator, type Page } from '@playwright/test';
import {
  authedFetch,
  readSidecarEnv,
  resetSidecar,
  type SidecarEnv,
} from './_helpers';
import { startMockOpenAI } from './_mock-openai-server';

const MOCK_PORT = 17934;
const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}/v1`;

let server: ReturnType<typeof startMockOpenAI> | null = null;
let env: SidecarEnv;
const mockRequests: Array<{
  model: string;
  messages: Array<{ role: string; content: unknown }>;
}> = [];

test.beforeAll(() => {
  server = startMockOpenAI(MOCK_PORT, {
    fixedReply: '工作流资产验证回复：已按当前模板和角色继续处理。',
    onChatRequest: (body) => {
      mockRequests.push({
        model: body.model,
        messages: body.messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
      });
    },
  });
  env = readSidecarEnv();
});

test.afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
});

test.beforeEach(async ({ page }) => {
  mockRequests.length = 0;
  await resetSidecar(env);
  await suppressTips(page);
});

async function suppressTips(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('tip_image_first_seen', 'true');
    localStorage.setItem('tip_fallback_first_seen', 'true');
    localStorage.setItem('tip_cost_first_seen', 'true');
    localStorage.setItem('tip_roundtable_first_seen', 'true');
  });
}

async function seedDefaultChatModel(): Promise<string> {
  const providerRes = await authedFetch(env, '/v1/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Workflow Authoring Mock',
      type: 'openai',
      base_url: MOCK_URL,
      api_key: 'sk-test',
    }),
  });
  expect(providerRes.ok).toBeTruthy();
  const provider = (await providerRes.json()) as { id: string };
  const modelRes = await authedFetch(env, '/v1/models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider_id: provider.id,
      model_name: 'workflow-authoring-chat',
      display_name: 'Workflow Authoring Chat',
      capability: 'chat',
      is_default_for: 'chat',
      price_input_per_1m: 0.5,
      price_output_per_1m: 1.5,
    }),
  });
  expect(modelRes.ok).toBeTruthy();
  return ((await modelRes.json()) as { id: string }).id;
}

async function openPromptAssets(page: Page): Promise<void> {
  await page.getByTestId('open-settings').click();
  await expect(page.getByTestId('control-center')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('settings-tab-prompts').click();
  await expect(page.getByTestId('settings-prompt-templates')).toBeVisible();
  await expect(page.getByTestId('settings-personas')).toBeVisible();
}

async function createTemplate(
  page: Page,
  name: string,
  content: string,
  description = '用户自定义工作流模板',
): Promise<void> {
  await page.getByTestId('template-name-input').fill(name);
  await page.getByTestId('template-description-input').fill(description);
  await page.getByTestId('template-content-input').fill(content);
  await page.getByTestId('template-save').click();
  await expect(page.getByTestId('template-card').filter({ hasText: name })).toBeVisible({
    timeout: 10_000,
  });
}

async function createPersona(
  page: Page,
  name: string,
  prompt: string,
  description = '用户自定义角色',
): Promise<void> {
  await page.getByTestId('persona-name-input').fill(name);
  await page.getByTestId('persona-description-input').fill(description);
  await page.getByTestId('persona-prompt-input').fill(prompt);
  await page.getByTestId('persona-save').click();
  await expect(page.getByTestId('persona-card').filter({ hasText: name })).toBeVisible({
    timeout: 10_000,
  });
}

async function applyTemplateWithVars(
  page: Page,
  templateName: string,
  answers: Record<string, string>,
): Promise<void> {
  await page.getByTestId('open-template-picker').click();
  await expect(page.getByTestId('template-picker-overlay')).toBeVisible();
  await page.getByTestId('template-picker-item').filter({ hasText: templateName }).click();
  await expect(page.getByTestId('template-vars-overlay')).toBeVisible();
  for (const [name, value] of Object.entries(answers)) {
    await page.getByTestId(`template-var-input-${name}`).fill(value);
  }
  await page.getByTestId('template-vars-apply').click();
  await expect(page.getByTestId('template-vars-overlay')).toHaveCount(0);
}

async function sendAndWait(page: Page, text?: string): Promise<void> {
  const before = await page.locator('.msg.assistant').count();
  if (text != null) await page.getByTestId('composer-input').fill(text);
  await page.getByTestId('composer-send').click();
  await expect
    .poll(async () => await page.locator('.msg.assistant').count(), {
      timeout: 45_000,
    })
    .toBeGreaterThan(before);
  await expect(page.locator('.msg.assistant').last()).toContainText('工作流资产验证回复', {
    timeout: 30_000,
  });
}

async function expectNoHorizontalOverflow(root: Locator): Promise<void> {
  const overflow = await root.evaluate((node) => {
    const rootRect = node.getBoundingClientRect();
    const bad: string[] = [];
    for (const el of node.querySelectorAll<HTMLElement>('*')) {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      if (rect.left < rootRect.left - 1 || rect.right > rootRect.right + 1) {
        bad.push(`${el.tagName.toLowerCase()}.${el.className}`);
      }
    }
    return bad.slice(0, 6);
  });
  expect(overflow).toEqual([]);
}

test('user-authored template and persona can be created, applied, edited, and reused from the Web UI', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await seedDefaultChatModel();

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  await openPromptAssets(page);
  await createTemplate(
    page,
    '发布复盘模板',
    '请以 {{对象}} 视角输出 {{交付物}} 的检查清单。',
  );
  await createPersona(
    page,
    '发布经理',
    '你是发布经理，回答时优先关注上线顺序、风险和可执行检查项。',
  );
  await expectNoHorizontalOverflow(page.getByTestId('control-center'));
  await page.getByTestId('settings-close').click();

  await applyTemplateWithVars(page, '发布复盘模板', {
    '对象': '企业版试点',
    '交付物': '灰度上线',
  });
  await expect(page.getByTestId('composer-input')).toHaveValue(
    '请以 企业版试点 视角输出 灰度上线 的检查清单。',
  );
  await page.getByTestId('persona-select').selectOption({ label: '发布经理' });
  await expect(page.getByTestId('persona-memory-scope')).toHaveText('待绑定');
  await sendAndWait(page);
  await expect(page.getByTestId('persona-memory-scope')).toHaveText('本会话');
  await expect(page.getByTestId('session-profile-persona')).toContainText('发布经理');

  const firstRequest = mockRequests.at(-1);
  expect(firstRequest?.messages.some((m) =>
    m.role === 'system' &&
    typeof m.content === 'string' &&
    m.content.includes('你是发布经理'),
  )).toBe(true);
  expect(firstRequest?.messages.at(-1)?.content).toContain('灰度上线');

  await openPromptAssets(page);
  const templateCard = page.getByTestId('template-card').filter({ hasText: '发布复盘模板' });
  await templateCard.getByTestId('template-edit').click();
  await page.getByTestId('template-content-input').fill(
    '新版模板：请围绕 {{对象}} 生成 {{交付物}} 的验收步骤。',
  );
  await page.getByTestId('template-save').click();
  await expect(templateCard).toContainText('新版模板', { timeout: 10_000 });
  await page.getByTestId('settings-close').click();

  await applyTemplateWithVars(page, '发布复盘模板', {
    '对象': '付费转化实验',
    '交付物': '上线前清单',
  });
  await expect(page.getByTestId('composer-input')).toHaveValue(
    '新版模板：请围绕 付费转化实验 生成 上线前清单 的验收步骤。',
  );
});

test('deleting the active persona invalidates the visible selection before the next chat turn', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await seedDefaultChatModel();

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await openPromptAssets(page);
  await createPersona(
    page,
    '临时风险官',
    '你是临时风险官，只在这个验证场景里使用。',
  );
  await page.getByTestId('settings-close').click();

  await page.getByTestId('persona-select').selectOption({ label: '临时风险官' });
  await sendAndWait(page, '先用临时 Persona 给一个风险判断');
  const convId = await page.getByTestId('chat-panel').getAttribute('data-active-conv');
  expect(convId).toBeTruthy();
  await expect(page.getByTestId('persona-memory-scope')).toHaveText('本会话');

  await openPromptAssets(page);
  const personaCard = page.getByTestId('persona-card').filter({ hasText: '临时风险官' });
  page.once('dialog', (dialog) => void dialog.accept());
  await personaCard.getByTestId('persona-delete').click();
  await expect(page.getByTestId('persona-card').filter({ hasText: '临时风险官' })).toHaveCount(0, {
    timeout: 10_000,
  });
  await page.getByTestId('settings-close').click();

  await expect(page.getByTestId('persona-select')).toHaveValue('');
  await expect(page.getByTestId('persona-memory-scope')).toHaveText('未绑定');
  await expect(page.getByTestId('session-profile-persona')).toContainText('无');

  const before = mockRequests.length;
  await sendAndWait(page, '删除 Persona 后继续这个会话，不应该再带旧 persona_id');
  expect(mockRequests.length).toBeGreaterThan(before);
  const lastRequest = mockRequests.at(-1);
  expect(lastRequest?.messages.some((m) =>
    m.role === 'system' &&
    typeof m.content === 'string' &&
    m.content.includes('临时风险官'),
  )).toBe(false);
  await expect(page.getByTestId('chat-panel')).toHaveAttribute('data-active-conv', convId!);
});
