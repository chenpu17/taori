/**
 * R6 — auto-fallback system note persists across reload (M2 §1.4).
 *
 * Verifies the fix for spec-audit M4:
 *   1. Send a chat that fails with rate_limit → renderer auto-falls-back to
 *      a backup model and injects the "已自动切换到 X 并重试" system note.
 *   2. Reload the page (re-mount the renderer) → the same conversation is
 *      restored from sidecar; the system note must still be visible.
 *   3. Sending a follow-up message must NOT include the system note in the
 *      LLM payload (it's renderer-side UX, not part of the dialogue).
 */
import { test, expect } from '@playwright/test';
import {
  authedFetch,
  readSidecarEnv,
  resetSidecar,
  type SidecarEnv,
} from './_helpers';
import { startMockOpenAI } from './_mock-openai-server';

const MOCK_PORT = 17894;
const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}/v1`;

let server: ReturnType<typeof startMockOpenAI> | null = null;
let env: SidecarEnv;

test.beforeAll(() => {
  server = startMockOpenAI(MOCK_PORT);
  env = readSidecarEnv();
});

test.afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
});

async function seed(env: SidecarEnv): Promise<{ primary: string; backup: string }> {
  const pr = await authedFetch(env, '/v1/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Mock OAI',
      type: 'openai',
      base_url: MOCK_URL,
      api_key: 'sk-mock',
    }),
  });
  const provider = (await pr.json()) as { id: string };
  async function mkModel(name: string, display: string, isDefault = false): Promise<string> {
    const r = await authedFetch(env, '/v1/models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider_id: provider.id,
        model_name: name,
        display_name: display,
        capability: 'chat',
        is_default_for: isDefault ? 'chat' : null,
        price_input_per_1m: 0.5,
        price_output_per_1m: 1.5,
      }),
    });
    return ((await r.json()) as { id: string }).id;
  }
  const primary = await mkModel('mock-primary', 'Primary', true);
  const backup = await mkModel('mock-backup', 'Backup', false);
  return { primary, backup };
}

test.setTimeout(120_000);

test('R6 auto-fallback system note persists across reload (M4)', async ({ page }) => {
  await resetSidecar(env);
  const { primary, backup } = await seed(env);
  await authedFetch(env, '/v1/memories', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      scope: 'global',
      scope_id: null,
      key: 'auto_fallback_enabled',
      value: 'true',
    }),
  });

  // Capture outgoing /v1/chat bodies so we can assert later turns do NOT
  // carry the system note to the LLM (renderer-side strip).
  const sentBodies: string[] = [];
  let firstChat = true;
  await page.route('**/v1/chat', async (route) => {
    const req = route.request();
    sentBodies.push(req.postData() ?? '');
    if (firstChat) {
      firstChat = false;
      // Force sidecar's classification path so the streamed response
      // carries the proper failure_decision annotation that triggers the
      // renderer's auto-fallback logic.
      await route.continue({
        headers: {
          ...req.headers(),
          'x-test-force-classification': 'rate_limit',
        },
      });
      return;
    }
    await route.continue();
  });

  await page.goto('/');
  await expect(page.getByTestId('composer-form')).toBeVisible({ timeout: 15_000 });

  await page.getByTestId('composer-input').fill('hello fallback');
  await page.getByTestId('composer-send').click();

  // System note appears
  const sysNote = page.locator('.msg.system', { hasText: /已自动切换到「Backup」/ });
  await expect(sysNote).toBeVisible({ timeout: 20_000 });

  // Wait for the retried assistant reply
  await expect
    .poll(async () => await page.locator('.msg.assistant').count(), { timeout: 20_000 })
    .toBeGreaterThanOrEqual(1);

  // The active model badge should reflect the fallback target.
  const conv = await authedFetch(env, '/v1/conversations').then((r) =>
    r.json() as Promise<{ conversations: Array<{ id: string }> }>,
  );
  const convId = conv.conversations[0]!.id;
  const persisted = await authedFetch(env, `/v1/conversations/${convId}/messages`).then((r) =>
    r.json() as Promise<{ messages: Array<{ role: string; content: string | null }> }>,
  );
  expect(
    persisted.messages.some(
      (m) => m.role === 'system' && (m.content ?? '').includes('已自动切换到「Backup」'),
    ),
  ).toBe(true);

  // Reload the page — note must still render in the timeline.
  await page.reload();
  await expect(page.getByTestId('composer-form')).toBeVisible({ timeout: 15_000 });
  // Open the conversation that was just created — page reload does not auto-
  // select an active conversation.
  await page.getByTestId('conv-item').first().click();
  await expect(
    page.locator('.msg.system', { hasText: /已自动切换到「Backup」/ }),
  ).toBeVisible({ timeout: 10_000 });

  // Send a follow-up — payload to /v1/chat must NOT include the system note.
  sentBodies.length = 0;
  await page.getByTestId('composer-input').fill('follow up');
  await page.getByTestId('composer-send').click();
  await expect
    .poll(async () => sentBodies.length, { timeout: 15_000 })
    .toBeGreaterThanOrEqual(1);
  for (const b of sentBodies) {
    if (!b) continue;
    expect(b).not.toContain('已自动切换');
  }

  await page.unroute('**/v1/chat');
  void primary;
  void backup;
});
