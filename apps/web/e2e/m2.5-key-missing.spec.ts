import { test, expect } from '@playwright/test';
import { readSidecarEnv, resetSidecar, authedFetch } from './_helpers';

/**
 * M2.5 — key_missing & config_error error paths.
 *
 * Scenarios:
 *  A. Provider has api_key_ref but key is not in MemoryStore (fresh sidecar
 *     restart) → chat emits key_missing failure_decision card; no silent mock.
 *  B. Model Center shows 🔑 badge on providers that are missing their key.
 *  C. The key-status endpoint returns correct boolean for providers.
 */

test('key-status API: returns key_available=false for new providers without seeded key', async () => {
  const env = readSidecarEnv();
  await resetSidecar(env);

  // Create a provider with a fake api_key_ref (no key seeded into MemoryStore)
  const pr = await authedFetch(env, '/v1/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'TestArk',
      type: 'volcengine_ark',
      base_url: 'https://ark.cn-beijing.volces.com/api/v3',
      api_key_ref: 'test_no_key_provider',
    }),
  });
  expect(pr.ok).toBe(true);
  const provider = (await pr.json()) as { id: string };

  const ks = await authedFetch(env, '/v1/providers/key-status');
  expect(ks.ok).toBe(true);
  const { statuses } = (await ks.json()) as {
    statuses: { provider_id: string; key_available: boolean }[];
  };
  const entry = statuses.find((s) => s.provider_id === provider.id);
  expect(entry).toBeDefined();
  expect(entry!.key_available).toBe(false);
});

test('model-center: shows 🔑 badge on provider missing key', async ({ page }) => {
  const env = readSidecarEnv();
  await resetSidecar(env);

  // Create provider WITH api_key so api_key_ref is set
  const pr = await authedFetch(env, '/v1/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Ark No Key',
      type: 'volcengine_ark',
      base_url: 'https://ark.cn-beijing.volces.com/api/v3',
      api_key: 'sk-temp-key-will-be-revoked',
    }),
  });
  expect(pr.ok).toBe(true);
  const { id: providerId } = (await pr.json()) as { id: string };

  // Verify key was initially available
  const ks1 = await authedFetch(env, '/v1/providers/key-status');
  const { statuses: s1 } = (await ks1.json()) as {
    statuses: { provider_id: string; key_available: boolean }[];
  };
  expect(s1.find((s) => s.provider_id === providerId)?.key_available).toBe(true);

  // Revoke the key (simulates sidecar restart with MemoryStore)
  const revoke = await authedFetch(env, `/v1/providers/${providerId}/key`, {
    method: 'DELETE',
  });
  expect(revoke.status).toBe(204);

  // Confirm key is now missing
  const ks2 = await authedFetch(env, '/v1/providers/key-status');
  const { statuses: s2 } = (await ks2.json()) as {
    statuses: { provider_id: string; key_available: boolean }[];
  };
  expect(s2.find((s) => s.provider_id === providerId)?.key_available).toBe(false);

  // Also seed one model so chat panel boots
  await authedFetch(env, '/v1/models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider_id: providerId,
      model_name: 'mock-model',
      capability: 'chat',
      display_name: 'Mock chat',
      is_default_for: 'chat',
      price_input_per_1m: 0,
      price_output_per_1m: 0,
    }),
  });

  await page.goto('/');
  await page.getByTestId('open-model-center').click();
  await expect(page.getByTestId('model-center')).toBeVisible();

  // The provider chip should have the 🔑 warning badge
  const warnBadge = page.getByTestId(`provider-chip-key-warn-${providerId}`);
  await expect(warnBadge).toBeVisible();
  await expect(warnBadge).toContainText('🔑');
});

test('key-status API: key_available=true after key is set, false after revoke', async () => {
  const env = readSidecarEnv();
  await resetSidecar(env);

  // Create provider WITH key → key_available = true
  const pr = await authedFetch(env, '/v1/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'TestProvider With Key',
      type: 'custom',
      base_url: 'https://example.invalid/v1',
      api_key: 'sk-test-1234',
    }),
  });
  expect(pr.ok).toBe(true);
  const { id: providerId } = (await pr.json()) as { id: string };

  const ks1 = await authedFetch(env, '/v1/providers/key-status');
  const { statuses: s1 } = (await ks1.json()) as {
    statuses: { provider_id: string; key_available: boolean }[];
  };
  expect(s1.find((s) => s.provider_id === providerId)?.key_available).toBe(true);

  // Revoke key → key_available = false
  const revoke = await authedFetch(env, `/v1/providers/${providerId}/key`, {
    method: 'DELETE',
  });
  expect(revoke.status).toBe(204);

  const ks2 = await authedFetch(env, '/v1/providers/key-status');
  const { statuses: s2 } = (await ks2.json()) as {
    statuses: { provider_id: string; key_available: boolean }[];
  };
  expect(s2.find((s) => s.provider_id === providerId)?.key_available).toBe(false);
});
