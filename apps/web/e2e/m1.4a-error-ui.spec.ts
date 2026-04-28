import { test, expect } from '@playwright/test';
import { readSidecarEnv, resetSidecar, authedFetch } from './_helpers';

/**
 * M1.4a — error classification UI smoke.
 *
 * Seed a model with an API key pointing at an unresolvable host so the chat
 * route takes the *upstream* path and the upstream call fails with a network
 * error. Sidecar must emit a `3:` frame the renderer surfaces as a banner
 * with the classified label.
 */
test.beforeEach(async () => {
  const env = readSidecarEnv();
  await resetSidecar(env);
  // Provider with api_key → upstream branch in chat.ts.
  const pr = await authedFetch(env, '/v1/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Bad upstream',
      type: 'custom',
      base_url: 'https://example.invalid/v1',
      api_key: 'sk-test-bogus',
    }),
  });
  const provider = (await pr.json()) as { id: string };
  await authedFetch(env, '/v1/models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider_id: provider.id,
      model_name: 'gpt-test',
      capability: 'chat',
      display_name: 'Bad model',
      is_default_for: 'chat',
    }),
  });
});

test('M1.4a upstream network error → classified banner', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  await page.getByTestId('composer-input').fill('hello bad upstream');
  await page.getByTestId('composer-send').click();

  await expect(page.getByTestId('chat-error')).toBeVisible({ timeout: 15_000 });
  // Wire format per spec §7.5.2: provider failures are tagged
  // `provider_error/<classification>`.
  await expect(page.getByTestId('chat-error-class')).toHaveText(
    /^provider_error\/(quota|rate_limit|network|content_filter|unknown)$/,
  );
  await expect(page.getByTestId('chat-error-label')).toHaveText(
    /已超出额度|速率限制|网络错误|上游内容拦截|上游错误/,
  );
});
