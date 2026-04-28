import { test, expect } from '@playwright/test';
import { authedFetch, readSidecarEnv, resetSidecar } from './_helpers';

/**
 * R4.3 — Vision auto-switch. With two chat models — primary (no vision)
 * and a vision-capable peer — dropping an image should switch the active
 * model to the vision peer and surface a "已自动切换至视觉模型" notice.
 */

async function seedTwoChatModels(env: ReturnType<typeof readSidecarEnv>) {
  const pr = await authedFetch(env, '/v1/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Mixed provider',
      type: 'custom',
      base_url: 'https://example.invalid/v1',
    }),
  });
  const provider = (await pr.json()) as { id: string };
  // Primary: text-only, default for chat (so it's selected on boot)
  await authedFetch(env, '/v1/models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider_id: provider.id,
      model_name: 'text-only',
      capability: 'chat',
      display_name: 'Text Only',
      is_default_for: 'chat',
      supports_vision: false,
      price_input_per_1m: 0.5,
      price_output_per_1m: 1.5,
    }),
  });
  // Vision-capable peer
  await authedFetch(env, '/v1/models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider_id: provider.id,
      model_name: 'vision-pro',
      capability: 'chat',
      display_name: 'Vision Pro',
      supports_vision: true,
      price_input_per_1m: 1.0,
      price_output_per_1m: 3.0,
    }),
  });
}

// Tiny 1x1 transparent PNG (base64).
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

test('R4.3 dropping image on text-only model auto-switches to vision peer', async ({ page }) => {
  const env = readSidecarEnv();
  await resetSidecar(env);
  await seedTwoChatModels(env);

  await page.goto('/');
  await page.waitForSelector('[data-testid=composer-form]', { timeout: 5000 });

  // Confirm Text Only is the active default.
  await expect(
    page.locator('[data-testid=active-model] option:checked'),
  ).toHaveText(/Text Only/);

  // Synthesize a drop event with the tiny PNG file.
  const form = page.locator('[data-testid=composer-form]');
  await form.evaluate((el, b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], 'pixel.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, TINY_PNG_B64);

  // Auto-switch fires asynchronously inside the drop handler.
  await expect(
    page.locator('[data-testid=active-model] option:checked'),
  ).toHaveText(/Vision Pro/, { timeout: 3000 });
  await expect(page.locator('[data-testid=drop-error]')).toContainText(
    '已自动切换至视觉模型',
  );
});
