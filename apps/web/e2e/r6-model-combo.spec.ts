/**
 * R6 — multi-model conversation: per-message model_id + cost is tracked
 *
 * Verifies user-observable behavior when switching models within a single
 * conversation:
 *   - Each assistant reply renders the cost badge correct for its own model.
 *   - The cost-breakdown panel shows ≥3 distinct rows, one per model used.
 *   - Switching models mid-conversation preserves the timeline and does
 *     NOT reset the conversation.
 */
import { test, expect } from '@playwright/test';
import {
  authedFetch,
  readSidecarEnv,
  resetSidecar,
  type SidecarEnv,
} from './_helpers';
import { startMockOpenAI } from './_mock-openai-server';

const MOCK_PORT = 17895;
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

async function seed3Models(env: SidecarEnv): Promise<{ a: string; b: string; c: string }> {
  const pr = await authedFetch(env, '/v1/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Mock combo',
      type: 'openai',
      base_url: MOCK_URL,
      api_key: 'sk-mock',
    }),
  });
  const provider = (await pr.json()) as { id: string };
  async function mk(name: string, display: string, isDefault = false): Promise<string> {
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
  return {
    a: await mk('mock-strategy', 'Strategy', true),
    b: await mk('mock-user', 'UserResearch'),
    c: await mk('mock-tech', 'TechReview'),
  };
}

test.setTimeout(120_000);

test('R6 model combo: switching models mid-conversation produces per-model cost rows', async ({
  page,
}) => {
  await resetSidecar(env);
  const { a, b, c } = await seed3Models(env);

  await page.goto('/');
  await expect(page.getByTestId('composer-form')).toBeVisible({ timeout: 15_000 });

  async function sendWith(modelId: string, text: string): Promise<void> {
    // Wait until composer is idle (not loading) before issuing next turn,
    // otherwise selectOption + click would race the previous stream.
    await expect(page.getByTestId('composer-input')).toBeEnabled({ timeout: 25_000 });
    await page.getByTestId('active-model').selectOption(modelId);
    const before = await page.locator('.msg.assistant').count();
    await page.getByTestId('composer-input').fill(text);
    await page.getByTestId('composer-send').click();
    await expect
      .poll(async () => await page.locator('.msg.assistant').count(), {
        timeout: 25_000,
      })
      .toBeGreaterThan(before);
    // Wait for stream completion before next iteration.
    await expect(page.getByTestId('composer-input')).toBeEnabled({ timeout: 25_000 });
  }

  await sendWith(a, 'first turn — strategy please');
  // Wait for conversation_id to propagate down to ChatPanel before sending
  // the next turn — otherwise useChat would mint a brand new conv (M1 §1.2).
  await expect(page.getByTestId('chat-panel')).not.toHaveAttribute('data-active-conv', '', {
    timeout: 15_000,
  });
  await sendWith(b, 'second turn — user research view');
  await sendWith(c, 'third turn — tech review angle');

  // Each assistant turn produces its own cost badge (M1.3 §2 — L1 actual).
  await expect.poll(async () => await page.locator('.msg-cost').count(), {
    timeout: 15_000,
  }).toBeGreaterThanOrEqual(3);

  // Verify the cost-breakdown rows match three distinct model_ids.
  const conv = await authedFetch(env, '/v1/conversations').then((r) =>
    r.json() as Promise<{ conversations: Array<{ id: string }> }>,
  );
  const convId = conv.conversations[0]!.id;
  const breakdown = await authedFetch(
    env,
    `/v1/costs/breakdown?scope=session&conversation_id=${convId}`,
  ).then((r) => r.json() as Promise<{ data: { rows: Array<{ model_id: string | null; sum_usd: number }> } }>);
  const rows = breakdown.data.rows;
  const distinctModels = new Set(
    rows.map((r) => r.model_id).filter((x): x is string => x != null),
  );
  expect(distinctModels.size).toBeGreaterThanOrEqual(3);
  expect(distinctModels.has(a)).toBe(true);
  expect(distinctModels.has(b)).toBe(true);
  expect(distinctModels.has(c)).toBe(true);
});
