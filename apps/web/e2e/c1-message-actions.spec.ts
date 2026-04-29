/**
 * C1 — message-level actions: edit-and-resend + branch.
 *
 * User flow we exercise from the renderer:
 *   1. send a chat message → wait for assistant reply
 *   2. send a 2nd chat message → wait for 2nd assistant reply
 *   3. hover the FIRST user message, click ✎ 编辑重发, change text, save
 *      → assert the 2nd user/assistant pair was discarded and a fresh
 *        assistant reply streams in
 *   4. click ⎇ 分支 on the original assistant message
 *      → assert sidebar gains a "分支" conversation, active conv switches,
 *        the cloned conv carries the right number of messages.
 */
import { test, expect } from '@playwright/test';
import {
  authedFetch,
  readSidecarEnv,
  resetSidecar,
  type SidecarEnv,
} from './_helpers';
import { startMockOpenAI } from './_mock-openai-server';

const MOCK_PORT = 17898;
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
      name: 'C1 mock',
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

async function sendAndWait(
  page: import('@playwright/test').Page,
  text: string,
  assistantOrdinal: number,
): Promise<void> {
  await page.getByTestId('composer-input').fill(text);
  await page.getByTestId('composer-send').click();
  // Wait until the expected number of assistant bubbles has fully
  // streamed (i.e. msg-actions render only after streaming completes).
  await expect(
    page.locator('.msg.assistant').nth(assistantOrdinal - 1),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('streaming-indicator')).toHaveCount(0, {
    timeout: 30_000,
  });
}

test('C1 user can edit-and-resend an earlier user message; assistant pair is discarded and regenerated', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await resetSidecar(env);
  await seedDefaultChatModel();

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  await sendAndWait(page, 'first question', 1);
  await sendAndWait(page, 'second question', 2);

  // Confirm 2 user + 2 assistant messages exist.
  expect(await page.locator('.msg.user').count()).toBe(2);
  expect(await page.locator('.msg.assistant').count()).toBe(2);

  // Edit the FIRST user message.
  const firstUser = page.locator('.msg.user').first();
  await firstUser.hover();
  await firstUser.getByTestId('msg-edit').click();
  const textarea = firstUser.getByTestId('msg-edit-textarea');
  await expect(textarea).toBeVisible();
  await textarea.fill('first question — rewritten');
  await firstUser.getByTestId('msg-edit-save').click();

  // After save: only the rewritten user message + a freshly streamed
  // assistant reply remain. The 2nd user msg & 2nd assistant msg are gone.
  await expect(page.getByTestId('streaming-indicator')).toHaveCount(0, {
    timeout: 30_000,
  });
  await expect(page.locator('.msg.user')).toHaveCount(1, { timeout: 10_000 });
  await expect(page.locator('.msg.user').first()).toContainText(
    'first question — rewritten',
  );
  await expect(page.locator('.msg.assistant')).toHaveCount(1);
});

test('C1 user can branch a conversation from a specific message into a new chat', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await resetSidecar(env);
  await seedDefaultChatModel();

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  await sendAndWait(page, 'topic Q1', 1);
  await sendAndWait(page, 'topic Q2', 2);

  // Capture the active conversation id BEFORE branching.
  const originalConvId = await page
    .getByTestId('chat-panel')
    .getAttribute('data-active-conv');
  expect(originalConvId).toBeTruthy();

  // Branch from the FIRST assistant message.
  const firstAssistant = page.locator('.msg.assistant').first();
  await firstAssistant.hover();
  await firstAssistant.getByTestId('msg-branch').click();

  // Active conversation should switch to a new id, and the sidebar should
  // gain a "分支" entry.
  await expect
    .poll(
      async () =>
        page.getByTestId('chat-panel').getAttribute('data-active-conv'),
      { timeout: 10_000 },
    )
    .not.toBe(originalConvId);

  // Sidebar contains the branch conv. Title contains "分支".
  await expect(
    page.locator('[data-testid="conv-item"]').filter({ hasText: '分支' }),
  ).toHaveCount(1, { timeout: 10_000 });

  // The active conversation has exactly 2 messages cloned (1 user + 1 assistant).
  await expect(page.locator('.msg.user')).toHaveCount(1);
  await expect(page.locator('.msg.assistant')).toHaveCount(1);
  await expect(page.locator('.msg.user').first()).toContainText('topic Q1');
});
