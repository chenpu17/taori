import { test, expect } from '@playwright/test';
import { authedFetch, readSidecarEnv, resetSidecar } from './_helpers';

/**
 * R4.2 — Context window warning. Seed a model with `context_length: 500`,
 * then enter a prompt longer than 85% of that and assert the warning banner
 * shows up with the right `data-state`.
 */

async function seedTinyContextModel(env: ReturnType<typeof readSidecarEnv>) {
  const pr = await authedFetch(env, '/v1/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Tiny ctx provider',
      type: 'custom',
      base_url: 'https://example.invalid/v1',
    }),
  });
  const provider = (await pr.json()) as { id: string };
  const mr = await authedFetch(env, '/v1/models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider_id: provider.id,
      model_name: 'tiny-ctx',
      capability: 'chat',
      display_name: 'Tiny ctx',
      is_default_for: 'chat',
      price_input_per_1m: 0.5,
      price_output_per_1m: 1.5,
      context_length: 500,
    }),
  });
  if (!mr.ok) throw new Error(`seed ctx model failed: ${mr.status}`);
}

test('R4.2 context warning fires at ≥85% and exceed at ≥100%', async ({ page }) => {
  const env = readSidecarEnv();
  await resetSidecar(env);
  await seedTinyContextModel(env);

  await page.goto('/');
  await page.waitForSelector('[data-testid=composer-input]', { timeout: 5000 });

  const input = page.locator('[data-testid=composer-input]');

  // Real tokenizer: these numbered words produce predictable token counts.
  await input.fill(Array.from({ length: 213 }, (_, i) => `word${i}`).join(' '));
  const banner = page.locator('[data-testid=context-warning]');
  await expect(banner).toBeVisible();
  await expect(banner).toHaveAttribute('data-state', 'warn');

  await input.fill(Array.from({ length: 251 }, (_, i) => `word${i}`).join(' '));
  await expect(banner).toHaveAttribute('data-state', 'exceed');

  await input.fill('hi');
  await expect(banner).toHaveCount(0);
});
