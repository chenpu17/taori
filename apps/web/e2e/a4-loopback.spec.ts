/**
 * A4 — round-table conclusion can be sent back to the original chat
 * conversation as an assistant message ("↪ 带回原对话继续聊天").
 *
 * We launch a roundtable from a fresh state (no active chat conv), drive it
 * to a completed summary, then click the loopback button. The panel should
 * close, the chat panel should switch to the new chat conversation, and the
 * persisted assistant message should contain the summary body.
 */
import { test, expect } from '@playwright/test';
import {
  authedFetch,
  readSidecarEnv,
  resetSidecar,
  type SidecarEnv,
} from './_helpers';
import { startMockOpenAI } from './_mock-openai-server';

const MOCK_PORT = 17897;
const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}/v1`;

let server: ReturnType<typeof startMockOpenAI> | null = null;
let env: SidecarEnv;

test.beforeAll(async () => {
  server = startMockOpenAI(MOCK_PORT);
  env = readSidecarEnv();
});

test.afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
});

async function seedThreeChatModels(): Promise<void> {
  const pr = await authedFetch(env, '/v1/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'A4 mock',
      type: 'openai',
      base_url: MOCK_URL,
      api_key: 'sk-test',
    }),
  });
  const provider = (await pr.json()) as { id: string };
  for (let i = 0; i < 3; i++) {
    await authedFetch(env, '/v1/models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider_id: provider.id,
        model_name: `m${i}`,
        capability: 'chat',
        display_name: `M${i}`,
        ...(i === 0 ? { is_default_for: 'chat' } : {}),
        price_input_per_1m: 0.5,
        price_output_per_1m: 1.5,
      }),
    });
  }
}

test('A4 user can write the round-table conclusion back into a chat conversation', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await resetSidecar(env);
  await seedThreeChatModels();

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await page
    .getByTestId('composer-input')
    .fill('A4 — 选 SaaS 计费模型');
  await page.getByTestId('composer-roundtable').click();

  const dlg = page.getByTestId('roundtable-launch-dialog');
  await expect(dlg).toBeVisible();
  await dlg.getByTestId('roundtable-mode-select').selectOption('deep');
  await dlg.getByTestId('roundtable-launch-start').click();
  await expect(dlg.getByTestId('roundtable-preview')).toBeVisible({
    timeout: 20_000,
  });
  await dlg.getByTestId('roundtable-launch-continue').click();

  const panel = page.getByTestId('roundtable-panel');
  await expect(panel).toBeVisible({ timeout: 15_000 });
  await panel.getByTestId('roundtable-action-start-round').click();
  await expect(panel.getByTestId('roundtable-cell-0-1')).toHaveClass(
    /roundtable-cell-complete/,
    { timeout: 30_000 },
  );
  await panel.getByTestId('roundtable-action-next-round').click();
  await expect(panel.getByTestId('roundtable-cell-0-2')).toHaveClass(
    /roundtable-cell-complete/,
    { timeout: 30_000 },
  );
  await panel.getByTestId('roundtable-action-summarize').click();
  await expect(panel.getByTestId('roundtable-summary')).toBeVisible({
    timeout: 30_000,
  });

  // Loopback button is visible. Click it.
  const loopback = panel.getByTestId('roundtable-loopback');
  await expect(loopback).toBeVisible();
  await loopback.click();

  // The roundtable panel should close and chat panel should be active again.
  await expect(panel).toBeHidden({ timeout: 10_000 });
  await expect(page.getByTestId('chat-panel')).toBeVisible();

  // The new chat conv should have an assistant message containing the
  // summary marker.
  const messages = page.getByTestId('messages');
  await expect(messages).toBeVisible();
  await expect(messages).toContainText('来自圆桌讨论', { timeout: 10_000 });
  await expect(messages).toContainText('推荐决策');

  // Cross-check via API: the chat conversation that received the loopback
  // exists and has exactly one assistant message.
  const convsRes = await authedFetch(env, '/v1/conversations');
  const convs = (await convsRes.json()) as {
    conversations: Array<{ id: string; type: string; title: string | null }>;
  };
  const chatWithLoopback = convs.conversations.find(
    (c) => c.type === 'chat' && (c.title ?? '').includes('圆桌结论'),
  );
  expect(chatWithLoopback).toBeTruthy();
  const msgsRes = await authedFetch(
    env,
    `/v1/conversations/${chatWithLoopback!.id}/messages`,
  );
  const msgsBody = (await msgsRes.json()) as {
    messages: Array<{ role: string; content: string | null }>;
  };
  expect(msgsBody.messages).toHaveLength(1);
  expect(msgsBody.messages[0]!.role).toBe('assistant');
  expect(msgsBody.messages[0]!.content).toContain('推荐决策');
});
