import { test, expect } from '@playwright/test';
import { authedFetch, readSidecarEnv, resetSidecar } from './_helpers';

/**
 * R3.2 — runtime auto-fallback honors MC-3 fallback_order.
 *
 * Seeds 3 chat models (default + two candidates), reorders so the third
 * candidate becomes the immediate fallback, forces a recoverable failure,
 * and asserts the renderer switched to the reordered candidate (via
 * `failure_decision.recommended_model_id` consumed by App.tsx).
 */

test('R3.2 auto-fallback target follows reorder', async ({ page }) => {
  const env = readSidecarEnv();
  await resetSidecar(env);

  await authedFetch(env, '/v1/memories', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      scope: 'global',
      key: 'auto_fallback_enabled',
      value: 'true',
    }),
  });

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

  async function seed(modelName: string, display: string, isDefault = false): Promise<string> {
    const r = await authedFetch(env, '/v1/models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider_id: provider.id,
        model_name: modelName,
        capability: 'chat',
        display_name: display,
        is_default_for: isDefault ? 'chat' : null,
      }),
    });
    return ((await r.json()) as { id: string }).id;
  }

  const primaryId = await seed('m-primary', 'Primary', true);
  const candAId = await seed('m-cand-a', 'CandidateA');
  const candBId = await seed('m-cand-b', 'CandidateB');

  // Default insertion order: Primary, CandidateA, CandidateB.
  // nextFallback(Primary) → CandidateA. We reorder to make CandidateB the
  // immediate fallback instead.
  const r = await authedFetch(env, '/v1/models/reorder', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      capability: 'chat',
      ordered_ids: [primaryId, candBId, candAId],
    }),
  });
  expect(r.status).toBe(200);

  await page.route('**/v1/chat', async (route) => {
    const headers = {
      ...route.request().headers(),
      'x-test-force-classification': 'rate_limit',
    };
    await route.continue({ headers });
  });

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  await page.getByTestId('composer-input').fill('trigger fallback');
  await page.getByTestId('composer-send').click();

  // The system note should reflect the reordered fallback target = CandidateB.
  await expect(page.locator('.msg.system', { hasText: '已自动切换到「CandidateB」' })).toBeVisible({
    timeout: 15_000,
  });
});
