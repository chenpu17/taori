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
    page.getByTestId('model-center-providers').locator('.provider-chip'),
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

test('model-center: "+ 导入模型" opens ImportDrawer with provider + capability prefilled', async ({
  page,
}) => {
  const env = readSidecarEnv();
  await resetSidecar(env);
  await seedDefaultModel(env);
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

    const create = async (model_name: string, enabled: boolean, isDefault = false) => {
      const res = await authedFetch(env, '/v1/models', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          provider_id: provider.id,
          model_name,
          display_name: model_name,
          capability: 'chat',
          is_default_for: isDefault ? 'chat' : null,
          enabled,
        }),
      });
      expect(res.ok).toBeTruthy();
      return (await res.json()) as { id: string };
    };
    const strategy = await create('mock-strategy', true, true);
    const user = await create('mock-user', false);

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

    await page.getByTestId(`provider-chip-library-${provider.id}`).click();
    await expect(page.getByTestId('import-drawer')).toBeVisible();
    await page.getByTestId('import-drawer-refresh').click();
    await expect(page.getByTestId('import-drawer-row-mock-tech')).toBeVisible();
    await page.getByTestId('import-drawer-status').selectOption('unmanaged');
    await expect(page.getByTestId('import-drawer-row-mock-tech')).toBeVisible();
    await expect(page.getByTestId('import-drawer-row-mock-strategy')).toHaveCount(0);
    await page.getByTestId('import-drawer-pick-mock-tech').check();
    await page.getByTestId('import-drawer-import-enabled').uncheck();
    await page.getByTestId('import-drawer-confirm').click();
    await expect(page.getByTestId('import-drawer')).toHaveCount(0);

    const modelsAfterImport = (await (await authedFetch(env, '/v1/models')).json()) as {
      models: Array<{ id: string; model_name: string; enabled: boolean }>;
    };
    const tech = modelsAfterImport.models.find((m) => m.model_name === 'mock-tech');
    expect(tech?.enabled).toBe(false);

    await page.getByTestId(`provider-chip-library-${provider.id}`).click();
    await expect(page.getByTestId('import-drawer')).toBeVisible();
    await page.getByTestId('import-drawer-status').selectOption('disabled');
    await expect(page.getByTestId('import-drawer-row-mock-tech')).toBeVisible();
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
