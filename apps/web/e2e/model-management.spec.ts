import { expect, test } from '@playwright/test';
import { clearAllData, sidecarJson } from './test-api';

test('model management: wizard happy path — preset → connect → manual fallback → set default → rename → delete', async ({ page }) => {
  await clearAllData();
  await page.goto('/');

  // Empty state shows the "no model" CTA pill
  await expect(page.getByTestId('empty-no-model-cta')).toBeVisible();

  // Click the CTA → lands on 模型 tab with the prominent "添加第一个模型" CTA
  await page.getByTestId('empty-no-model-cta').click();
  await expect(page.getByRole('heading', { name: '模型', exact: true })).toBeVisible();
  await expect(page.getByTestId('empty-add-model-cta')).toBeVisible();

  // Open the wizard
  await page.getByTestId('empty-add-model-cta').click();
  await expect(page.getByTestId('add-model-wizard')).toBeVisible();

  // Step 1 — pick the Ollama preset (no key needed)
  await page.getByTestId('wizard-preset-ollama').click();
  await page.getByTestId('wizard-next').click();

  // Step 2 — connect step shows "no API Key required" banner; just click connect
  await expect(page.getByTestId('wizard-connect')).toBeVisible();
  await page.getByTestId('wizard-connect').click();

  // Step 3 — discover will fail because no real ollama runs in test env; wizard falls to manual form
  await expect(page.getByTestId('wizard-discover-error')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('wizard-manual-model-name').fill('llama3.1:latest');
  await page.getByTestId('wizard-manual-display-name').fill('Llama 3.1');
  await page.getByTestId('wizard-finish').click();
  await expect(page.locator('.toast').filter({ hasText: /已添加/ })).toBeVisible({ timeout: 10_000 });

  // Model inventory contains the new model; set it as the default from the row action.
  const row = page.locator('.model-row-card', { hasText: 'Llama 3.1' });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: '设为默认' }).click();
  await expect(page.getByTestId('model-default-summary')).toContainText('Llama 3.1');

  // The provider was auto-created by the wizard — capture its name for cleanup
  const providers = await sidecarJson<{ providers: Array<{ id: string; name: string }> }>('/v1/providers');
  expect(providers.providers).toHaveLength(1);
  const providerName = providers.providers[0]!.name;

  // Empty state CTA should disappear once a chat model exists
  await page.getByRole('button', { name: /新对话/ }).first().click();
  await expect(page.getByTestId('empty-no-model-cta')).toHaveCount(0);
  await expect(page.locator('[data-testid="composer-send"], [data-testid="composer-stop"]')).toBeVisible();

  // Rename alias via the per-row ⋯ menu
  await page.getByRole('button', { name: '设置' }).first().click();
  await expect(page.getByRole('heading', { name: '模型', exact: true })).toBeVisible();
  await row.locator('details summary').click(); // open ⋯ menu
  await page.getByRole('menuitem', { name: '重命名为别名' }).click();
  const aliasInput = page.locator('input.alias-input');
  await expect(aliasInput).toBeVisible();
  await aliasInput.fill('我的小羊驼');
  await aliasInput.press('Enter');
  await expect(page.locator('.toast').filter({ hasText: '已更新模型别名' })).toBeVisible();
  await expect(page.getByTestId('model-default-summary')).toContainText('我的小羊驼');

  // Cleanup — the menu path was already exercised by rename; use API here to keep cleanup deterministic.
  const modelData = await sidecarJson<{ models: Array<{ id: string; alias: string | null }> }>('/v1/models');
  const renamedModelId = modelData.models.find((item) => item.alias === '我的小羊驼')?.id;
  expect(renamedModelId).toBeTruthy();
  await sidecarJson(`/v1/models/${renamedModelId}`, { method: 'DELETE' });
  await page.reload();
  await page.getByRole('button', { name: '设置' }).first().click();
  await expect(page.getByText('还没有任何模型。点上方「+ 添加模型」开始。')).toBeVisible();

  await page.getByRole('button', { name: '服务商', exact: true }).click();
  const providerCard = page.locator('.provider-card', { hasText: providerName });
  await expect(providerCard).toBeVisible();
  await providerCard.locator('details summary').click();
  await page.getByRole('menuitem', { name: '删除整个服务商' }).click();
  await expect(page.getByTestId('app-dialog')).toContainText('删除服务商');
  await page.getByTestId('app-dialog-ok').click();
  await expect(page.locator('.toast').filter({ hasText: '已删除' })).toBeVisible();
});

test('model management: multimodal model is promoted as default chat model', async ({ page }) => {
  await clearAllData();
  const providerName = `Multi-${Date.now()}`;
  const modelName = 'Vision Chat';

  // Seed provider + multimodal model directly via API
  const provider = await sidecarJson<{ id: string }>('/v1/providers', {
    method: 'POST',
    body: JSON.stringify({
      name: providerName,
      type: 'ollama',
      base_url: 'http://127.0.0.1:11434/v1',
      enabled: true,
    }),
  });
  const model = await sidecarJson<{ id: string }>('/v1/models', {
    method: 'POST',
    body: JSON.stringify({
      provider_id: provider.id,
      model_name: 'vision-chat:test',
      display_name: modelName,
      capability: 'multimodal',
      supports_vision: true,
    }),
  });

  await page.goto('/');
  await page.getByRole('button', { name: '设置' }).first().click();
  await page.getByRole('button', { name: '模型', exact: true }).click();
  const row = page.locator('.model-row-card', { hasText: modelName });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: '设为默认' }).click();
  await expect(page.locator('.toast').filter({ hasText: '已设为默认 chat' })).toBeVisible();
  await expect(page.getByTestId('model-default-summary')).toContainText(modelName);

  const models = await sidecarJson<{ models: Array<{ id: string; is_default_for: string | null }> }>('/v1/models');
  const defaultFlag = models.models.find((item) => item.id === model.id)?.is_default_for ?? null;
  expect(defaultFlag).toBe('chat');

  // Cleanup — via API (delete provider cascades models)
  await sidecarJson(`/v1/providers/${provider.id}`, { method: 'DELETE' });
});

test('model management: manual model remains available when discovery returns models', async ({ page }) => {
  await clearAllData();
  await sidecarJson('/v1/providers', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Discovery OK',
      type: 'custom',
      base_url: 'https://example.com/v1',
      enabled: true,
    }),
  });
  const providers = await sidecarJson<{ providers: Array<{ id: string }> }>('/v1/providers');
  const providerId = providers.providers[0]!.id;

  await page.route(`**/v1/providers/${providerId}/discover`, async (route) => {
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider_id: providerId,
        recommended: { chat: 'listed-chat', vision: null },
        models: [
          {
            model_name: 'listed-chat',
            display_name: 'Listed Chat',
            capability: 'chat',
            price_input_per_1m: null,
            price_output_per_1m: null,
            context_length: 8192,
            supports_vision: false,
            supports_tools: false,
            modalities: ['text'],
          },
        ],
      }),
    });
  });

  await page.goto('/');
  await page.getByTestId('empty-no-model-cta').click();
  await page.getByTestId('empty-add-model-cta').click();
  await page.getByTestId(`wizard-existing-${providerId}`).click();
  await page.getByTestId('wizard-next').click();

  await expect(page.getByTestId('wizard-discovery-row-listed-chat')).toBeVisible();
  await expect(page.getByTestId('wizard-manual-model-name')).toBeVisible();
  await page.getByTestId('wizard-manual-model-name').fill('unlisted-chat');
  await page.getByTestId('wizard-manual-display-name').fill('Unlisted Chat');
  await expect(page.getByTestId('wizard-finish')).toContainText('添加 2 个模型');
  await page.getByTestId('wizard-finish').click();

  await expect.poll(async () => {
    const data = await sidecarJson<{ models: Array<{ model_name: string }> }>('/v1/models');
    return data.models.map((model) => model.model_name).sort();
  }).toEqual(['listed-chat', 'unlisted-chat']);

  await sidecarJson(`/v1/providers/${providerId}`, { method: 'DELETE' });
});

test('model management: bulk delete and alias blur commit', async ({ page }) => {
  await clearAllData();
  const provider = await sidecarJson<{ id: string }>('/v1/providers', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Bulk Provider',
      type: 'custom',
      base_url: 'https://example.com/v1',
      enabled: true,
    }),
  });
  const first = await sidecarJson<{ id: string }>('/v1/models', {
    method: 'POST',
    body: JSON.stringify({
      provider_id: provider.id,
      model_name: 'bulk-a',
      display_name: 'Bulk A',
      capability: 'chat',
    }),
  });
  const second = await sidecarJson<{ id: string }>('/v1/models', {
    method: 'POST',
    body: JSON.stringify({
      provider_id: provider.id,
      model_name: 'bulk-b',
      display_name: 'Bulk B',
      capability: 'chat',
    }),
  });

  await page.goto('/');
  await page.getByRole('button', { name: '设置' }).first().click();
  await page.getByRole('button', { name: '模型', exact: true }).click();

  const firstRow = page.locator('.model-row-card', { hasText: 'Bulk A' });
  const firstMenu = page.getByTestId(`model-actions-${first.id}`);
  await firstRow.locator('details summary').click();
  await page.getByRole('menuitem', { name: '重命名为别名' }).click();
  await expect(firstMenu).not.toHaveAttribute('open', '');
  const aliasInput = page.getByTestId(`model-alias-input-${first.id}`);
  await aliasInput.fill('Bulk Alias');
  await page.getByTestId(`model-select-${second.id}`).click();
  await expect(page.locator('.toast').filter({ hasText: '已更新模型别名' })).toBeVisible();
  await expect(aliasInput).toHaveCount(0);
  await expect(firstRow).toContainText('Bulk Alias');

  await page.getByTestId(`model-select-${first.id}`).click();
  await expect(page.getByText('已选 2 个')).toBeVisible();
  await page.getByTestId('model-bulk-delete').click();
  await expect(page.getByTestId('app-dialog')).toContainText('删除 2 个模型');
  await page.getByTestId('app-dialog-ok').click();
  await expect(page.locator('.toast').filter({ hasText: '已删除 2 个模型' })).toBeVisible();

  await expect.poll(async () => {
    const data = await sidecarJson<{ models: Array<{ id: string }> }>('/v1/models');
    return data.models.length;
  }).toBe(0);

  await sidecarJson(`/v1/providers/${provider.id}`, { method: 'DELETE' });
});

test('model management: filtering clears selection so hidden rows are not bulk deleted', async ({ page }) => {
  await clearAllData();
  const provider = await sidecarJson<{ id: string }>('/v1/providers', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Filter Provider',
      type: 'custom',
      base_url: 'https://example.com/v1',
      enabled: true,
    }),
  });
  const hidden = await sidecarJson<{ id: string }>('/v1/models', {
    method: 'POST',
    body: JSON.stringify({
      provider_id: provider.id,
      model_name: 'hidden-model',
      display_name: 'Hidden Model',
      capability: 'chat',
    }),
  });
  const visible = await sidecarJson<{ id: string }>('/v1/models', {
    method: 'POST',
    body: JSON.stringify({
      provider_id: provider.id,
      model_name: 'visible-model',
      display_name: 'Visible Model',
      capability: 'chat',
    }),
  });

  await page.goto('/');
  await page.getByRole('button', { name: '设置' }).first().click();
  await page.getByRole('button', { name: '模型', exact: true }).click();

  await page.getByTestId(`model-select-${hidden.id}`).click();
  await expect(page.getByText('已选 1 个')).toBeVisible();
  await page.getByTestId('model-search').fill('Visible');
  await expect(page.getByText('选择当前列表')).toBeVisible();
  await expect(page.getByTestId('model-bulk-delete')).toHaveCount(0);

  await page.getByTestId(`model-select-${visible.id}`).click();
  await page.getByTestId('model-bulk-delete').click();
  await expect(page.getByTestId('app-dialog')).toContainText('删除 1 个模型');
  await page.getByTestId('app-dialog-ok').click();

  await expect.poll(async () => {
    const data = await sidecarJson<{ models: Array<{ model_name: string }> }>('/v1/models');
    return data.models.map((model) => model.model_name);
  }).toEqual(['hidden-model']);

  await sidecarJson(`/v1/providers/${provider.id}`, { method: 'DELETE' });
});

test('model management: status filter surfaces unavailable models and inline enable restores action', async ({ page }) => {
  await clearAllData();
  const provider = await sidecarJson<{ id: string }>('/v1/providers', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Status Provider',
      type: 'custom',
      base_url: 'https://example.com/v1',
      enabled: true,
    }),
  });
  const disabled = await sidecarJson<{ id: string }>('/v1/models', {
    method: 'POST',
    body: JSON.stringify({
      provider_id: provider.id,
      model_name: 'disabled-chat',
      display_name: 'Disabled Chat',
      capability: 'chat',
      enabled: false,
    }),
  });
  const ready = await sidecarJson<{ id: string }>('/v1/models', {
    method: 'POST',
    body: JSON.stringify({
      provider_id: provider.id,
      model_name: 'ready-chat',
      display_name: 'Ready Chat',
      capability: 'chat',
    }),
  });

  await page.goto('/');
  await page.getByRole('button', { name: '设置' }).first().click();
  await page.getByRole('button', { name: '模型', exact: true }).click();

  await expect(page.getByTestId('model-default-summary')).toContainText('1/2 个聊天模型可用');
  await page.getByTestId('model-status-filter').selectOption('unavailable');
  await expect(page.getByTestId(`model-row-${disabled.id}`)).toContainText('已停用');
  await expect(page.getByTestId(`model-row-${ready.id}`)).toHaveCount(0);
  await expect(page.getByTestId(`model-set-default-${disabled.id}`)).toHaveCount(0);

  await page.getByTestId(`model-enable-${disabled.id}`).click();
  await expect(page.locator('.toast').filter({ hasText: 'Disabled Chat 已启用' })).toBeVisible();
  await expect(page.getByText('没有匹配的模型。换个搜索词或筛选条件试试。')).toBeVisible();

  await page.getByTestId('model-status-filter').selectOption('available');
  await expect(page.getByTestId(`model-row-${disabled.id}`)).toContainText('可用');
  await expect(page.getByTestId(`model-row-${ready.id}`)).toBeVisible();

  await sidecarJson(`/v1/providers/${provider.id}`, { method: 'DELETE' });
});

test('model management: disabled provider model stays visible but cannot be set as default', async ({ page }) => {
  await clearAllData();
  const provider = await sidecarJson<{ id: string }>('/v1/providers', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Paused Provider',
      type: 'custom',
      base_url: 'https://example.com/v1',
    }),
  });
  await sidecarJson(`/v1/providers/${provider.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ enabled: false }),
  });
  const pausedModel = await sidecarJson<{ id: string }>('/v1/models', {
    method: 'POST',
    body: JSON.stringify({
      provider_id: provider.id,
      model_name: 'paused-chat',
      display_name: 'Paused Chat',
      capability: 'chat',
    }),
  });

  await page.goto('/');
  await page.getByRole('button', { name: '设置' }).first().click();
  await page.getByRole('button', { name: '模型', exact: true }).click();
  await page.getByTestId('model-status-filter').selectOption('unavailable');

  const row = page.getByTestId(`model-row-${pausedModel.id}`);
  await expect(row).toContainText('服务商停用');
  await expect(page.getByTestId(`model-set-default-${pausedModel.id}`)).toHaveCount(0);
  await expect(page.getByTestId(`model-enable-${pausedModel.id}`)).toHaveCount(0);

  await sidecarJson(`/v1/providers/${provider.id}`, { method: 'DELETE' });
});
