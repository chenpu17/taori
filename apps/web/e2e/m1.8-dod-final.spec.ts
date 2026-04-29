/**
 * M1.8 — Final DoD §7 user journey, single uninterrupted flow.
 *
 * docs/product/08-m1-spec.md §7 enumerates 8 steps a brand-new user must walk
 * through without errors / data loss. Other suites (m1.1-onboarding,
 * m1.4b-file-drop, m1.5-sidebar-actions, m1.6-settings, m1.7-r4-files-cost)
 * each cover individual pieces in isolation; this test stitches them into one
 * continuous session so any regression in transitions surfaces here.
 *
 * Browser-only constraints (parity with phase3-user-journey):
 *   - Step 1 onboarding UI is verified by m1.1; here we seed via API.
 *   - Step 2 we instead seed two models so step 5 (switch) has a target.
 *   - Step 4 image-on-non-vision: warning + send disabled (M1 §4 FILE-1).
 *   - Step 6 reload simulates app close+restart (sidecar SQLite persists).
 *   - Step 8 add/delete model performed through the Settings UI.
 */
import { test, expect } from '@playwright/test';
import { readSidecarEnv, authedFetch, resetSidecar } from './_helpers';

const env = readSidecarEnv();

test.beforeEach(async () => {
  await resetSidecar(env);
});

test('M1 DoD §7: complete 8-step user journey', async ({ page }) => {
  // --- 0. Seed: provider + two chat models so we can switch in step 5.
  const pr = await authedFetch(env, '/v1/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'M1 mock provider',
      type: 'custom',
      base_url: 'https://example.invalid/v1',
    }),
  });
  const provider = (await pr.json()) as { id: string };
  const m1r = await authedFetch(env, '/v1/models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider_id: provider.id,
      model_name: 'mock-a',
      capability: 'chat',
      display_name: 'Mock A',
      is_default_for: 'chat',
      price_input_per_1m: 0.5,
      price_output_per_1m: 1.5,
    }),
  });
  const modelA = (await m1r.json()) as { id: string };
  await authedFetch(env, '/v1/models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider_id: provider.id,
      model_name: 'mock-b',
      capability: 'chat',
      display_name: 'Mock B',
      price_input_per_1m: 1.0,
      price_output_per_1m: 3.0,
    }),
  });
  // Vision-capable peer so step 4 can exercise the auto-switch happy path
  // (spec §7 step 4: "拖入图片 → 看到自动切换视觉模型").
  await authedFetch(env, '/v1/models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider_id: provider.id,
      model_name: 'mock-vision',
      capability: 'chat',
      display_name: 'Mock Vision',
      supports_vision: true,
      price_input_per_1m: 1.5,
      price_output_per_1m: 4.5,
    }),
  });

  // --- 1. Land on chat panel (no onboarding because provider+default exist).
  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.price-badge')).toBeVisible();

  // --- 2. (Onboarding completion is implied by step 1's chat-panel visibility.)
  // --- 3. Send message → streamed assistant reply + per-message cost badge.
  await page.getByTestId('composer-input').fill('hello taori, DoD test');
  await page.getByTestId('composer-send').click();
  await expect(page.locator('.msg.assistant').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('msg-cost').first()).toBeVisible({ timeout: 15_000 });

  // --- 4. Drop image on non-vision model → auto-switch to vision peer
  //         (spec §7 step 4 happy path; falls back to warning only when no
  //         vision-capable model exists, which m1.4b covers in isolation).
  const selectorEarly = page.getByTestId('active-model');
  await expect(selectorEarly).toHaveValue(modelA.id);
  const imgDt = await page.evaluateHandle(() => {
    const dt = new DataTransfer();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    dt.items.add(new File([png], 'pic.png', { type: 'image/png' }));
    return dt;
  });
  await page.getByTestId('composer-form').dispatchEvent('dragover', { dataTransfer: imgDt });
  await page.getByTestId('composer-form').dispatchEvent('drop', { dataTransfer: imgDt });
  await expect(page.getByTestId('attachment-thumb')).toHaveCount(1);
  // Active model should auto-switch to the vision-capable peer; the toast
  // surfaces in the warning slot but indicates success ("已自动切换至…").
  await expect(selectorEarly).not.toHaveValue(modelA.id);
  await expect(page.getByTestId('drop-error')).toContainText('已自动切换至视觉模型');
  // With non-empty input + vision model active, send button must be enabled
  // (the vision constraint that previously gated it has been resolved).
  await page.getByTestId('composer-input').fill('check vision');
  await expect(page.getByTestId('composer-send')).toBeEnabled();
  await page.getByTestId('composer-input').fill('');
  // Clear attachment so subsequent steps can send freely; reset to model A
  // for step 5 (which exercises the manual switch path).
  await page.locator('.attachment button[aria-label="remove"]').first().click();
  await expect(page.getByTestId('attachment-thumb')).toHaveCount(0);
  await selectorEarly.selectOption(modelA.id);

  // --- 5. Switch active model in selector (CHAT-2 — only affects next msg).
  const selector = page.getByTestId('active-model');
  await expect(selector).toBeVisible();
  const before = await selector.inputValue();
  const options = await selector.locator('option').all();
  let target = '';
  for (const o of options) {
    const v = await o.getAttribute('value');
    if (v && v !== before) {
      target = v;
      break;
    }
  }
  expect(target).not.toBe('');
  await selector.selectOption(target);
  await expect(selector).toHaveValue(target);

  // --- 6. Reload → conversation listed in sidebar; click to verify history persists.
  await page.reload();
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  const convItems = page.getByTestId('conv-item');
  await expect(convItems).toHaveCount(1);
  await convItems.first().click();
  await expect(page.locator('.msg.user').first()).toBeVisible({ timeout: 5_000 });
  await expect(page.locator('.msg.assistant').first()).toBeVisible();

  // --- 7. Cost-bar always visible with today/month figures.
  await expect(page.getByTestId('cost-bar')).toBeVisible();
  await expect(page.getByTestId('cost-today')).toBeVisible();
  await expect(page.getByTestId('cost-month')).toBeVisible();

  // --- 8. Model Center: list models, set non-default model as default, then
  //        delete the original default.
  await page.getByTestId('open-model-center').click();
  await expect(page.getByTestId('model-center')).toBeVisible();
  // Filter to actionable rows (exclude the "set default" sub-buttons).
  const modelItems = page.locator('[data-testid^="model-row-"]:not([data-testid^="model-row-default-"]):not([data-testid^="model-row-up-"]):not([data-testid^="model-row-down-"]):not([data-testid^="model-row-delete-"]):not([data-testid^="model-row-enabled-"])');
  await expect(modelItems).toHaveCount(3);
  // Promote a non-default model to default (the default model's button is disabled).
  const setDefault = page.locator('[data-testid^="model-row-default-"]:not([disabled])').first();
  await setDefault.click();
  // After promotion, exactly one model is default → exactly one disabled button.
  await expect(page.locator('[data-testid^="model-row-default-"]:not([disabled])')).toHaveCount(2);
  // Delete one model; native confirm auto-accept.
  page.once('dialog', (d) => void d.accept());
  await page.locator('[data-testid^="model-row-delete-"]').first().click();
  await expect(modelItems).toHaveCount(2, { timeout: 5_000 });

  // Cross-check via API: two models remain, one owns chat default.
  const after = (await (await authedFetch(env, '/v1/models')).json()) as {
    models: { id: string; is_default_for: string | null }[];
  };
  expect(after.models).toHaveLength(2);
  expect(after.models.filter((m) => m.is_default_for === 'chat')).toHaveLength(1);
  // Sanity: at least the originally-seeded modelA reference compiles.
  expect(modelA.id).toBeTruthy();
});
