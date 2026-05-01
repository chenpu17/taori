/**
 * User-journey regressions for issues that escaped isolated feature tests.
 *
 * These specs intentionally exercise complete user narratives:
 *   - natural-language image request → LLM tool call → inline image → reload
 *   - existing chat → roundtable → conclusion loopback → same chat refreshed
 */
import { test, expect, type Page } from '@playwright/test';
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

test.beforeAll(() => {
  server = startMockOpenAI(MOCK_PORT, { imageToolCalls: true });
  env = readSidecarEnv();
});

test.afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
});

test.beforeEach(async () => {
  await resetSidecar(env);
});

async function seedProvider(): Promise<string> {
  const pr = await authedFetch(env, '/v1/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Journey Mock',
      type: 'openai',
      base_url: MOCK_URL,
      api_key: 'sk-test',
    }),
  });
  expect(pr.ok).toBeTruthy();
  return ((await pr.json()) as { id: string }).id;
}

async function seedModel(
  providerId: string,
  spec: {
    model_name: string;
    display_name: string;
    capability: 'chat' | 'image';
    is_default_for?: 'chat' | 'image';
    supports_tools?: boolean;
    supports_vision?: boolean;
    price_per_call?: number;
  },
): Promise<string> {
  const mr = await authedFetch(env, '/v1/models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider_id: providerId,
      price_input_per_1m: spec.capability === 'chat' ? 0.5 : undefined,
      price_output_per_1m: spec.capability === 'chat' ? 1.5 : undefined,
      supports_vision: spec.supports_vision ?? false,
      ...spec,
    }),
  });
  expect(mr.ok).toBeTruthy();
  return ((await mr.json()) as { id: string }).id;
}

async function seedToolImageStack(): Promise<void> {
  const providerId = await seedProvider();
  await seedModel(providerId, {
    model_name: 'mock-tool-chat',
    display_name: 'Tool Chat',
    capability: 'chat',
    is_default_for: 'chat',
    supports_tools: true,
  });
  await seedModel(providerId, {
    model_name: 'mock-image',
    display_name: 'Mock Image',
    capability: 'image',
    is_default_for: 'image',
    price_per_call: 0.04,
  });
}

async function seedMixedToolImageStack(): Promise<{
  toolChatId: string;
  plainChatId: string;
}> {
  const providerId = await seedProvider();
  const toolChatId = await seedModel(providerId, {
    model_name: 'mock-tool-chat',
    display_name: 'Tool Chat',
    capability: 'chat',
    is_default_for: 'chat',
    supports_tools: true,
  });
  const plainChatId = await seedModel(providerId, {
    model_name: 'mock-plain-chat',
    display_name: 'Plain Chat',
    capability: 'chat',
    supports_tools: false,
  });
  await seedModel(providerId, {
    model_name: 'mock-image',
    display_name: 'Mock Image',
    capability: 'image',
    is_default_for: 'image',
    price_per_call: 0.04,
  });
  return { toolChatId, plainChatId };
}

async function seedToolImageVisionStack(): Promise<{
  toolChatId: string;
  visionChatId: string;
}> {
  const providerId = await seedProvider();
  const toolChatId = await seedModel(providerId, {
    model_name: 'mock-tool-chat',
    display_name: 'Tool Chat',
    capability: 'chat',
    is_default_for: 'chat',
    supports_tools: true,
  });
  const visionChatId = await seedModel(providerId, {
    model_name: 'mock-vision-chat',
    display_name: 'Vision Chat',
    capability: 'chat',
    supports_vision: true,
  });
  await seedModel(providerId, {
    model_name: 'mock-image',
    display_name: 'Mock Image',
    capability: 'image',
    is_default_for: 'image',
    price_per_call: 0.04,
  });
  return { toolChatId, visionChatId };
}

async function seedRoundtableStack(): Promise<void> {
  const providerId = await seedProvider();
  for (let i = 0; i < 3; i++) {
    await seedModel(providerId, {
      model_name: `mock-round-${i}`,
      display_name: `Round ${i}`,
      capability: 'chat',
      ...(i === 0 ? { is_default_for: 'chat' as const } : {}),
    });
  }
}

async function findConversationContaining(text: string): Promise<string> {
  const convsRes = await authedFetch(env, '/v1/conversations');
  const convs = (await convsRes.json()) as {
    conversations: Array<{ id: string }>;
  };
  for (const conv of convs.conversations) {
    const msgsRes = await authedFetch(env, `/v1/conversations/${conv.id}/messages`);
    const msgs = (await msgsRes.json()) as {
      messages: Array<{ content: string | null }>;
    };
    if (msgs.messages.some((m) => (m.content ?? '').includes(text))) {
      return conv.id;
    }
  }
  throw new Error(`conversation containing "${text}" not found`);
}

async function clickConversation(page: Page, id: string): Promise<void> {
  await page.locator(`[data-testid="conv-item"][data-conv-id="${id}"]`).click();
}

test('natural-language image request uses LLM tool call, not the picker, and survives reload', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await seedToolImageStack();

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('preflight-image')).toHaveAttribute('data-state', 'ready');

  await page.getByTestId('composer-input').fill('帮我生成一张可爱鸭鸭的图片');
  await page.getByTestId('composer-send').click();

  await expect(page.getByTestId('image-picker-dialog')).toHaveCount(0);
  await expect(page.getByTestId('msg-tool-images')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.msg.assistant').last()).toContainText('图片已生成', {
    timeout: 10_000,
  });

  const cid = await findConversationContaining('帮我生成一张可爱鸭鸭的图片');
  const msgsRes = await authedFetch(env, `/v1/conversations/${cid}/messages`);
  const msgs = (await msgsRes.json()) as {
    messages: Array<{ role: string; image_attachments?: unknown[] }>;
  };
  const assistantWithImage = msgs.messages.find(
    (m) => m.role === 'assistant' && (m.image_attachments?.length ?? 0) > 0,
  );
  expect(assistantWithImage).toBeTruthy();

  await page.reload();
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await clickConversation(page, cid);
  await expect(page.getByTestId('msg-tool-images')).toBeVisible({ timeout: 20_000 });
});

test('English image request uses the LLM tool path without opening the picker', async ({
  page,
}) => {
  await seedToolImageStack();

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  await page.getByTestId('composer-input').fill('Generate an image of a cute duck');
  await page.getByTestId('composer-send').click();

  await expect(page.getByTestId('image-picker-dialog')).toHaveCount(0);
  await expect(page.getByTestId('msg-tool-images')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.msg.assistant').last()).toContainText('图片已生成', {
    timeout: 10_000,
  });
});

test('negative image wording stays on normal chat and does not invoke image UI', async ({
  page,
}) => {
  await seedToolImageStack();

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  await page.getByTestId('composer-input').fill('不要生成图片，只解释一下鸭子的形态特征');
  await page.getByTestId('composer-send').click();

  await expect(page.getByTestId('image-picker-dialog')).toHaveCount(0);
  await expect(page.locator('.msg.assistant').last()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('msg-tool-images')).toHaveCount(0);
});

test('switching tool support updates image guidance and keeps natural image routing model-driven', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const { toolChatId, plainChatId } = await seedMixedToolImageStack();

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('active-model')).toHaveValue(toolChatId);
  await expect(page.getByTestId('preflight-image')).toHaveAttribute('data-state', 'ready');
  await expect(page.getByTestId('preflight-image')).toContainText('自主调用工具');

  await page.getByTestId('active-model').selectOption(plainChatId);
  await expect(page.getByTestId('preflight-image')).toHaveAttribute('data-state', 'warn');
  await expect(page.getByTestId('preflight-image')).toContainText('/image');

  await page.getByTestId('composer-input').fill('帮我生成一张可爱鸭鸭的图片');
  await page.getByTestId('composer-send').click();
  await expect(page.getByTestId('image-picker-dialog')).toHaveCount(0);
  await expect(page.locator('.msg.assistant').last()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('msg-tool-images')).toHaveCount(0);

  await page.getByTestId('active-model').selectOption(toolChatId);
  await expect(page.getByTestId('preflight-image')).toHaveAttribute('data-state', 'ready');
  await expect(page.getByTestId('preflight-image')).toContainText('自主调用工具');
  await page.getByTestId('composer-input').fill('Generate an image of a cute duck');
  await page.getByTestId('composer-send').click();
  await expect(page.getByTestId('image-picker-dialog')).toHaveCount(0);
  await expect(page.getByTestId('msg-tool-images')).toBeVisible({ timeout: 30_000 });
});

test('explicit image command remains available when the chat model has no tool support', async ({
  page,
}) => {
  const { plainChatId } = await seedMixedToolImageStack();

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('active-model').selectOption(plainChatId);
  await expect(page.getByTestId('preflight-image')).toHaveAttribute('data-state', 'warn');

  await page.getByTestId('composer-input').fill('/image 画一张可爱鸭鸭的图片');
  await page.getByTestId('composer-send').click();

  const dialog = page.getByTestId('image-picker-dialog');
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await expect(dialog.getByTestId('image-picker-submit')).toBeEnabled();
  await dialog.getByTestId('image-picker-cancel').click();
  await expect(dialog).toHaveCount(0);
});

test('generated image can be attached back into the composer and understood by a vision model', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const { toolChatId, visionChatId } = await seedToolImageVisionStack();

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('active-model')).toHaveValue(toolChatId);

  await page.getByTestId('composer-input').fill('帮我生成一张可爱鸭鸭的图片');
  await page.getByTestId('composer-send').click();
  await expect(page.getByTestId('image-picker-dialog')).toHaveCount(0);
  await expect(page.getByTestId('msg-tool-images')).toBeVisible({ timeout: 30_000 });

  await page.getByTestId('tool-image-understand').click();
  await expect(page.getByTestId('attachment-thumb')).toHaveAttribute('data-kind', 'image');
  await expect(page.getByTestId('active-model')).toHaveValue(visionChatId);
  await expect(page.getByTestId('drop-error')).toContainText('已自动切换至视觉模型');
  await expect(page.getByTestId('composer-input')).toHaveValue(/请理解这张图片/);
  await expect(page.getByTestId('composer-send')).toBeEnabled();

  await page.getByTestId('composer-send').click();
  await expect(page.getByTestId('attachments-bar')).toHaveCount(0, { timeout: 10_000 });
  await expect(page.locator('.msg.assistant').last()).toContainText('我看到了这张图片', {
    timeout: 30_000,
  });
});

test('roundtable launched from an existing chat writes back into that chat and refreshes visible history', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await seedRoundtableStack();

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  await page.getByTestId('composer-input').fill('旅程基线：先聊一下 SaaS 定价');
  await page.getByTestId('composer-send').click();
  await expect(page.locator('.msg.assistant').first()).toBeVisible({ timeout: 20_000 });

  const originalCid = await findConversationContaining('旅程基线：先聊一下 SaaS 定价');
  await page.getByTestId('composer-input').fill('A4 回写回归：如何选择 SaaS 计费模型？');
  await page.getByTestId('composer-roundtable').click();

  const dlg = page.getByTestId('roundtable-launch-dialog');
  await expect(dlg).toBeVisible({ timeout: 10_000 });
  await dlg.getByTestId('roundtable-mode-select').selectOption('fast');
  await dlg.getByTestId('roundtable-launch-start').click();
  await expect(dlg.getByTestId('roundtable-preview')).toBeVisible({ timeout: 30_000 });
  await dlg.getByTestId('roundtable-launch-continue').click();

  const panel = page.getByTestId('roundtable-panel');
  await expect(panel).toBeVisible({ timeout: 15_000 });
  await panel.getByTestId('roundtable-action-start-round').click();
  await expect(panel.getByTestId('roundtable-cell-0-1')).toHaveClass(
    /roundtable-cell-complete/,
    { timeout: 60_000 },
  );

  const summary = panel.getByTestId('roundtable-summary');
  const summarize = panel.getByTestId('roundtable-action-summarize');
  const summarizeNow = panel.getByTestId('roundtable-action-summarize-now');
  await expect
    .poll(
      async () =>
        (await summary.count()) > 0 ||
        (await summarize.count()) > 0 ||
        (await summarizeNow.count()) > 0,
      { timeout: 30_000 },
    )
    .toBe(true);
  if ((await summary.count()) === 0) {
    if ((await summarize.count()) > 0) await summarize.click();
    else await summarizeNow.click();
  }
  await expect(summary).toBeVisible({ timeout: 60_000 });

  const loopback = panel.getByTestId('roundtable-loopback');
  await expect(loopback).toContainText('已带回', { timeout: 10_000 });
  await loopback.click();

  await expect(panel).toBeHidden({ timeout: 10_000 });
  const messages = page.getByTestId('messages');
  await expect(messages).toContainText('旅程基线：先聊一下 SaaS 定价', { timeout: 10_000 });
  await expect(messages).toContainText('发起圆桌讨论：A4 回写回归：如何选择 SaaS 计费模型？');
  await expect(messages).toContainText('来自圆桌讨论');
  await expect(page.locator(`[data-testid="conv-item"][data-conv-id="${originalCid}"]`)).toHaveAttribute(
    'aria-current',
    'true',
  );

  const msgsRes = await authedFetch(env, `/v1/conversations/${originalCid}/messages`);
  const body = (await msgsRes.json()) as {
    messages: Array<{ role: string; content: string | null }>;
  };
  expect(body.messages.some((m) => (m.content ?? '').includes('旅程基线：先聊一下 SaaS 定价'))).toBe(true);
  expect(body.messages.some((m) => (m.content ?? '').includes('发起圆桌讨论：A4 回写回归'))).toBe(true);
  expect(body.messages.some((m) => (m.content ?? '').includes('推荐决策'))).toBe(true);
});
