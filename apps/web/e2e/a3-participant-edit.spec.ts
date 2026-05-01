/**
 * A3 — Manual participant edit in analyzer preview.
 *
 * After the analyzer preview renders, the user should be able to:
 *   - change a participant's role label and persona,
 *   - swap a participant's model via the dropdown,
 *   - remove the third participant (count drops to 2),
 *   - click "恢复推荐" to revert all edits.
 *
 * We verify by editing role label + removing one participant, clicking
 * 开始, and asserting via API that the persisted participants reflect
 * the edits (only 2 left, role label changed).
 */
import { test, expect } from '@playwright/test';
import { readSidecarEnv, resetSidecar, authedFetch } from './_helpers';

let env: ReturnType<typeof readSidecarEnv>;

async function seedThreeChatModels(): Promise<void> {
  const pr = await authedFetch(env, '/v1/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'OAI',
      type: 'openai',
      base_url: 'https://api.openai.invalid/v1',
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
        model_name: `gpt-${i}`,
        capability: 'chat',
        display_name: `Chat ${i}`,
        ...(i === 0 ? { is_default_for: 'chat' } : {}),
        price_input_per_1m: 1,
        price_output_per_1m: 2,
      }),
    });
  }
}

test.beforeEach(async () => {
  env = readSidecarEnv();
  await resetSidecar(env);
  await seedThreeChatModels();
});

test('A3 user can edit role label and remove a participant before launch', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 640 });
  await page.route('**/api.openai.invalid/**', (route) => route.abort());

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('composer-input').fill('A3 — pick the right ORM');
  await page.getByTestId('composer-roundtable').click();

  const dlg = page.getByTestId('roundtable-launch-dialog');
  await expect(dlg).toBeVisible();
  await dlg.getByTestId('roundtable-launch-start').click();
  await expect(dlg.getByTestId('roundtable-preview')).toBeVisible({
    timeout: 15_000,
  });
  await expect(dlg.getByTestId('roundtable-launch-continue')).toBeVisible();
  const continueBox = await dlg
    .getByTestId('roundtable-launch-continue')
    .boundingBox();
  expect(continueBox).toBeTruthy();
  expect(continueBox!.y + continueBox!.height).toBeLessThanOrEqual(640);

  // Three participants from analyzer fallback.
  const list = dlg.getByTestId('roundtable-participants-list');
  await expect(list.locator('> li')).toHaveCount(3);

  // Edit participant 0's role label.
  const role0 = dlg.getByTestId('roundtable-participant-role-0');
  await role0.fill('我自定义的角色');
  // Edit persona.
  const persona0 = dlg.getByTestId('roundtable-participant-persona-0');
  await persona0.fill(
    '请你以一个挑剔的资深架构师身份回答，至少给出一个反例。',
  );

  // Remove participant 2 (count drops to 2).
  await dlg.getByTestId('roundtable-participant-remove-2').click();
  await expect(list.locator('> li')).toHaveCount(2);

  // The "✕" remove button should now disappear (only 2 left, the floor).
  await expect(
    dlg.getByTestId('roundtable-participant-remove-0'),
  ).toHaveCount(0);
  await expect(
    dlg.getByTestId('roundtable-participant-remove-1'),
  ).toHaveCount(0);

  // "恢复推荐" button visible because edits were made.
  await expect(
    dlg.getByTestId('roundtable-participants-restore'),
  ).toBeVisible();

  // Click 开始 to commit edits.
  await dlg.getByTestId('roundtable-launch-continue').click();
  await expect(dlg).toBeHidden();

  // Verify persisted participants on the most recent roundtable.
  const convsRes = await authedFetch(env, '/v1/conversations');
  const convs = (await convsRes.json()) as {
    conversations: Array<{ id: string; type: string; created_at: number }>;
  };
  const rtConv = convs.conversations
    .filter((c) => c.type === 'roundtable')
    .sort((a, b) => b.created_at - a.created_at)[0];
  expect(rtConv).toBeTruthy();
  const rtRes = await authedFetch(
    env,
    `/v1/conversations/${rtConv!.id}/roundtable`,
  );
  const rtId = ((await rtRes.json()) as { roundtable_id: string }).roundtable_id;
  const rtFull = await authedFetch(env, `/v1/roundtable/${rtId}`);
  const body = (await rtFull.json()) as {
    roundtable: { participants: Array<{ role_label: string }> };
  };
  expect(body.roundtable.participants).toHaveLength(2);
  expect(body.roundtable.participants[0]!.role_label).toBe('我自定义的角色');
});
