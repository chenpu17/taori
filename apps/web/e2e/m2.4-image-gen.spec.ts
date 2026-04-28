import { test, expect } from '@playwright/test';
import { readSidecarEnv, resetSidecar, authedFetch } from './_helpers';

/**
 * M2.4 — intent → picker → image_generate flow.
 *
 * We seed:
 *   - one chat-capable model (so onboarding completes / chat works)
 *   - one image-capable model (so the picker has a valid choice)
 * Then we type "画一张机器人", expect the picker dialog, click the
 * X-Test-Force-Image-Result=success path, and verify a new assistant
 * message lands.
 */

let env: ReturnType<typeof readSidecarEnv>;
let imageModelId: string;

test.beforeEach(async () => {
  env = readSidecarEnv();
  await resetSidecar(env);
  const pr = await authedFetch(env, '/v1/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'OAI',
      type: 'openai',
      base_url: 'https://api.openai.example.com/v1',
      api_key: 'sk-test',
    }),
  });
  const provider = (await pr.json()) as { id: string };
  await authedFetch(env, '/v1/models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider_id: provider.id,
      model_name: 'gpt-4o',
      capability: 'chat',
      display_name: 'Chat 4o',
      is_default_for: 'chat',
    }),
  });
  const im = await authedFetch(env, '/v1/models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider_id: provider.id,
      model_name: 'dall-e-3',
      capability: 'image',
      display_name: 'DALL-E 3',
      price_per_call: 0.04,
    }),
  });
  imageModelId = ((await im.json()) as { id: string }).id;
});

test('M2.4 image intent → picker opens → force=success → assistant message arrives', async ({ page }) => {
  // Inject the test-force header on tool invokes (renderer-driven calls).
  await page.route('**/v1/tools/invoke', async (route) => {
    const headers = {
      ...route.request().headers(),
      'x-test-force-image-result': 'success',
    };
    await route.continue({ headers });
  });

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  await page.getByTestId('composer-input').fill('画一张机器人');
  await page.getByTestId('composer-send').click();

  const dialog = page.getByTestId('image-picker-dialog');
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await expect(dialog.getByTestId('image-picker-prompt')).toContainText('画一张机器人');
  await expect(dialog.getByTestId(`image-model-radio-${imageModelId}`)).toBeChecked();

  await dialog.getByTestId('image-picker-submit').click();

  // M2 §7 step 6 — high-cost confirm dialog appears (image_always default ON).
  const confirm = page.getByTestId('cost-confirm-dialog');
  await expect(confirm).toBeVisible({ timeout: 10_000 });
  await confirm.getByTestId('cost-confirm-continue').click();

  // Picker closes once the tool succeeds + history reload completes.
  await expect(dialog).toBeHidden({ timeout: 10_000 });

  // Inserted assistant message should be visible in the chat panel.
  const assistant = page.locator('.msg.assistant').last();
  await expect(assistant).toContainText(/Generated with|DALL-E/i, { timeout: 10_000 });
});

test('M2.4 escape button writes intent_route_disabled_until and closes picker', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  await page.getByTestId('composer-input').fill('画一张机器人');
  await page.getByTestId('composer-send').click();

  const dialog = page.getByTestId('image-picker-dialog');
  await expect(dialog).toBeVisible({ timeout: 10_000 });

  await dialog.getByTestId('image-picker-escape').click();
  await expect(dialog).toBeHidden();

  // After escape, the next image-intent message must NOT open the picker
  // (intent_route_disabled_until is set 30 min into the future).
  await page.getByTestId('composer-input').fill('画一只猫');
  await page.getByTestId('composer-send').click();
  // Wait for the chat round-trip to settle — picker should never appear.
  await page.waitForTimeout(2500);
  await expect(page.getByTestId('image-picker-dialog')).toHaveCount(0);
});
