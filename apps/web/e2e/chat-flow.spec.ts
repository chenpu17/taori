import { test, expect } from '@playwright/test';
import { authedFetch, readSidecarEnv, resetSidecar, seedDefaultModel } from './_helpers';

/**
 * Live chat round-trip: seed a provider + model, send a message, see response.
 * Requires the test sidecar (started by global-setup) with a mock provider
 * that echoes or returns a canned response.
 */
test.beforeEach(async () => {
  const env = readSidecarEnv();
  await resetSidecar(env);
  await seedDefaultModel(env);
});

test('composer sends message and shows user bubble', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  const env = readSidecarEnv();

  await page.goto('/');

  // Wait for footer to show some status (sidecar reachable or not)
  await expect(page.locator('.foot')).toBeVisible({ timeout: 10_000 });

  // Wait for sidebar to populate with live conversations (or show empty state)
  await page.waitForSelector('.side', { timeout: 10_000 });

  // Composer should be visible
  const textarea = page.locator('.composer-input');
  await expect(textarea).toBeVisible({ timeout: 10_000 });

  // Type a message
  await textarea.fill('hello from e2e');
  await expect(textarea).toHaveValue('hello from e2e');

  // Send via Enter key
  await textarea.press('Enter');

  // User message should appear in chat
  await expect(page.locator('.msg').first()).toContainText('hello from e2e', { timeout: 10_000 });
  await expect(page.locator('.msg').last()).toContainText('End-to-end Renderer→Sidecar streaming is working.', { timeout: 10_000 });

  const convRes = await authedFetch(env, '/v1/conversations');
  expect(convRes.ok).toBeTruthy();
  const { conversations } = (await convRes.json()) as { conversations: Array<{ id: string }> };
  expect(conversations.length).toBe(1);

  const msgRes = await authedFetch(env, `/v1/conversations/${conversations[0]!.id}/messages`);
  expect(msgRes.ok).toBeTruthy();
  const { messages } = (await msgRes.json()) as {
    messages: Array<{ role: string; content: string; status: string }>;
  };
  expect(messages.map((msg) => msg.role)).toEqual(['user', 'assistant']);
  expect(messages[1]!.status).toBe('complete');
  expect(messages[1]!.content).toContain('End-to-end Renderer→Sidecar streaming is working.');

  // No page errors
  expect(errors).toEqual([]);
});

test('composer send button click works', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.foot')).toBeVisible({ timeout: 10_000 });

  const textarea = page.locator('.composer-input');
  await expect(textarea).toBeVisible({ timeout: 10_000 });

  await textarea.fill('click test');

  // Click send button
  await page.locator('.composer-send').click();

  // Message appears
  await expect(page.locator('.msg').first()).toContainText('click test', { timeout: 10_000 });
  await expect(page.locator('.msg').last()).toContainText('[M0 mock]', { timeout: 10_000 });
});

test('new chat button clears conversation', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.foot')).toBeVisible({ timeout: 10_000 });

  // Send a message first
  const textarea = page.locator('.composer-input');
  await expect(textarea).toBeVisible({ timeout: 10_000 });
  await textarea.fill('first message');
  await textarea.press('Enter');
  await expect(page.locator('.msg').first()).toContainText('first message', { timeout: 10_000 });

  // Click new chat
  await page.locator('.side-newbtn').click();

  // Welcome screen should appear (no active conversation)
  await expect(page.locator('.welcome')).toBeVisible({ timeout: 5_000 });
});

test('file attachment is sent to sidecar', async ({ page }) => {
  const env = readSidecarEnv();

  await page.goto('/');
  await expect(page.locator('.foot')).toBeVisible({ timeout: 10_000 });

  const fileInput = page.locator('.composer-shell input[type="file"]');
  await fileInput.setInputFiles([
    { name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# notes\nhello attachment\n') },
  ]);

  await expect(page.locator('.attach-chip')).toContainText('notes.md');
  await expect(page.locator('.composer-send')).toBeEnabled();

  const textarea = page.locator('.composer-input');
  await textarea.fill('please read attachment');
  await page.locator('.composer-send').click();

  await expect(page.locator('.msg').last()).toContainText('[M0 mock]', { timeout: 10_000 });

  const convRes = await authedFetch(env, '/v1/conversations');
  const { conversations } = (await convRes.json()) as { conversations: Array<{ id: string }> };
  const convId = conversations[0]!.id;
  const msgRes = await authedFetch(env, `/v1/conversations/${convId}/messages`);
  const { messages } = (await msgRes.json()) as {
    messages: Array<{ role: string; attachments_count: number }>;
  };
  expect(messages[0]!.role).toBe('user');
  expect(messages[0]!.attachments_count).toBe(1);
});
