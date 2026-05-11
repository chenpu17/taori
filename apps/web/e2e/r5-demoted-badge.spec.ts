import { test, expect } from '@playwright/test';
import { authedFetch, readSidecarEnv, resetSidecar } from './_helpers';

/**
 * R5 — Model selector shows ⚠️ on demoted models (FR-4 / 04-failure-resilience).
 *
 * Seeds 2 chat models, demotes the default by triggering 3× rate_limit
 * failures on /v1/chat (recordFailure threshold from
 * docs/product/08-m1-spec.md §7.5.2), then asserts the selector option
 * carries the ⚠️ indicator. Settings list view shows the same badge via
 * data-testid="settings-demoted-badge".
 */

test('R5 demoted model carries ⚠️ in selector and settings list', async ({ page }) => {
  const env = readSidecarEnv();
  await resetSidecar(env);

  const pr = await authedFetch(env, '/v1/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'OR',
      type: 'openrouter',
      base_url: 'https://example.invalid/v1',
      api_key: 'sk-test',
    }),
  });
  const provider = (await pr.json()) as { id: string };

  async function seed(name: string, display: string, isDefault = false): Promise<string> {
    const r = await authedFetch(env, '/v1/models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider_id: provider.id,
        model_name: name,
        capability: 'chat',
        display_name: display,
        is_default_for: isDefault ? 'chat' : null,
      }),
    });
    return ((await r.json()) as { id: string }).id;
  }

  const primaryId = await seed('m-primary', 'PrimaryDemo', true);
  await seed('m-secondary', 'SecondaryStable');

  // 3× rate_limit on the primary → demoted (per spec §7.5.2).
  for (let i = 0; i < 3; i += 1) {
    const r = await authedFetch(env, '/v1/chat', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-force-classification': 'rate_limit',
      },
      body: JSON.stringify({
        model_id: primaryId,
        messages: [{ role: 'user', content: `strike ${i}` }],
      }),
    });
    // Stream may return 200 with an in-stream failure marker — read & discard.
    if (r.body) await r.text();
  }

  // Verify backend now reports demoted=true on PrimaryDemo.
  const ml = await authedFetch(env, '/v1/models');
  const { models } = (await ml.json()) as { models: { id: string; demoted: boolean }[] };
  const primary = models.find((m) => m.id === primaryId)!;
  expect(primary.demoted).toBe(true);

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  // Selector option for PrimaryDemo should contain the warning indicator.
  const select = page.getByTestId('active-model');
  const primaryOption = select.locator(`option[value="${primaryId}"]`);
  await expect(primaryOption).toContainText('⚠️');

  // Model Center also shows the demoted badge.
  await page.getByTestId('open-model-center').click();
  const badge = page.locator('[data-testid^="model-demoted-"]').first();
  await expect(badge).toBeVisible({ timeout: 5_000 });
  await expect(badge).toContainText('降级');
  await expect.poll(async () =>
    badge.evaluate((el) => {
      const style = getComputedStyle(el);
      return style.whiteSpace === 'nowrap' && el.getBoundingClientRect().height <= 24;
    }),
  ).toBe(true);
});
