import { test, expect } from '@playwright/test';
import { authedFetch, readSidecarEnv, resetSidecar, seedDefaultModel } from './_helpers';

/**
 * Round-2 (sidebar / model selector / msg-actions / abort) Playwright coverage.
 *
 * Each test resets sidecar state and seeds a default mock chat model so the
 * Workspace renders without the onboarding wizard.
 */
test.beforeEach(async () => {
  const env = readSidecarEnv();
  await resetSidecar(env);
  await seedDefaultModel(env);
});

async function sendMessage(page: import('@playwright/test').Page, text: string) {
  await page.getByTestId('composer-input').fill(text);
  await page.getByTestId('composer-send').click();
}

test('sidebar: new chat → send → conversation appears → switch loads history', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible();
  await expect(page.getByTestId('sidebar')).toBeVisible();

  // Initially no conversations in the list.
  await expect(page.getByTestId('conv-list')).toContainText('暂无对话');

  await sendMessage(page, 'first conversation about cats');
  await expect(page.locator('.msg.assistant').last()).toContainText('[M0 mock]', {
    timeout: 15_000,
  });

  // Sidebar should now show the auto-titled conversation.
  await expect(page.getByTestId('conv-list')).not.toContainText('暂无对话', {
    timeout: 5_000,
  });
  const firstConv = page.getByTestId('conv-item').first();
  await expect(firstConv).toContainText('first conversation', { timeout: 5_000 });
  await expect(firstConv).toHaveAttribute('aria-current', 'true');

  // Start a new chat → the previous conversation should still be in the
  // sidebar but unselected; messages should be empty.
  await page.getByTestId('sidebar-new').click();
  await expect(page.locator('.msg')).toHaveCount(0);
  await expect(page.getByTestId('conv-item').first()).not.toHaveAttribute(
    'aria-current',
    'true',
  );

  // Send a 2nd message to create a 2nd conversation.
  await sendMessage(page, 'second one about dogs');
  await expect(page.locator('.msg.assistant').last()).toContainText('[M0 mock]', {
    timeout: 15_000,
  });
  await expect(page.getByTestId('conv-item')).toHaveCount(2);

  // Click the older "cats" conversation → it must reload its history.
  const catsItem = page
    .getByTestId('conv-item')
    .filter({ hasText: 'first conversation' });
  await catsItem.locator('.conv-title').click();
  await expect(catsItem).toHaveAttribute('aria-current', 'true');
  await expect(page.locator('.msg.user').first()).toContainText(
    'first conversation about cats',
    { timeout: 5_000 },
  );
  await expect(page.locator('.msg.assistant').first()).toContainText('[M0 mock]');
});

test('sidebar: rename + delete conversation', async ({ page }) => {
  await page.goto('/');
  await sendMessage(page, 'before rename');
  await expect(page.locator('.msg.assistant').last()).toContainText('[M0 mock]', {
    timeout: 15_000,
  });

  // Rename via window.prompt — Playwright auto-handles the dialog.
  page.once('dialog', (d) => {
    void d.accept('renamed-by-test');
  });
  await page.getByTestId('conv-rename').first().click();
  await expect(page.getByTestId('conv-item').first()).toContainText(
    'renamed-by-test',
    { timeout: 5_000 },
  );

  // Delete via window.confirm.
  page.once('dialog', (d) => {
    void d.accept();
  });
  await page.getByTestId('conv-delete').first().click();
  await expect(page.getByTestId('conv-list')).toContainText('暂无对话', {
    timeout: 5_000,
  });
});

test('model selector: switching the active model updates send body', async ({
  page,
}) => {
  // Seed a 2nd mock model so the dropdown has 2 options.
  const env = readSidecarEnv();
  const provs = await (await authedFetch(env, '/v1/providers')).json();
  const providerId = (provs as { providers: { id: string }[] }).providers[0]!.id;
  const r = await authedFetch(env, '/v1/models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider_id: providerId,
      model_name: 'mock-model-b',
      capability: 'chat',
      display_name: 'Mock chat B',
      price_input_per_1m: 1,
      price_output_per_1m: 2,
    }),
  });
  expect(r.ok).toBe(true);

  await page.goto('/');
  const selector = page.getByTestId('active-model');
  await expect(selector).toBeVisible();
  // Default mock-model is selected.
  await expect(selector.locator('option')).toHaveCount(2);

  // Capture the next /v1/chat request body.
  const reqPromise = page.waitForRequest((req) =>
    req.url().endsWith('/v1/chat') && req.method() === 'POST',
  );
  await selector.selectOption({ label: 'Mock chat B' });
  await sendMessage(page, 'hi from model B');
  const req = await reqPromise;
  const body = JSON.parse(req.postData() ?? '{}') as { model_id?: string };
  expect(body.model_id).toBeTruthy();
  // It should not be the default seed model — we picked the new one.
  const newModel = ((await (await authedFetch(env, '/v1/models')).json()) as {
    models: { id: string; model_name: string }[];
  }).models.find((m) => m.model_name === 'mock-model-b');
  expect(body.model_id).toBe(newModel?.id);
});

test('msg-actions: copy + regenerate visible after streaming completes', async ({
  page,
}) => {
  await page.goto('/');
  await sendMessage(page, 'copy/regenerate target');
  await expect(page.locator('.msg.assistant').last()).toContainText('[M0 mock]', {
    timeout: 15_000,
  });

  const actions = page.getByTestId('msg-actions').last();
  await expect(actions).toBeVisible();
  await expect(actions.getByTestId('msg-copy')).toBeVisible();
  await expect(actions.getByTestId('msg-regenerate')).toBeVisible();

  // Regenerate should trigger another /v1/chat round-trip.
  const reqPromise = page.waitForRequest(
    (req) => req.url().endsWith('/v1/chat') && req.method() === 'POST',
  );
  await actions.getByTestId('msg-regenerate').click();
  await reqPromise;
  // After regenerate, we still see an assistant bubble with M0 mock content.
  await expect(page.locator('.msg.assistant').last()).toContainText('[M0 mock]', {
    timeout: 15_000,
  });
});
