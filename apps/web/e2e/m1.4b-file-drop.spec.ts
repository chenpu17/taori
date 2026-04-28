import { test, expect } from '@playwright/test';
import { readSidecarEnv, authedFetch, resetSidecar, seedDefaultModel } from './_helpers';

const env = readSidecarEnv();

const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

async function dropImage(page: import('@playwright/test').Page) {
  // Build a DataTransfer in the page context with one PNG file.
  const dataTransfer = await page.evaluateHandle((b64) => {
    const dt = new DataTransfer();
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    dt.items.add(new File([arr], 'tiny.png', { type: 'image/png' }));
    return dt;
  }, TINY_PNG_B64);
  await page.getByTestId('composer-form').dispatchEvent('dragover', { dataTransfer });
  await page.getByTestId('composer-form').dispatchEvent('drop', { dataTransfer });
}

test.beforeEach(async () => {
  await resetSidecar(env);
});

test('M1.4b: dropping image on non-vision model shows warning + disables send', async ({ page }) => {
  await seedDefaultModel(env);  // text-only mock model
  await page.goto('/');
  await expect(page.getByTestId('composer-form')).toBeVisible();
  await dropImage(page);
  await expect(page.getByTestId('attachment-thumb')).toBeVisible();
  await expect(page.getByTestId('vision-warning')).toBeVisible();
  await page.getByTestId('composer-input').fill('describe');
  await expect(page.getByTestId('composer-send')).toBeDisabled();
});

test('M1.4b: unsupported binary file drop shows rejection feedback (not silent)', async ({ page }) => {
  await seedDefaultModel(env);
  await page.goto('/');
  await expect(page.getByTestId('composer-form')).toBeVisible();
  // Drop a zip — not image/text/pdf, so classifier rejects it.
  const dataTransfer = await page.evaluateHandle(() => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([0x50, 0x4b, 3, 4])], 'archive.zip', { type: 'application/zip' }));
    return dt;
  });
  await page.getByTestId('composer-form').dispatchEvent('dragover', { dataTransfer });
  await page.getByTestId('composer-form').dispatchEvent('drop', { dataTransfer });
  await expect(page.getByTestId('drop-error')).toBeVisible();
  await expect(page.getByTestId('attachment-thumb')).toHaveCount(0);
});

test('M1.4b: text/markdown drop attaches as a file chip (R4c)', async ({ page }) => {
  await seedDefaultModel(env);
  await page.goto('/');
  await expect(page.getByTestId('composer-form')).toBeVisible();
  const dataTransfer = await page.evaluateHandle(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['# hello'], 'note.md', { type: 'text/markdown' }));
    return dt;
  });
  await page.getByTestId('composer-form').dispatchEvent('dragover', { dataTransfer });
  await page.getByTestId('composer-form').dispatchEvent('drop', { dataTransfer });
  // Should NOT be rejected; chip with kind="text" appears.
  await expect(page.getByTestId('attachment-thumb')).toHaveCount(1);
  await expect(page.getByTestId('attachment-thumb')).toHaveAttribute('data-kind', 'text');
});

test('M1.4b: dropping image on vision model attaches and persists on send', async ({ page }) => {
  // Seed vision-capable provider + model directly.
  const pr = await authedFetch(env, '/v1/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'vis', type: 'custom', base_url: 'https://example.invalid/v1' }),
  });
  const prov = (await pr.json()) as { id: string };
  await authedFetch(env, '/v1/models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider_id: prov.id,
      model_name: 'vision-mock',
      capability: 'chat',
      display_name: 'Vision mock',
      is_default_for: 'chat',
      supports_vision: true,
      price_input_per_1m: 0.5,
      price_output_per_1m: 1.5,
    }),
  });

  await page.goto('/');
  await expect(page.getByTestId('composer-form')).toBeVisible();
  await dropImage(page);
  await expect(page.getByTestId('attachment-thumb')).toBeVisible();
  await expect(page.getByTestId('vision-warning')).toHaveCount(0);

  await page.getByTestId('composer-input').fill('what do you see');
  await page.getByTestId('composer-send').click();

  // After send, attachment bar should clear; assistant should reply (mock path).
  await expect(page.getByTestId('attachments-bar')).toHaveCount(0, { timeout: 10_000 });
  await expect(page.locator('.msg.assistant').first()).toBeVisible({ timeout: 10_000 });
});
