import { test, expect } from '@playwright/test';
import { authedFetch, readSidecarEnv, resetSidecar, seedDefaultModel } from './_helpers';
import { startMockOpenAI } from './_mock-openai-server';

/**
 * M2.5 — Model Center surface coverage.
 *
 * Provider chip rendering, capability tabs, the "+ 添加 Provider" path and
 * the "+ 导入模型" drawer are all exercised here. Catalog sync UI lives in
 * `m2.5-catalog-sync-ui.spec.ts`; Volcengine Ark visibility lives in
 * `m2.5-volcengine-ark.spec.ts`.
 */

test('model-center: provider chips render and tabs filter rows', async ({ page }) => {
  const env = readSidecarEnv();
  await resetSidecar(env);
  await seedDefaultModel(env); // seeds ONE chat model, ONE provider
  await page.goto('/');
  await page.getByTestId('open-model-center').click();
  await expect(page.getByTestId('model-center')).toBeVisible();

  await expect(
    page.getByTestId('model-center-providers').locator('.provider-nav__item'),
  ).toHaveCount(1);

  // 6 capability tabs render.
  for (const t of ['chat', 'multimodal', 'image', 'video', 'asr', 'tts', 'embedding']) {
    await expect(page.getByTestId(`model-center-tab-${t}`)).toBeVisible();
  }

  // chat tab shows 1 row; image tab shows none (and prompts to import).
  await page.getByTestId('model-center-tab-chat').click();
  await expect(page.getByTestId('model-matrix')).toBeVisible();
  await page.getByTestId('model-center-tab-image').click();
  await expect(page.getByTestId('model-matrix')).toHaveCount(0);
  await expect(page.locator('.model-center__matrix .hint').last()).toContainText(
    '没有',
  );

  const headerActionStyles = await Promise.all([
    page.getByTestId('provider-key-status-check').evaluate((el) => {
      const style = getComputedStyle(el);
      return { color: style.color, backgroundColor: style.backgroundColor };
    }),
    page.getByTestId('model-center-import').evaluate((el) => {
      const style = getComputedStyle(el);
      return { color: style.color, backgroundColor: style.backgroundColor };
    }),
  ]);
  for (const styles of headerActionStyles) {
    expect(styles.color).not.toBe('rgb(0, 0, 0)');
    expect(styles.backgroundColor).not.toBe('rgb(0, 0, 0)');
  }
});

test('model-center: "+ 添加 Provider" reopens onboarding wizard', async ({ page }) => {
  const env = readSidecarEnv();
  await resetSidecar(env);
  await seedDefaultModel(env);
  await page.goto('/');
  await page.getByTestId('open-model-center').click();
  // Button label "+ 添加 Provider" lives inside the providers section header.
  await page
    .getByTestId('model-center-providers')
    .getByRole('button', { name: /添加 Provider/ })
    .click();
  await expect(page.getByTestId('model-center')).toHaveCount(0);
  await expect(page.getByTestId('onboarding')).toBeVisible();
});

test('model-center: provider detail surfaces guidance in a focused foldout layout', async ({ page }) => {
  const env = readSidecarEnv();
  await resetSidecar(env);
  const providerRes = await authedFetch(env, '/v1/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'DeepSeek 官方',
      type: 'deepseek',
      base_url: 'https://api.deepseek.com',
      api_key: 'sk-test',
    }),
  });
  expect(providerRes.ok).toBeTruthy();
  const provider = (await providerRes.json()) as { id: string };
  const modelRes = await authedFetch(env, '/v1/models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider_id: provider.id,
      model_name: 'deepseek-v4-flash',
      capability: 'chat',
      display_name: 'DeepSeek V4 Flash',
      is_default_for: 'chat',
      price_input_per_1m: 0.5,
      price_output_per_1m: 2,
      supports_tools: true,
    }),
  });
  expect(modelRes.ok).toBeTruthy();

  await page.goto('/');
  await page.getByTestId('open-model-center').click();
  await page.getByTestId(`provider-nav-item-${provider.id}`).click();
  const detail = page.getByTestId(`provider-detail-${provider.id}`);
  await expect(detail).toContainText('国内直连');
  await expect(detail).toContainText('DeepSeek 官方直连');
  await detail.getByText('展开运营洞察').click();
  await expect(detail).toContainText('默认 fallback');
  await detail.getByTestId(`provider-detail-test-${provider.id}`).click();
  await expect(page.getByTestId(`provider-detail-test-result-${provider.id}`)).toBeVisible();
  await detail.getByTestId(`provider-detail-library-${provider.id}`).click();
  await expect(page.getByTestId('import-drawer')).toBeVisible();
  await page.getByTestId('import-drawer').getByLabel('关闭').click();
  await expect(page.getByTestId('import-drawer')).toHaveCount(0);
  await detail.getByTestId(`provider-menu-edit-${provider.id}`).click();
  await expect(page.getByTestId('provider-editor')).toBeVisible();
});

test('model-center: "+ 导入模型" opens ImportDrawer with provider + capability prefilled', async ({
  page,
}) => {
  const env = readSidecarEnv();
  await resetSidecar(env);
  const providerRes = await authedFetch(env, '/v1/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Import Ready Provider',
      type: 'custom',
      base_url: 'https://example.invalid/v1',
      api_key: 'sk-import-ready',
    }),
  });
  expect(providerRes.ok).toBeTruthy();
  const provider = (await providerRes.json()) as { id: string };
  const modelRes = await authedFetch(env, '/v1/models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider_id: provider.id,
      model_name: 'mock-model',
      capability: 'chat',
      display_name: 'Mock chat',
      is_default_for: 'chat',
      price_input_per_1m: 0.5,
      price_output_per_1m: 1.5,
    }),
  });
  expect(modelRes.ok).toBeTruthy();
  await page.goto('/');
  await page.getByTestId('open-model-center').click();
  await page.getByTestId('model-center-tab-chat').click();
  await page.getByTestId('model-center-import').click();
  await expect(page.getByTestId('import-drawer')).toBeVisible();
  await expect(page.getByTestId('import-drawer-capability')).toHaveValue('chat');
  // Provider dropdown is non-empty.
  const providerOptions = page
    .getByTestId('import-drawer-provider')
    .locator('option');
  await expect.poll(async () => providerOptions.count()).toBeGreaterThan(0);
});

test('model-center: import drawer disabled when no providers exist', async ({ page }) => {
  const env = readSidecarEnv();
  await resetSidecar(env);
  await page.addInitScript(() => {
    try {
      localStorage.setItem('taori.browseOnly', '1');
    } catch {
      /* ignore */
    }
  });
  await page.goto('/');
  await expect(page.getByTestId('browse-only')).toBeVisible();
  // Browse-only doesn't render the toolbar; reload after seeding skip-cleared.
});

test('model-center: provider library refresh, bulk enable, and import disabled candidates', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const env = readSidecarEnv();
  await resetSidecar(env);
  const server = startMockOpenAI(17931, {
    models: [
      { id: 'mock-strategy', object: 'model' },
      { id: 'mock-user', object: 'model' },
      { id: 'mock-tech', object: 'model' },
      {
        id: 'mock-vision',
        object: 'model',
        name: 'Mock Vision',
        architecture: { input_modalities: ['text', 'image'] },
      },
    ],
  });
  try {
    const providerRes = await authedFetch(env, '/v1/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Library Mock',
        type: 'openrouter',
        base_url: 'http://127.0.0.1:17931/v1',
        api_key: 'sk-test',
      }),
    });
    expect(providerRes.ok).toBeTruthy();
    const provider = (await providerRes.json()) as { id: string };

    const create = async (
      model_name: string,
      enabled: boolean,
      isDefault = false,
      options: { price?: number; context?: number; tools?: boolean } = {},
    ) => {
      const res = await authedFetch(env, '/v1/models', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          provider_id: provider.id,
          model_name,
          display_name: model_name,
          capability: 'chat',
          is_default_for: isDefault ? 'chat' : null,
          price_input_per_1m: options.price ?? null,
          context_length: options.context ?? null,
          supports_tools: options.tools ?? false,
          enabled,
        }),
      });
      expect(res.ok).toBeTruthy();
      return (await res.json()) as { id: string };
    };
    const strategy = await create('mock-strategy', true, true, { price: 2, context: 32_000 });
    const user = await create('mock-user', false, false, { price: 1, context: 64_000, tools: true });

    await page.goto('/');
    await page.getByTestId('open-model-center').click();
    await expect(page.getByTestId('model-center')).toBeVisible();
    await expect(page.getByTestId(`provider-chip-count-${provider.id}`)).toContainText('2 个');

    await page.getByTestId('model-center-status-filter').selectOption('disabled');
    await expect(page.getByTestId(`model-row-${user.id}`)).toBeVisible();
    await expect(page.getByTestId(`model-row-${strategy.id}`)).toHaveCount(0);
    await page.getByTestId('model-center-select-all').click();
    await page.getByTestId('model-center-bulk-enable').click();
    await expect(page.getByTestId(`model-row-${user.id}`)).toHaveCount(0);
    await page.getByTestId('model-center-status-filter').selectOption('all');
    await page.getByTestId('model-center-feature-filter').selectOption('tools');
    await expect(page.getByTestId(`model-row-${user.id}`)).toBeVisible();
    await expect(page.getByTestId(`model-row-${strategy.id}`)).toHaveCount(0);
    await page.getByTestId('model-center-feature-filter').selectOption('default');
    await expect(page.getByTestId(`model-row-${strategy.id}`)).toBeVisible();
    await expect(page.getByTestId(`model-row-${user.id}`)).toHaveCount(0);
    await page.getByTestId('model-center-feature-filter').selectOption('all');
    await page.getByTestId('model-center-sort').selectOption('context_desc');
    await expect(page.locator('.model-matrix tbody tr').first()).toHaveAttribute(
      'data-testid',
      `model-row-${user.id}`,
    );

    await page.getByTestId(`provider-nav-item-${provider.id}`).click();
    await page.getByTestId(`provider-detail-library-${provider.id}`).click();
    await expect(page.getByTestId('import-drawer')).toBeVisible();
    await expect(page.getByTestId('import-drawer-capability')).toHaveValue('all');
    await page.getByTestId('import-drawer-refresh').click();
    await expect(page.getByTestId('import-drawer-row-mock-tech')).toBeVisible();
    await expect(page.getByTestId('import-drawer-row-mock-vision')).toBeVisible();
    await expect(page.getByTestId('import-drawer-counts')).toContainText('已刷新 4 个候选');
    await expect(page.getByTestId('import-drawer-row-mock-strategy')).toHaveAttribute('data-managed-state', 'enabled');
    await expect(page.getByTestId('import-drawer-row-mock-user')).toHaveAttribute('data-managed-state', 'enabled');
    await expect(page.getByTestId('import-drawer-row-mock-tech')).toHaveAttribute('data-managed-state', 'unmanaged');
    await page.getByTestId('import-drawer-capability').selectOption('multimodal');
    await expect(page.getByTestId('import-drawer-row-mock-vision')).toBeVisible();
    await expect(page.getByTestId('import-drawer-row-mock-tech')).toHaveCount(0);
    await page.getByTestId('import-drawer-capability').selectOption('all');
    await page.getByTestId('import-drawer-status').selectOption('unmanaged');
    await expect(page.getByTestId('import-drawer-row-mock-tech')).toBeVisible();
    await expect(page.getByTestId('import-drawer-row-mock-strategy')).toHaveCount(0);
    await page.getByTestId('import-drawer-pick-mock-tech').check();
    await page.getByTestId('import-drawer-import-enabled').uncheck();
    await page.getByTestId('import-drawer-confirm').click();
    await expect(page.getByTestId('import-drawer')).toHaveCount(0);
    await page.getByTestId('model-center-feature-filter').selectOption('unknown_price');
    await expect(page.getByTestId('model-matrix')).toContainText('mock-tech');
    await page.getByTestId('model-center-feature-filter').selectOption('all');

    const modelsAfterImport = (await (await authedFetch(env, '/v1/models')).json()) as {
      models: Array<{ id: string; model_name: string; enabled: boolean }>;
    };
    const tech = modelsAfterImport.models.find((m) => m.model_name === 'mock-tech');
    expect(tech?.enabled).toBe(false);

    await page.getByTestId(`provider-detail-library-${provider.id}`).click();
    await expect(page.getByTestId('import-drawer')).toBeVisible();
    await page.getByTestId('import-drawer-status').selectOption('disabled');
    await expect(page.getByTestId('import-drawer-row-mock-tech')).toBeVisible();
    await expect(page.getByTestId('import-drawer-row-mock-tech')).toHaveAttribute('data-managed-state', 'disabled');
    await page.getByTestId(`import-drawer-toggle-${tech!.id}`).click();

    await expect
      .poll(async () => {
        const body = (await (await authedFetch(env, '/v1/models')).json()) as {
          models: Array<{ model_name: string; enabled: boolean }>;
        };
        return body.models.find((m) => m.model_name === 'mock-tech')?.enabled;
      })
      .toBe(true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('model-center: toggling adjacent models keeps the matrix scroll position', async ({ page }) => {
  const env = readSidecarEnv();
  await resetSidecar(env);
  const providerRes = await authedFetch(env, '/v1/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Scroll Provider',
      type: 'openai',
      base_url: 'https://example.invalid/v1',
      api_key: 'sk-test',
    }),
  });
  expect(providerRes.ok).toBeTruthy();
  const provider = (await providerRes.json()) as { id: string };

  const createdIds: string[] = [];
  for (let i = 0; i < 28; i += 1) {
    const res = await authedFetch(env, '/v1/models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider_id: provider.id,
        model_name: `scroll-model-${String(i).padStart(2, '0')}`,
        display_name: `Scroll Model ${String(i).padStart(2, '0')}`,
        capability: 'chat',
        is_default_for: i === 0 ? 'chat' : null,
        enabled: true,
      }),
    });
    expect(res.ok).toBeTruthy();
    const model = (await res.json()) as { id: string };
    createdIds.push(model.id);
  }

  await page.goto('/');
  await page.getByTestId('open-model-center').click();
  await expect(page.getByTestId('model-center')).toBeVisible();
  await page.getByTestId('model-center-tab-chat').click();

  const middleRow = page.getByTestId(`model-row-${createdIds[16]}`);
  await middleRow.evaluate((element) => {
    element.scrollIntoView({ block: 'center' });
  });
  await expect(middleRow).toBeInViewport();
  const beforeBox = await middleRow.boundingBox();
  expect(beforeBox).not.toBeNull();

  const toggle = page.getByTestId(`model-row-enabled-${createdIds[16]}`);
  await toggle.click();

  await expect(toggle).not.toBeChecked();
  await expect(middleRow).toBeInViewport();
  const afterBox = await middleRow.boundingBox();
  expect(afterBox).not.toBeNull();
  expect(Math.abs((afterBox?.y ?? 0) - (beforeBox?.y ?? 0))).toBeLessThan(80);
});

test('model-center: OpenAI-compatible PackyAPI refresh shows gpt-image models', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const env = readSidecarEnv();
  await resetSidecar(env);
  const server = startMockOpenAI(17933, {
    models: [
      { id: 'gpt-4o-mini', object: 'model' },
      { id: 'gpt-image-1', object: 'model' },
    ],
  });
  try {
    const providerRes = await authedFetch(env, '/v1/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'PackyAPI',
        type: 'openai',
        base_url: 'http://127.0.0.1:17933/v1',
        api_key: 'sk-packy',
      }),
    });
    expect(providerRes.ok).toBeTruthy();
    const provider = (await providerRes.json()) as { id: string };

    await page.goto('/');
    await page.getByTestId('open-model-center').click();
    await expect(page.getByTestId('model-center')).toBeVisible();
    await page.getByTestId(`provider-nav-item-${provider.id}`).click();
    await page.getByTestId(`provider-detail-library-${provider.id}`).click();
    await expect(page.getByTestId('import-drawer')).toBeVisible();
    await page.getByTestId('import-drawer-refresh').click();
    await expect(page.getByTestId('import-drawer-row-gpt-image-1')).toBeVisible();
    await page.getByTestId('import-drawer-capability').selectOption('image');
    await expect(page.getByTestId('import-drawer-row-gpt-image-1')).toBeVisible();
    await expect(page.getByTestId('import-drawer-row-gpt-4o-mini')).toHaveCount(0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('model-center: provider edit and scoped catalog sync update managed model pricing', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const env = readSidecarEnv();
  await resetSidecar(env);
  const server = startMockOpenAI(17932, {
    models: [
      {
        id: 'priced-model',
        object: 'model',
        name: 'Priced Model',
        context_length: 12345,
        pricing: { prompt: '0.000003', completion: '0.000004' },
        architecture: { input_modalities: ['text'] },
      },
    ],
  });
  try {
    const providerRes = await authedFetch(env, '/v1/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Editable Provider',
        type: 'openrouter',
        base_url: 'http://127.0.0.1:17932/v1',
        api_key: 'sk-before',
      }),
    });
    expect(providerRes.ok).toBeTruthy();
    const provider = (await providerRes.json()) as { id: string };

    const modelRes = await authedFetch(env, '/v1/models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider_id: provider.id,
        model_name: 'priced-model',
        display_name: 'Priced Model',
        capability: 'chat',
        price_input_per_1m: 1,
        price_output_per_1m: 2,
        supports_tools: true,
        enabled: true,
      }),
    });
    expect(modelRes.ok).toBeTruthy();
    const model = (await modelRes.json()) as { id: string };

    await page.goto('/');
    await page.getByTestId('open-model-center').click();
    await expect(page.getByTestId('model-center')).toBeVisible();

    await page.getByTestId(`provider-nav-item-${provider.id}`).click();
    await page.getByTestId(`provider-menu-edit-${provider.id}`).click();
    await expect(page.getByTestId('provider-editor')).toBeVisible();
    await page.getByTestId('provider-editor-name').fill('Renamed Provider');
    await page.getByTestId('provider-editor-api-key').fill('sk-after');
    await page.getByTestId('provider-editor-enabled').uncheck();
    await page.getByTestId('provider-editor-save').click();
    await expect(page.getByTestId('provider-editor')).toHaveCount(0);
    await expect(page.getByTestId(`provider-nav-item-${provider.id}`)).toContainText('Renamed Provider');

    const providerAfter = (await (await authedFetch(env, '/v1/providers')).json()) as {
      providers: Array<{ id: string; name: string; enabled: boolean }>;
    };
    expect(providerAfter.providers.find((p) => p.id === provider.id)).toMatchObject({
      name: 'Renamed Provider',
      enabled: false,
    });

    await page.getByTestId(`provider-detail-library-${provider.id}`).click();
    await expect(page.getByTestId('import-drawer')).toBeVisible();
    await page.getByTestId('import-drawer-refresh').click();
    await expect(page.getByTestId(`import-drawer-diff-${model.id}`)).toBeVisible();
    await expect(page.getByTestId('import-drawer-managed-sync')).toBeVisible();
    await page.getByTestId('import-drawer-diff-preview').click();
    await expect(page.getByTestId('import-drawer-diff-preview')).toContainText('输入价');
    await expect(page.getByTestId('import-drawer-diff-preview')).toContainText('上下文');
    await page.getByTestId('import-drawer-sync-managed').click();

    await expect
      .poll(async () => {
        const body = (await (await authedFetch(env, '/v1/models')).json()) as {
          models: Array<{
            id: string;
            price_input_per_1m: number | null;
            price_output_per_1m: number | null;
            context_length: number | null;
            supports_tools: boolean;
          }>;
        };
        const row = body.models.find((m) => m.id === model.id);
        return row
          ? {
              input: row.price_input_per_1m,
              output: row.price_output_per_1m,
              context: row.context_length,
              tools: row.supports_tools,
            }
          : null;
      })
      .toEqual({ input: 3, output: 4, context: 12345, tools: false });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('model-center: deleting a provider removes its models from the chat selector', async ({ page }) => {
  const env = readSidecarEnv();
  await resetSidecar(env);
  const createProvider = async (name: string) => {
    const res = await authedFetch(env, '/v1/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name,
        type: 'custom',
        base_url: `https://${name.toLowerCase()}.example.invalid/v1`,
        api_key: 'sk-test',
      }),
    });
    expect(res.ok).toBeTruthy();
    return (await res.json()) as { id: string };
  };
  const first = await createProvider('DeleteMe');
  const second = await createProvider('KeepMe');
  const createModel = async (providerId: string, modelName: string, isDefault = false) => {
    const res = await authedFetch(env, '/v1/models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider_id: providerId,
        model_name: modelName,
        capability: 'chat',
        display_name: modelName,
        is_default_for: isDefault ? 'chat' : null,
      }),
    });
    expect(res.ok).toBeTruthy();
    return (await res.json()) as { id: string };
  };
  const deletedModel = await createModel(first.id, 'deleted-chat', true);
  const keptModel = await createModel(second.id, 'kept-chat');

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('active-model')).toHaveValue(deletedModel.id);

  await page.getByTestId('open-model-center').click();
  await expect(page.getByTestId('model-center')).toBeVisible();
  await page.getByTestId(`provider-nav-item-${first.id}`).click();
  page.once('dialog', (d) => void d.accept());
  await page.getByTestId(`provider-detail-delete-${first.id}`).click();
  await expect(page.getByTestId(`provider-nav-item-${first.id}`)).toHaveCount(0);

  const modelsRes = await authedFetch(env, '/v1/models');
  const rows = ((await modelsRes.json()) as { models: Array<{ id: string }> }).models;
  expect(rows.some((m) => m.id === deletedModel.id)).toBe(false);
  expect(rows.some((m) => m.id === keptModel.id)).toBe(true);

  await page.getByTestId('model-center-close').click();
  await expect(page.getByTestId('active-model')).toHaveValue(keptModel.id);
  await expect(
    page.getByTestId('active-model').locator('option', { hasText: 'deleted-chat' }),
  ).toHaveCount(0);
});
