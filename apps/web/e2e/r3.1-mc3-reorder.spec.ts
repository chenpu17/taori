import { test, expect } from '@playwright/test';
import { authedFetch, readSidecarEnv, resetSidecar } from './_helpers';

/**
 * R3.1 — MC-3 备援顺序：
 *
 * 1. Seed 3 chat models in a known order.
 * 2. Open Settings → verify 1/2/3 ordering badges.
 * 3. Move row #1 down → row order updates immediately.
 * 4. Reload the page → ordering persists.
 * 5. Validate boundary buttons (top-most ▲ disabled, bottom-most ▼ disabled).
 */

interface SeededModel {
  id: string;
  display_name: string;
}

async function seedThreeChatModels(env: ReturnType<typeof readSidecarEnv>): Promise<SeededModel[]> {
  const pr = await authedFetch(env, '/v1/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'R3.1 provider',
      type: 'custom',
      base_url: 'https://example.invalid/v1',
    }),
  });
  if (!pr.ok) throw new Error(`seed provider: ${pr.status}`);
  const provider = (await pr.json()) as { id: string };
  const seeded: SeededModel[] = [];
  for (const name of ['Alpha', 'Bravo', 'Charlie']) {
    const r = await authedFetch(env, '/v1/models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider_id: provider.id,
        model_name: `mock-${name.toLowerCase()}`,
        capability: 'chat',
        display_name: name,
        is_default_for: name === 'Alpha' ? 'chat' : null,
        price_input_per_1m: 0.5,
        price_output_per_1m: 1.0,
      }),
    });
    if (!r.ok) throw new Error(`seed ${name}: ${r.status}`);
    const m = (await r.json()) as { id: string; display_name: string };
    seeded.push(m);
  }
  return seeded;
}

test('R3.1 MC-3 reorder: move-down + reload persists order (Model Center)', async ({ page }) => {
  const env = readSidecarEnv();
  await resetSidecar(env);
  const seeded = await seedThreeChatModels(env);
  const [alpha, bravo, charlie] = seeded;

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible();
  await page.getByTestId('open-model-center').click();
  await expect(page.getByTestId('model-center')).toBeVisible();

  // Initial order is the seed insertion order: Alpha, Bravo, Charlie.
  const rows = page.locator(
    '[data-testid^="model-row-"]:not([data-testid^="model-row-default-"]):not([data-testid^="model-row-up-"]):not([data-testid^="model-row-down-"]):not([data-testid^="model-row-delete-"]):not([data-testid^="model-row-enabled-"])',
  );
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('Alpha');
  await expect(rows.nth(1)).toContainText('Bravo');
  await expect(rows.nth(2)).toContainText('Charlie');

  // Top ▲ disabled; bottom ▼ disabled.
  await expect(page.getByTestId(`model-row-up-${alpha.id}`)).toBeDisabled();
  await expect(page.getByTestId(`model-row-down-${charlie.id}`)).toBeDisabled();

  // Move Alpha down twice → final order: Bravo, Charlie, Alpha.
  await page.getByTestId(`model-row-down-${alpha.id}`).click();
  await expect(rows.nth(0)).toContainText('Bravo');
  await expect(rows.nth(1)).toContainText('Alpha');
  await page.getByTestId(`model-row-down-${alpha.id}`).click();
  await expect(rows.nth(2)).toContainText('Alpha');

  // Reload and confirm ordering survives.
  await page.reload();
  await page.getByTestId('open-model-center').click();
  const rows2 = page.locator(
    '[data-testid^="model-row-"]:not([data-testid^="model-row-default-"]):not([data-testid^="model-row-up-"]):not([data-testid^="model-row-down-"]):not([data-testid^="model-row-delete-"]):not([data-testid^="model-row-enabled-"])',
  );
  await expect(rows2.nth(0)).toContainText('Bravo');
  await expect(rows2.nth(1)).toContainText('Charlie');
  await expect(rows2.nth(2)).toContainText('Alpha');

  // Verify backend reflects same order.
  const r = await authedFetch(env, '/v1/models');
  const list = ((await r.json()) as { models: { id: string; capability: string; display_name: string; fallback_order: number }[] }).models;
  const chatOrder = list
    .filter((m) => m.capability === 'chat')
    .sort((a, b) => a.fallback_order - b.fallback_order)
    .map((m) => m.display_name);
  expect(chatOrder).toEqual(['Bravo', 'Charlie', 'Alpha']);

  // bravo reference for parity.
  expect(bravo.id).toBeTruthy();
});
