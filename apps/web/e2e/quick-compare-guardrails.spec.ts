import { test, expect, type Page } from '@playwright/test';
import { authedFetch, readSidecarEnv, resetSidecar, type SidecarEnv } from './_helpers';

type ImportedModel = {
  id: string;
  display_name: string;
  model_name?: string;
  capability?: 'chat' | 'multimodal';
  is_default_for?: string | null;
  demoted?: boolean;
  disabled_until?: number | null;
  enabled?: boolean;
  supports_vision?: boolean;
  supports_tools?: boolean;
  supports_json?: boolean;
  fallback_order?: number;
  failure_count_24h?: number;
  last_failure_at?: number | null;
};

function buildBackup(models: ImportedModel[], activeModelId: string | null) {
  const now = Date.now();
  return {
    format_version: 'taori-backup-v1' as const,
    exported_at: now,
    app_version: '0.0.0-test',
    counts: {
      providers: 1,
      models: models.length,
      conversations: 0,
      messages: 0,
      files: 0,
      memories: activeModelId ? 1 : 0,
      prompt_templates: 0,
      personas: 0,
      cost_records: 0,
      roundtables: 0,
      roundtable_messages: 0,
    },
    warnings: [] as string[],
    data: {
      providers: [{
        id: 'prov_guardrail',
        name: 'Guardrail Provider',
        type: 'custom',
        base_url: 'https://example.invalid/v1',
        enabled: true,
        created_at: now,
        updated_at: now,
        had_api_key: false,
      }],
      models: models.map((model, index) => ({
        id: model.id,
        alias: null,
        provider_id: 'prov_guardrail',
        model_name: model.model_name ?? model.id,
        capability: model.capability ?? 'chat',
        display_name: model.display_name,
        price_input_per_1m: 0.1 + index,
        price_output_per_1m: 0.2 + index,
        price_per_call: null,
        price_per_image: null,
        price_per_video_second: null,
        price_currency: 'USD',
        pricing_meta: null,
        price_synced_at: null,
        modalities: JSON.stringify(model.capability === 'multimodal' ? ['text', 'image'] : ['text']),
        context_length: index === 2 ? 128_000 : 32_000,
        supports_vision: model.supports_vision ?? model.capability === 'multimodal',
        supports_tools: model.supports_tools ?? index === 2,
        supports_json: model.supports_json ?? index === 2,
        is_default_for: model.is_default_for ?? null,
        fallback_order: model.fallback_order ?? index,
        user_rating: null,
        failure_count_24h: model.failure_count_24h ?? (model.demoted ? 3 : 0),
        last_failure_at: model.last_failure_at ?? (model.demoted ? now : null),
        demoted: model.demoted ?? false,
        disabled_until: model.disabled_until ?? null,
        enabled: model.enabled ?? true,
        created_at: now + index,
        updated_at: now + index,
      })),
      conversations: [],
      messages: [],
      files: [],
      memories: activeModelId
        ? [{
            id: 'mem_active_chat_model',
            scope: 'global',
            scope_id: null,
            key: 'active_chat_model_id',
            value: activeModelId,
            created_at: now,
            updated_at: now,
          }]
        : [],
      prompt_templates: [],
      personas: [],
      cost_records: [],
      roundtables: [],
      roundtable_messages: [],
    },
  };
}

async function importBackup(env: SidecarEnv, models: ImportedModel[], activeModelId: string | null) {
  await resetSidecar(env);
  const res = await authedFetch(env, '/v1/admin/import-data', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      strategy: 'overwrite',
      backup: buildBackup(models, activeModelId),
    }),
  });
  expect(res.ok).toBeTruthy();
}

async function updateModel(env: SidecarEnv, modelId: string, patch: Record<string, unknown>) {
  const res = await authedFetch(env, `/v1/models/${modelId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  expect(res.ok).toBeTruthy();
}

async function deleteModel(env: SidecarEnv, modelId: string) {
  const res = await authedFetch(env, `/v1/models/${modelId}`, {
    method: 'DELETE',
  });
  expect(res.status).toBe(204);
}

async function primeRoundtableTip(page: Page) {
  await page.addInitScript(() => {
    localStorage.removeItem('tip_roundtable_first_seen');
    localStorage.setItem('tip_image_first_seen', 'true');
    localStorage.setItem('tip_fallback_first_seen', 'true');
    localStorage.setItem('tip_cost_first_seen', 'true');
  });
}

test.describe('quick compare guardrails', () => {
  test.use({ colorScheme: 'dark' });

  test('roundtable tip stays above composer instead of covering the input area', async ({ page }) => {
    const env = readSidecarEnv();
    await importBackup(env, [
      { id: 'mdl_default', display_name: 'Default', is_default_for: 'chat' },
      { id: 'mdl_peer', display_name: 'Peer' },
    ], 'mdl_default');
    await primeRoundtableTip(page);

    await page.goto('/');
    await expect(page.getByTestId('tip-roundtable')).toBeVisible({ timeout: 5_000 });

    const tipBox = await page.getByTestId('tip-roundtable').boundingBox();
    const composerBox = await page.getByTestId('composer-input').boundingBox();
    expect(tipBox).not.toBeNull();
    expect(composerBox).not.toBeNull();
    expect((tipBox?.y ?? 0) + (tipBox?.height ?? 0)).toBeLessThan(composerBox?.y ?? 0);
  });

  test('roundtable tip hides while quick compare card is open', async ({ page }) => {
    const env = readSidecarEnv();
    await importBackup(env, [
      { id: 'mdl_default', display_name: 'Default', is_default_for: 'chat' },
      { id: 'mdl_peer_a', display_name: 'Peer A' },
      { id: 'mdl_peer_b', display_name: 'Peer B', supports_tools: true, supports_json: true },
    ], 'mdl_default');
    await primeRoundtableTip(page);

    await page.goto('/');
    await expect(page.getByTestId('tip-roundtable')).toBeVisible({ timeout: 5_000 });
    await page.getByTestId('composer-input').fill('请比较两个方案');
    await page.getByTestId('composer-quick-compare').click();

    await expect(page.getByTestId('quick-compare-picker')).toBeVisible();
    await expect(page.getByTestId('tip-roundtable')).toHaveCount(0);
    await page.getByTestId('quick-compare-picker-submit').click();
    await expect(page.getByTestId('quick-compare-card')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('tip-roundtable')).toHaveCount(0);
  });

  test('roundtable tip hides while model center is open', async ({ page }) => {
    const env = readSidecarEnv();
    await importBackup(env, [
      { id: 'mdl_default', display_name: 'Default', is_default_for: 'chat' },
      { id: 'mdl_peer', display_name: 'Peer' },
    ], 'mdl_default');
    await primeRoundtableTip(page);

    await page.goto('/');
    await expect(page.getByTestId('tip-roundtable')).toBeVisible({ timeout: 5_000 });
    await page.getByTestId('open-model-center').click();

    await expect(page.getByTestId('model-center')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('tip-roundtable')).toHaveCount(0);
  });

  test('roundtable tip hides while help center is open', async ({ page }) => {
    const env = readSidecarEnv();
    await importBackup(env, [
      { id: 'mdl_default', display_name: 'Default', is_default_for: 'chat' },
      { id: 'mdl_peer', display_name: 'Peer' },
    ], 'mdl_default');
    await primeRoundtableTip(page);

    await page.goto('/');
    await expect(page.getByTestId('tip-roundtable')).toBeVisible({ timeout: 5_000 });
    await page.getByTestId('open-help').click();

    await expect(page.getByTestId('help-center')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('tip-roundtable')).toHaveCount(0);
  });

  test('quick compare button is disabled when only one eligible model remains because current is demoted', async ({ page }) => {
    const env = readSidecarEnv();
    await importBackup(env, [
      { id: 'mdl_current', display_name: 'Current', is_default_for: 'chat', demoted: true },
      { id: 'mdl_peer', display_name: 'Peer' },
    ], 'mdl_current');

    await page.goto('/');
    await expect(page.getByTestId('active-model')).toHaveValue('mdl_current');
    await page.getByTestId('composer-input').fill('比较两个方案');
    await expect(page.getByTestId('composer-quick-compare')).toBeDisabled();
  });

  test('quick compare still runs with two healthy peers when current model is demoted', async ({ page }) => {
    const env = readSidecarEnv();
    await importBackup(env, [
      { id: 'mdl_current', display_name: 'Current', is_default_for: 'chat', demoted: true },
      { id: 'mdl_peer_a', display_name: 'Peer A' },
      { id: 'mdl_peer_b', display_name: 'Peer B', supports_tools: true, supports_json: true },
    ], 'mdl_current');

    await page.goto('/');
    await expect(page.getByTestId('active-model')).toHaveValue('mdl_current');
    await page.getByTestId('composer-input').fill('比较两个方案');
    await expect(page.getByTestId('composer-quick-compare')).toBeEnabled();
    await page.getByTestId('composer-quick-compare').click();
    await expect(page.getByTestId('quick-compare-picker')).toBeVisible();
    await page.getByTestId('quick-compare-picker-submit').click();

    await expect(page.getByTestId('quick-compare-card')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('quick-compare-output')).toHaveCount(2, { timeout: 15_000 });
  });

  test('quick compare is disabled for prompts that need search or webpage fetching', async ({ page }) => {
    const env = readSidecarEnv();
    await importBackup(env, [
      { id: 'mdl_default', display_name: 'Default', is_default_for: 'chat' },
      { id: 'mdl_peer_a', display_name: 'Peer A' },
      { id: 'mdl_peer_b', display_name: 'Peer B', supports_tools: true, supports_json: true },
    ], 'mdl_default');

    await page.goto('/');
    await page.getByTestId('composer-input').fill('请搜索 Taori 最新资料并总结');

    const quickCompareButton = page.getByTestId('composer-quick-compare');
    await expect(quickCompareButton).toBeDisabled();
    await expect(quickCompareButton).toHaveAttribute('title', /正式工具链/);
  });

  test('remembered disabled-until model falls back to a selectable default model', async ({ page }) => {
    const env = readSidecarEnv();
    await importBackup(env, [
      {
        id: 'mdl_disabled_default',
        display_name: 'Disabled Default',
        is_default_for: 'chat',
        disabled_until: Date.now() + 60_000,
      },
      { id: 'mdl_peer', display_name: 'Peer' },
    ], 'mdl_disabled_default');

    await page.goto('/');
    await expect(page.getByTestId('active-model')).toHaveValue('mdl_peer');
    await page.getByTestId('composer-input').fill('比较两个方案');
    await expect(page.getByTestId('composer-quick-compare')).toBeDisabled();
  });

  test('stale remembered model id falls back to the selectable default model', async ({ page }) => {
    const env = readSidecarEnv();
    await importBackup(env, [
      { id: 'mdl_default', display_name: 'Default', is_default_for: 'chat' },
      { id: 'mdl_peer', display_name: 'Peer' },
    ], 'mdl_missing');

    await page.goto('/');
    await expect(page.getByTestId('active-model')).toHaveValue('mdl_default');
    await page.getByTestId('composer-input').fill('比较两个方案');
    await expect(page.getByTestId('composer-quick-compare')).toBeEnabled();
  });

  test('dark theme quick compare card keeps dark background and light foreground', async ({ page }) => {
    const env = readSidecarEnv();
    await importBackup(env, [
      { id: 'mdl_default', display_name: 'Default', is_default_for: 'chat' },
      { id: 'mdl_peer_a', display_name: 'Peer A' },
      { id: 'mdl_peer_b', display_name: 'Peer B' },
    ], 'mdl_default');

    await page.goto('/');
    await page.getByTestId('composer-input').fill('比较两个方案');
    await page.getByTestId('composer-quick-compare').click();
    await expect(page.getByTestId('quick-compare-picker')).toBeVisible();
    await page.getByTestId('quick-compare-picker-submit').click();
    await expect(page.getByTestId('quick-compare-card')).toBeVisible({ timeout: 15_000 });

    const styles = await page.getByTestId('quick-compare-card').evaluate((el) => {
      const style = getComputedStyle(el);
      return {
        color: style.color,
        backgroundImage: style.backgroundImage,
      };
    });
    expect(styles.color).toBe('rgb(241, 245, 249)');
    expect(styles.backgroundImage).not.toContain('rgb(255, 255, 255)');
  });

  test('quick compare card clears when starting a new chat', async ({ page }) => {
    const env = readSidecarEnv();
    await importBackup(env, [
      { id: 'mdl_default', display_name: 'Default', is_default_for: 'chat' },
      { id: 'mdl_peer_a', display_name: 'Peer A' },
      { id: 'mdl_peer_b', display_name: 'Peer B', supports_tools: true, supports_json: true },
    ], 'mdl_default');

    await page.goto('/');
    await page.getByTestId('composer-input').fill('比较两个方案');
    await page.getByTestId('composer-quick-compare').click();
    await expect(page.getByTestId('quick-compare-picker')).toBeVisible();
    await page.getByTestId('quick-compare-picker-submit').click();
    await expect(page.getByTestId('quick-compare-card')).toBeVisible({ timeout: 15_000 });

    await page.getByTestId('sidebar-new').click();
    await expect(page.getByTestId('quick-compare-card')).toHaveCount(0);
    await expect(page.getByTestId('chat-panel')).toHaveAttribute('data-active-conv', '');
  });

  test('backend-disabled remembered current model falls back to selectable default after reload', async ({ page }) => {
    const env = readSidecarEnv();
    await importBackup(env, [
      { id: 'mdl_default', display_name: 'Default', is_default_for: 'chat' },
      { id: 'mdl_current', display_name: 'Current' },
    ], 'mdl_current');

    await page.goto('/');
    await expect(page.getByTestId('active-model')).toHaveValue('mdl_current');

    await updateModel(env, 'mdl_current', { enabled: false });
    await page.reload();

    await expect(page.getByTestId('active-model')).toHaveValue('mdl_default');
    await page.getByTestId('composer-input').fill('比较两个方案');
    await expect(page.getByTestId('composer-quick-compare')).toBeDisabled();
  });

  test('backend-deleted remembered current model falls back to selectable default after reload', async ({ page }) => {
    const env = readSidecarEnv();
    await importBackup(env, [
      { id: 'mdl_default', display_name: 'Default', is_default_for: 'chat' },
      { id: 'mdl_current', display_name: 'Current' },
      { id: 'mdl_peer', display_name: 'Peer' },
    ], 'mdl_current');

    await page.goto('/');
    await expect(page.getByTestId('active-model')).toHaveValue('mdl_current');

    await deleteModel(env, 'mdl_current');
    await page.reload();

    await expect(page.getByTestId('active-model')).toHaveValue('mdl_default');
    await page.getByTestId('composer-input').fill('比较两个方案');
    await expect(page.getByTestId('composer-quick-compare')).toBeEnabled();
  });
});
