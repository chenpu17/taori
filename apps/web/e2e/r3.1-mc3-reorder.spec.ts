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

test('R3.1 MC-3 reorder: move-down + reload persists order', async ({ page }) => {
  const env = readSidecarEnv();
  await resetSidecar(env);
  const seeded = await seedThreeChatModels(env);

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible();
  await page.getByTestId('open-settings').click();
  await expect(page.getByTestId('settings-overlay')).toBeVisible();

  // Initial order is the seed insertion order: Alpha, Bravo, Charlie.
  const items = page.getByTestId('settings-model-item');
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toContainText('Alpha');
  await expect(items.nth(1)).toContainText('Bravo');
  await expect(items.nth(2)).toContainText('Charlie');

  // Top item's ▲ is disabled; bottom item's ▼ is disabled.
  await expect(items.nth(0).getByTestId('settings-move-up')).toBeDisabled();
  await expect(items.nth(2).getByTestId('settings-move-down')).toBeDisabled();

  // Move Alpha down twice → final order: Bravo, Charlie, Alpha.
  await items.nth(0).getByTestId('settings-move-down').click();
  await expect(items.nth(0)).toContainText('Bravo');
  await expect(items.nth(1)).toContainText('Alpha');
  await items.nth(1).getByTestId('settings-move-down').click();
  await expect(items.nth(2)).toContainText('Alpha');

  // Reload and confirm ordering survives.
  await page.reload();
  await page.getByTestId('open-settings').click();
  const items2 = page.getByTestId('settings-model-item');
  await expect(items2.nth(0)).toContainText('Bravo');
  await expect(items2.nth(1)).toContainText('Charlie');
  await expect(items2.nth(2)).toContainText('Alpha');

  // Verify backend reflects same order.
  const r = await authedFetch(env, '/v1/models');
  const list = ((await r.json()) as { models: { id: string; capability: string; display_name: string; fallback_order: number }[] }).models;
  const chatOrder = list
    .filter((m) => m.capability === 'chat')
    .sort((a, b) => a.fallback_order - b.fallback_order)
    .map((m) => m.display_name);
  expect(chatOrder).toEqual(['Bravo', 'Charlie', 'Alpha']);

  // Reference seeded ids so the var is used for parity with seedDefault helpers.
  expect(seeded).toHaveLength(3);
});
