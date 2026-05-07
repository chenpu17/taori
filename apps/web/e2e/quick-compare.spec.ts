import { test, expect } from '@playwright/test';
import { authedFetch, readSidecarEnv, resetSidecar, type SidecarEnv } from './_helpers';

async function seedCompareModels(env: SidecarEnv): Promise<void> {
  const pr = await authedFetch(env, '/v1/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Quick Compare Mock',
      type: 'custom',
      base_url: 'https://example.invalid/v1',
    }),
  });
  const provider = (await pr.json()) as { id: string };
  for (let i = 0; i < 3; i++) {
    const body: Record<string, unknown> = {
      id: `mdl_qc_${i}`,
      provider_id: provider.id,
      model_name: `qc-model-${i}`,
      capability: 'chat',
      display_name: `QC Model ${i}`,
      price_input_per_1m: 0.1 + i,
      price_output_per_1m: 0.2 + i,
      context_length: i === 2 ? 100000 : 8000,
      supports_tools: i === 2,
      supports_json: i === 2,
    };
    if (i === 0) body.is_default_for = 'chat';
    await authedFetch(env, '/v1/models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
}

test('Quick Compare shows three candidates and adopts one into chat history', async ({ page }) => {
  const env = readSidecarEnv();
  await resetSidecar(env);
  await seedCompareModels(env);
  await page.addInitScript(() => {
    localStorage.setItem('tip_roundtable_first_seen', 'true');
  });

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 15_000 });

  await page.getByTestId('composer-input').fill('给我三个产品改进建议');
  await page.getByTestId('composer-quick-compare').click();
  await expect(page.getByTestId('quick-compare-picker')).toBeVisible();
  await expect(page.getByTestId('quick-compare-picker-count')).toContainText('已选 3/3');
  await page.getByTestId('quick-compare-picker-submit').click();

  await expect(page.getByTestId('quick-compare-card')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('quick-compare-output')).toHaveCount(3, { timeout: 15_000 });
  await expect(page.getByTestId('quick-compare-output').first()).toContainText('Quick Compare 本地预览');
  await expect(page.getByTestId('quick-compare-output').first()).toContainText('首字');
  await expect(page.getByTestId('quick-compare-output').first()).toContainText('总耗时');

  await page.getByTestId('quick-compare-adopt').first().click();
  await expect(page.getByTestId('quick-compare-card')).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator('.msg.assistant').last()).toContainText('Quick Compare 本地预览', {
    timeout: 15_000,
  });
});

test('Quick Compare picker lets user choose two models before running', async ({ page }) => {
  const env = readSidecarEnv();
  await resetSidecar(env);
  await seedCompareModels(env);
  await page.addInitScript(() => {
    localStorage.setItem('tip_roundtable_first_seen', 'true');
  });

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 15_000 });

  await page.getByTestId('composer-input').fill('只用两个模型对比这个方案');
  await page.getByTestId('composer-quick-compare').click();
  await expect(page.getByTestId('quick-compare-picker')).toBeVisible();
  await expect(page.getByTestId('quick-compare-picker-count')).toContainText('已选 3/3');
  await page.locator('[data-testid^="quick-compare-model-check-"]').nth(2).uncheck();
  await expect(page.getByTestId('quick-compare-picker-count')).toContainText('已选 2/3');
  await page.getByTestId('quick-compare-picker-submit').click();

  await expect(page.getByTestId('quick-compare-card')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('quick-compare-output')).toHaveCount(2, { timeout: 15_000 });
});
