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

async function seedDuplicateLabelCompareModels(env: SidecarEnv): Promise<void> {
  const [primaryProviderRes, secondaryProviderRes] = await Promise.all([
    authedFetch(env, '/v1/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: '向量引擎',
        type: 'custom',
        base_url: 'https://region-a.example.invalid/v1',
      }),
    }),
    authedFetch(env, '/v1/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: '向量引擎',
        type: 'custom',
        base_url: 'https://region-b.example.invalid/v1',
      }),
    }),
  ]);
  const primaryProvider = (await primaryProviderRes.json()) as { id: string };
  const secondaryProvider = (await secondaryProviderRes.json()) as { id: string };
  const rows: Array<Record<string, unknown>> = [
    {
      id: 'mdl_qc_dup_0',
      provider_id: primaryProvider.id,
      model_name: 'gpt-5.5-2026-04-24',
      capability: 'chat',
      display_name: 'gpt-5.5-2026-04-24',
      price_input_per_1m: 0.5,
      price_output_per_1m: 1.0,
      context_length: 128000,
      is_default_for: 'chat',
    },
    {
      id: 'mdl_qc_dup_1',
      provider_id: secondaryProvider.id,
      model_name: 'gpt-5.5-2026-04-24',
      capability: 'chat',
      display_name: 'gpt-5.5-2026-04-24',
      price_input_per_1m: 0.6,
      price_output_per_1m: 1.1,
      context_length: 128000,
    },
    {
      id: 'mdl_qc_unique_0',
      provider_id: primaryProvider.id,
      model_name: 'deepseek-v3',
      capability: 'chat',
      display_name: 'DeepSeek V3',
      price_input_per_1m: 0.3,
      price_output_per_1m: 0.8,
      context_length: 64000,
    },
    {
      id: 'mdl_qc_unique_1',
      provider_id: secondaryProvider.id,
      model_name: 'qwen3-max',
      capability: 'chat',
      display_name: 'Qwen3 Max',
      price_input_per_1m: 0.4,
      price_output_per_1m: 0.9,
      context_length: 64000,
    },
  ];
  for (const row of rows) {
    await authedFetch(env, '/v1/models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(row),
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
  await page.getByTestId('composer-tools-toggle').click();
  await expect(page.getByTestId('composer-quick-compare')).toBeVisible();
  await page.getByTestId('composer-quick-compare').click();
  await expect(page.getByTestId('quick-compare-picker')).toBeVisible();
  await expect(page.getByTestId('quick-compare-picker-count')).toContainText('已选 3/3');
  await page.getByTestId('quick-compare-picker-submit').click();

  await expect(page.getByTestId('quick-compare-card')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('quick-compare-output')).toHaveCount(3, { timeout: 15_000 });
  await expect(page.getByTestId('quick-compare-output').first()).toContainText('Quick Compare 本地预览');
  await expect(page.getByTestId('quick-compare-output').first()).toContainText('首字');
  await expect(page.getByTestId('quick-compare-output').first()).toContainText('总耗时');
  await expect(page.getByTestId('quick-compare-arbitration')).toContainText('对比报告');
  await expect(page.getByTestId('quick-compare-arbitration')).toContainText('置信度');
  await expect(page.getByTestId('quick-compare-decision-report')).toContainText('推荐方案');
  await expect(page.getByTestId('quick-compare-decision-report')).toContainText('总成本');
  await page.getByTestId('quick-compare-copy-report').click();
  await expect(page.getByTestId('quick-compare-report-action')).toContainText('已复制');
  await page.getByTestId('quick-compare-draft-follow-up').click();
  await expect(page.getByTestId('quick-compare-report-action')).toContainText('已把复查提示放入输入框');
  await expect(page.getByTestId('composer-input')).toContainText('最终推荐方案');
  await expect(page.getByTestId('composer-input')).toContainText('给我三个产品改进建议');
  await page.getByTestId('quick-compare-draft-minority-review').click();
  await expect(page.getByTestId('quick-compare-report-action')).toContainText('已把少数意见复核提示放入输入框');
  await expect(page.getByTestId('composer-input')).toContainText('少数意见最强论据');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('quick-compare-download-report').click(),
  ]);
  expect(download.suggestedFilename()).toContain('quick-compare_');

  await page.getByTestId('quick-compare-adopt-recommended').click();
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
  await page.getByTestId('composer-tools-toggle').click();
  await expect(page.getByTestId('composer-quick-compare')).toBeVisible();
  await page.getByTestId('composer-quick-compare').click();
  await expect(page.getByTestId('quick-compare-picker')).toBeVisible();
  await expect(page.getByTestId('quick-compare-picker-count')).toContainText('已选 3/3');
  await page.locator('[data-testid^="quick-compare-model-check-"]').nth(2).uncheck();
  await expect(page.getByTestId('quick-compare-picker-count')).toContainText('已选 2/3');
  await page.getByTestId('quick-compare-picker-submit').click();

  await expect(page.getByTestId('quick-compare-card')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('quick-compare-output')).toHaveCount(2, { timeout: 15_000 });
});

test('Quick Compare picker lets user disable tools for one column independently', async ({ page }) => {
  const env = readSidecarEnv();
  await resetSidecar(env);
  await seedCompareModels(env);
  await page.addInitScript(() => {
    localStorage.setItem('tip_roundtable_first_seen', 'true');
  });

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 15_000 });

  await page.getByTestId('composer-input').fill('请联网比较三个产品方案');
  await page.getByTestId('composer-tools-toggle').click();
  await expect(page.getByTestId('composer-quick-compare')).toBeVisible();
  await page.getByTestId('composer-quick-compare').click();
  await expect(page.getByTestId('quick-compare-picker')).toBeVisible();
  await expect(page.locator('[data-testid^="quick-compare-model-tools-"]').last()).toBeVisible();

  const enabledToolInputs = page
    .locator('[data-testid^="quick-compare-model-option-"]')
    .filter({ hasText: 'QC Model 2' })
    .locator('[data-testid^="quick-compare-tool-option-"] input:checked');
  const count = await enabledToolInputs.count();
  for (let i = 0; i < count; i++) {
    await enabledToolInputs.nth(0).uncheck();
  }

  await page.getByTestId('quick-compare-picker-submit').click();

  await expect(page.getByTestId('quick-compare-card')).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByTestId('quick-compare-output').filter({ hasText: 'QC Model 2' }),
  ).toContainText('无工具');
});

test('Quick Compare defaults prefer distinct labels and disambiguate duplicate provider names', async ({ page }) => {
  const env = readSidecarEnv();
  await resetSidecar(env);
  await seedDuplicateLabelCompareModels(env);
  await page.addInitScript(() => {
    localStorage.setItem('tip_roundtable_first_seen', 'true');
  });

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 15_000 });

  await page.getByTestId('composer-input').fill('帮我比较这几个大模型');
  await page.getByTestId('composer-tools-toggle').click();
  await expect(page.getByTestId('composer-quick-compare')).toBeVisible();
  await page.getByTestId('composer-quick-compare').click();
  await expect(page.getByTestId('quick-compare-picker')).toBeVisible();

  const duplicateOptionTexts = await page
    .locator('[data-testid^="quick-compare-model-option-"] strong')
    .filter({ hasText: 'gpt-5.5-2026-04-24 · 向量引擎' })
    .allTextContents();
  expect(duplicateOptionTexts).toHaveLength(2);
  expect(new Set(duplicateOptionTexts).size).toBe(2);

  const checkedTexts = await page
    .locator('[data-testid^="quick-compare-model-option-"]:has(input:checked) strong')
    .allTextContents();
  expect(checkedTexts.filter((text) => text.includes('gpt-5.5-2026-04-24 · 向量引擎'))).toHaveLength(1);

  await page.getByTestId('quick-compare-picker-submit').click();
  await expect(page.getByTestId('quick-compare-output')).toHaveCount(3, { timeout: 15_000 });
  await expect(page.getByTestId('quick-compare-grid')).toContainText('DeepSeek V3');
  await expect(page.getByTestId('quick-compare-grid')).toContainText('Qwen3 Max');
});
