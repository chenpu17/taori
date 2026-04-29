/**
 * C2 — stop a streaming response, then continue writing from where it
 * left off.
 *
 * User flow exercised from the renderer:
 *   1. send a chat message; mock LLM streams slowly enough that we can
 *      catch a partial assistant bubble.
 *   2. while still streaming, click 停止 in the composer.
 *      → assert the streaming indicator disappears, msg-actions render,
 *        and a new ✏️ 续写 button is visible on the truncated assistant
 *        message.
 *   3. click ✏️ 续写.
 *      → assert a new user bubble with the "请继续上文…" prompt appears,
 *        a fresh assistant streams in, and no console errors are raised.
 */
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

const LONG_REPLY =
  '这是一段刻意写得很长的助手回复，目的是让流式渲染过程中用户来得及点击停止按钮。' +
  '我们重复几次同样的话来拖长 token 数：'.repeat(8) +
  '段落结束。';

let server: ReturnType<typeof startMockOpenAI> | null = null;
let env: SidecarEnv;

test.beforeAll(() => {
  server = startMockOpenAI(MOCK_PORT, {
    streamDelayMs: 250,
    fixedReply: LONG_REPLY,
  });
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
      name: 'C2 mock',
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

test('C2 user can stop a streaming reply then resume with the 续写 button', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  await resetSidecar(env);
  await seedDefaultChatModel();

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  // Send a message; mock streams ~250ms per chunk so we have a window
  // to interact mid-stream.
  await page.getByTestId('composer-input').fill('请详细解释一下');
  await page.getByTestId('composer-send').click();

  // Wait for the streaming indicator + first assistant bubble to appear.
  await expect(page.getByTestId('composer-stop')).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.locator('.msg.assistant').first()).toBeVisible({
    timeout: 15_000,
  });
  // Allow at least one chunk to land so we have real partial content.
  await page.waitForTimeout(800);

  // Click 停止.
  await page.getByTestId('composer-stop').click();

  // Stop button must disappear (isLoading flipped false), msg-actions show.
  await expect(page.getByTestId('composer-stop')).toHaveCount(0, {
    timeout: 10_000,
  });
  await expect(page.getByTestId('streaming-indicator')).toHaveCount(0, {
    timeout: 10_000,
  });
  await expect(page.locator('.msg.assistant').first()).toBeVisible();

  // The 续写 button is rendered on the (last & only) assistant msg.
  const continueBtn = page.getByTestId('msg-continue');
  await expect(continueBtn).toBeVisible({ timeout: 10_000 });

  // Capture how much assistant text we already have (sanity check that
  // we really did stop mid-stream, i.e. less than the full reply).
  const partial = (
    (await page.locator('.msg.assistant').first().innerText()) || ''
  ).trim();
  expect(partial.length).toBeGreaterThan(0);
  expect(partial.length).toBeLessThan(LONG_REPLY.length);

  // Click 续写.
  await continueBtn.click();

  // A new user bubble appears with the continue prompt.
  await expect(
    page.locator('.msg.user').filter({ hasText: '请继续上文' }),
  ).toHaveCount(1, { timeout: 10_000 });

  // Streaming kicks off again; wait for it to complete.
  await expect(page.getByTestId('composer-stop')).toBeVisible({
    timeout: 10_000,
  });
  // Stop the second stream too so the test stays bounded.
  await page.waitForTimeout(600);
  await page.getByTestId('composer-stop').click();
  await expect(page.getByTestId('composer-stop')).toHaveCount(0, {
    timeout: 10_000,
  });

  // We should now have 2 user msgs + 2 assistant msgs.
  expect(await page.locator('.msg.user').count()).toBe(2);
  expect(await page.locator('.msg.assistant').count()).toBe(2);

  // No console errors leaked from the renderer.
  expect(
    consoleErrors.filter(
      (e) =>
        // Filter out known abort noise from useChat: stopping mid-stream
        // surfaces an AbortError on the underlying fetch which the SDK
        // logs via onError → console.error (we wired that intentionally).
        !/aborted|AbortError|BodyStreamBuffer/i.test(e),
    ),
  ).toEqual([]);
});
