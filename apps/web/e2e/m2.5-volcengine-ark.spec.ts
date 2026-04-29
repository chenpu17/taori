import { test, expect } from '@playwright/test';
import { readSidecarEnv, resetSidecar } from './_helpers';

/**
 * M2.5 — Volcengine Ark visibility.
 *
 * Asserts the Ark preset is selectable in the Onboarding wizard so users with
 * an Ark API key can onboard one Provider that yields chat / multimodal /
 * image / video models.
 */

test('onboarding: volcengine_ark preset is selectable with the right base URL', async ({
  page,
}) => {
  const env = readSidecarEnv();
  await resetSidecar(env);
  await page.goto('/');
  await expect(page.getByTestId('onboarding')).toBeVisible();

  const select = page.getByTestId('onb-provider-type');
  await expect(select.locator('option', { hasText: '火山方舟' })).toHaveCount(1);
  await select.selectOption('volcengine_ark');
  await expect(page.getByTestId('onb-base-url')).toHaveValue(
    'https://ark.cn-beijing.volces.com/api/v3',
  );
});
