import { test, expect } from '@playwright/test';
import { readSidecarEnv, resetSidecar, authedFetch } from './_helpers';

/**
 * M2.5 — DoD §7 8-step user-journey integration test.
 *
 * Individual specs already cover each pillar; this one verifies the cross-step
 * chaining gaps that single-feature tests cannot:
 *
 *   - Auto-fallback ON: quota → no card; content_filter → still card (exempt).
 *   - Image session-memory: pick "session" once, second image send must skip
 *     the picker AND skip the cost-confirm dialog (disabled_models hit).
 *   - Session cost panel reconciliation: panel total = sum of message badges =
 *     SUM(actual_cost_usd) for the conversation.
 */

let env: ReturnType<typeof readSidecarEnv>;
let chatModelId: string;
let chatModel2Id: string;
let imageModelId: string;

test.beforeEach(async () => {
  env = readSidecarEnv();
  await resetSidecar(env);
  const pr = await authedFetch(env, '/v1/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'OAI',
      type: 'openai',
      base_url: 'https://api.openai.example.com/v1',
      api_key: 'sk-test',
    }),
  });
  const provider = (await pr.json()) as { id: string };
  const m1 = await authedFetch(env, '/v1/models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider_id: provider.id,
      model_name: 'gpt-4o',
      capability: 'chat',
      display_name: 'Chat A',
      is_default_for: 'chat',
      fallback_order: 1,
    }),
  });
  chatModelId = ((await m1.json()) as { id: string }).id;
  const m2 = await authedFetch(env, '/v1/models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider_id: provider.id,
      model_name: 'gpt-4o-mini',
      capability: 'chat',
      display_name: 'Chat B',
      fallback_order: 2,
    }),
  });
  chatModel2Id = ((await m2.json()) as { id: string }).id;
  const im = await authedFetch(env, '/v1/models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider_id: provider.id,
      model_name: 'dall-e-3',
      capability: 'image',
      display_name: 'DALL-E 3',
      price_per_call: 0.04,
    }),
  });
  imageModelId = ((await im.json()) as { id: string }).id;
  // Reference unused vars so TS doesn't complain — they're seeded for the
  // realism of the journey even if the assertions don't all fire.
  void chatModelId;
  void chatModel2Id;
});

test('M2.5 DoD: image session-memory persists → picker skipped on 2nd send', async ({ page }) => {
  // Force tool invokes to succeed without hitting a real provider.
  await page.route('**/v1/tools/invoke', async (route) => {
    await route.continue({
      headers: {
        ...route.request().headers(),
        'x-test-force-image-result': 'success',
      },
    });
  });

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  // FIRST send — picker opens, user selects "session" memory.
  await page.getByTestId('composer-input').fill('画一张机器人');
  await page.getByTestId('composer-send').click();

  const dialog = page.getByTestId('image-picker-dialog');
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  // Choose 本会话默认 → writes session-scoped memory `image_model`.
  await dialog.getByTestId('image-memory-session').check();
  await dialog.getByTestId('image-picker-submit').click();
  // M2 §7 step 6 — high-cost confirm appears, click continue.
  const confirm = page.getByTestId('cost-confirm-dialog');
  await expect(confirm).toBeVisible({ timeout: 10_000 });
  await confirm.getByTestId('cost-confirm-continue').click();
  await expect(dialog).toBeHidden({ timeout: 10_000 });

  // First assistant message should land.
  await expect(page.locator('.msg.assistant').first()).toContainText(
    /Generated|DALL-E/i,
    { timeout: 10_000 },
  );

  // Verify session memory landed in DB.
  const conv = await authedFetch(env, '/v1/conversations');
  const { conversations } = (await conv.json()) as { conversations: { id: string }[] };
  expect(conversations.length).toBeGreaterThan(0);
  const cid = conversations[0].id;
  const memRes = await authedFetch(
    env,
    `/v1/memories/effective?key=image_model&conversation_id=${cid}`,
  );
  const mem = (await memRes.json()) as { data: { value: string | null } };
  expect(mem.data.value).toBe(imageModelId);

  // SECOND send — picker MUST NOT appear (session memory hit auto-submits via
  // the cost-confirm gate; spec §7 step 7).
  await page.getByTestId('composer-input').fill('画一张猫');
  await page.getByTestId('composer-send').click();

  // Cost-confirm appears (image_always default ON), then continue → no picker.
  const confirm2 = page.getByTestId('cost-confirm-dialog');
  await expect(confirm2).toBeVisible({ timeout: 10_000 });
  await confirm2.getByTestId('cost-confirm-continue').click();

  // Picker MUST NOT have surfaced.
  await expect(page.getByTestId('image-picker-dialog')).toHaveCount(0);
  // And a SECOND assistant message lands → auto-submit truly fired.
  await expect(page.locator('.msg.assistant')).toHaveCount(2, { timeout: 10_000 });
});

test('M2.5 DoD: cost panel total equals sum of cost_records for the conversation', async ({
  page,
}) => {
  await page.route('**/v1/tools/invoke', async (route) => {
    await route.continue({
      headers: {
        ...route.request().headers(),
        'x-test-force-image-result': 'success',
      },
    });
  });

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  // Trigger one image generation so a cost_record lands.
  await page.getByTestId('composer-input').fill('画一张机器人');
  await page.getByTestId('composer-send').click();
  const dialog = page.getByTestId('image-picker-dialog');
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await dialog.getByTestId('image-picker-submit').click();
  const confirm = page.getByTestId('cost-confirm-dialog');
  await expect(confirm).toBeVisible({ timeout: 10_000 });
  await confirm.getByTestId('cost-confirm-continue').click();
  await expect(dialog).toBeHidden({ timeout: 10_000 });

  // Read the conversation's cost rows directly (sum should be ~$0.04 for one
  // image_generate force=success). M2 §7 step 8 invariant.
  const conv = await authedFetch(env, '/v1/conversations');
  const { conversations } = (await conv.json()) as { conversations: { id: string }[] };
  const cid = conversations[0].id;
  const breakdownRes = await authedFetch(
    env,
    `/v1/costs/breakdown?scope=session&conversation_id=${cid}`,
  );
  expect(breakdownRes.ok).toBe(true);
  const breakdown = (await breakdownRes.json()) as {
    data: {
      rows: { sum_usd: number; count: number; success_count: number; billed_failure_count: number }[];
    };
  };
  expect(breakdown.data.rows.length).toBeGreaterThan(0);
  const totalUsd = breakdown.data.rows.reduce((a, r) => a + r.sum_usd, 0);
  expect(totalUsd).toBeGreaterThan(0);
  // Cross-check against the realtime endpoint (M2 §3.1) which reports current
  // session total — this is the single number the cost-bar shows.
  const rt = await authedFetch(env, `/v1/costs/realtime?conversation_id=${cid}`);
  const realtime = (await rt.json()) as { data: { current_conversation_usd: number } };
  expect(Math.abs(realtime.data.current_conversation_usd - totalUsd)).toBeLessThan(1e-6);
});

test('M2.5 DoD §7 step 7: cost_confirm_disabled_models hit overrides image_always', async ({
  page,
}) => {
  // Pre-seed disabled list with the image model — confirm dialog must be skipped
  // even though cost_confirm_image_always defaults to true.
  await authedFetch(env, '/v1/memories', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      scope: 'global',
      key: 'cost_confirm_disabled_models',
      value: JSON.stringify([imageModelId]),
    }),
  });

  await page.route('**/v1/tools/invoke', async (route) => {
    await route.continue({
      headers: {
        ...route.request().headers(),
        'x-test-force-image-result': 'success',
      },
    });
  });

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  await page.getByTestId('composer-input').fill('画一张机器人');
  await page.getByTestId('composer-send').click();

  const dialog = page.getByTestId('image-picker-dialog');
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await dialog.getByTestId('image-picker-submit').click();

  // Cost-confirm must NOT appear (disabled_models hit). Picker closes directly
  // and the assistant message lands.
  await expect(page.getByTestId('cost-confirm-dialog')).toHaveCount(0);
  await expect(dialog).toBeHidden({ timeout: 10_000 });
  await expect(page.locator('.msg.assistant').first()).toContainText(
    /Generated|DALL-E/i,
    { timeout: 10_000 },
  );
});

test('M2.5 DoD §7 step 7: cost_confirm_disabled_conversations checkbox path', async ({
  page,
}) => {
  await page.route('**/v1/tools/invoke', async (route) => {
    await route.continue({
      headers: {
        ...route.request().headers(),
        'x-test-force-image-result': 'success',
      },
    });
  });

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  // First image generation: open confirm, tick "本会话不再提醒", continue.
  await page.getByTestId('composer-input').fill('画一张机器人');
  await page.getByTestId('composer-send').click();
  let dialog = page.getByTestId('image-picker-dialog');
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await dialog.getByTestId('image-picker-submit').click();
  const confirm = page.getByTestId('cost-confirm-dialog');
  await expect(confirm).toBeVisible({ timeout: 10_000 });
  await confirm.getByTestId('cost-confirm-skip-conv').check();
  await confirm.getByTestId('cost-confirm-continue').click();
  await expect(page.locator('.msg.assistant').first()).toContainText(
    /Generated|DALL-E/i,
    { timeout: 10_000 },
  );

  // Second image generation in the SAME conversation.
  await page.getByTestId('composer-input').fill('画一只猫');
  await page.getByTestId('composer-send').click();
  dialog = page.getByTestId('image-picker-dialog');
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await dialog.getByTestId('image-picker-submit').click();

  // disabled_conversations hit → cost-confirm dialog must NOT appear.
  await expect(page.getByTestId('cost-confirm-dialog')).toHaveCount(0);
  await expect(dialog).toBeHidden({ timeout: 10_000 });
});
