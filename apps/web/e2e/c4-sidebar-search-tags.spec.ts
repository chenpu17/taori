/**
 * C4 — sidebar pin / tag / search / batch.
 *
 * User flow exercised from the renderer:
 *   1. Send messages in 3 separate conversations (rename them so search has
 *      something deterministic to match).
 *   2. Pin the OLDEST conversation → assert it floats to the top of the list
 *      and shows the 📌 已置顶 group head.
 *   3. Add 2 tags to it → assert chips render.
 *   4. Type a query in the search box that only matches one of the others by
 *      MESSAGE CONTENT → assert the list shrinks to that one.
 *   5. Clear the search; enter batch mode, select 2 conversations, click
 *      批量删除 → assert they disappear from the sidebar.
 */
import { test, expect } from '@playwright/test';
import {
  authedFetch,
  readSidecarEnv,
  resetSidecar,
  type SidecarEnv,
} from './_helpers';
import { startMockOpenAI } from './_mock-openai-server';

const MOCK_PORT = 17901;
const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}/v1`;

let server: ReturnType<typeof startMockOpenAI> | null = null;
let env: SidecarEnv;

test.beforeAll(() => {
  server = startMockOpenAI(MOCK_PORT, { fixedReply: 'ok' });
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
      name: 'C4 mock',
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

async function sendOnce(
  page: import('@playwright/test').Page,
  text: string,
  ordinal: number,
): Promise<void> {
  await page.getByTestId('composer-input').fill(text);
  await page.getByTestId('composer-send').click();
  await expect(page.locator('.msg.assistant').nth(ordinal - 1)).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId('streaming-indicator')).toHaveCount(0, {
    timeout: 30_000,
  });
}

async function startNewConv(page: import('@playwright/test').Page): Promise<void> {
  await page.getByTestId('sidebar-new').click();
  // Wait for empty composer to mount.
  await expect(page.getByTestId('composer-input')).toBeVisible();
}

test('C4 user can pin, tag, search, and batch-delete sidebar conversations', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await resetSidecar(env);
  await seedDefaultChatModel();

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  // 1) Three conversations with distinctive content.
  await sendOnce(page, '一段关于 SQLite WAL 的提问', 1);
  await startNewConv(page);
  await sendOnce(page, '帮我写一段关于茶艺的散文', 1);
  await startNewConv(page);
  await sendOnce(page, '推荐 5 本关于天文学的书', 1);

  // Sidebar should now have 3 conv-items.
  await expect(page.locator('[data-testid="conv-item"]')).toHaveCount(3, {
    timeout: 10_000,
  });

  // Identify the OLDEST conversation (last in the unpinned list, since
  // newest first). We grab its conv-id BEFORE pinning so we can assert
  // it moves to the top.
  const items = page.locator('[data-testid="conv-item"]');
  const oldestId = await items.last().getAttribute('data-conv-id');
  expect(oldestId).toBeTruthy();

  // 2) Pin it.
  await items.last().hover();
  await items.last().getByTestId('conv-pin').click();
  // After pinning, the pinned group head appears and oldest is at top.
  await expect(page.locator('.conv-group-head').first()).toContainText('已置顶', {
    timeout: 5_000,
  });
  await expect
    .poll(async () => items.first().getAttribute('data-conv-id'), {
      timeout: 5_000,
    })
    .toBe(oldestId);
  await expect(items.first()).toHaveAttribute('data-conv-pinned', 'true');

  // 3) Add tags to the pinned one.
  await items.first().hover();
  await items.first().getByTestId('conv-tag-edit').click();
  const tagInput = items.first().getByTestId('conv-tag-input');
  await expect(tagInput).toBeVisible();
  await tagInput.fill('工作, 重要');
  await items.first().getByTestId('conv-tag-save').click();
  await expect(items.first().getByTestId('conv-tag-chip')).toHaveCount(2, {
    timeout: 5_000,
  });

  // 4) Search by MESSAGE CONTENT — "茶艺" should match only the second
  // conv we created (which is NOT the pinned one).
  await page.getByTestId('conv-search').fill('茶艺');
  await expect(page.locator('[data-testid="conv-item"]')).toHaveCount(1, {
    timeout: 5_000,
  });
  await expect(page.locator('[data-testid="conv-item"]').first()).not.toHaveAttribute(
    'data-conv-id',
    oldestId ?? '',
  );

  // Clear search → all 3 back.
  await page.getByTestId('conv-search').fill('');
  await expect(page.locator('[data-testid="conv-item"]')).toHaveCount(3, {
    timeout: 5_000,
  });

  // 5) Batch select + delete the two non-pinned conversations.
  await page.getByTestId('batch-enter').click();
  await expect(page.getByTestId('batch-cancel')).toBeVisible();
  await page.getByTestId('batch-select-all').click();
  await expect(page.getByTestId('batch-count')).toContainText('已选 3');
  await expect(page.getByTestId('batch-select-all')).toContainText('清空选择');

  // Uncheck the pinned one so only the 2 unpinned conversations remain selected.
  const allItems = await page.locator('[data-testid="conv-item"]').all();
  for (const item of allItems) {
    const id = await item.getAttribute('data-conv-id');
    if (id === oldestId) {
      await item.getByTestId('conv-select').uncheck();
    }
  }
  await expect(page.getByTestId('batch-count')).toContainText('已选 2');

  page.once('dialog', (d) => void d.accept());
  await page.getByTestId('batch-delete').click();

  // Only the pinned one survives.
  await expect(page.locator('[data-testid="conv-item"]')).toHaveCount(1, {
    timeout: 10_000,
  });
  await expect(page.locator('[data-testid="conv-item"]').first()).toHaveAttribute(
    'data-conv-id',
    oldestId!,
  );
  // Batch mode auto-exits.
  await expect(page.getByTestId('batch-enter')).toBeVisible();
});
