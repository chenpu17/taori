/**
 * M3.A.6 DoD — full happy-path round-table run from the user's web view.
 *
 * Runs against a local OpenAI-compatible mock (`_mock-openai-server.ts`) so
 * we exercise REAL streaming through sidecar → renderer instead of the
 * failure-path stubs used by m3a.4 / m3a.5.
 *
 * Spec §7 8-step user view DoD:
 *   1. user types topic → click 🔍 圆桌 entry
 *   2. launch dialog: topic prefilled, mode=auto, analyzer loading
 *   3. analyzer returns 3 participants + recommended deep + cost preview
 *   4. user clicks 开始 → confirm threshold not triggered → round 1 streams
 *   5. round 1 done → user clicks 再来一轮 → round 2 streams
 *   6. user clicks 总结结束 → summary streams → conclusion card + total cost
 *   7. user clicks 导出 Markdown → file downloaded
 *   8. reload → loopback chat keeps messages visible, with an explicit entry
 *      to reopen the roundtable process
 */
import { test, expect } from '@playwright/test';
import {
  authedFetch,
  readSidecarEnv,
  resetSidecar,
  type SidecarEnv,
} from './_helpers';
import { startMockOpenAI } from './_mock-openai-server';

const MOCK_PORT = 17891;
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

async function seedThreeChatModels(env: SidecarEnv): Promise<{
  providerId: string;
  modelIds: string[];
}> {
  const pr = await authedFetch(env, '/v1/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'M3.A.6 mock provider',
      type: 'openai',
      base_url: MOCK_URL,
      api_key: 'sk-test-mock-key',
    }),
  });
  if (!pr.ok) throw new Error(`provider create failed: ${pr.status}`);
  const provider = (await pr.json()) as { id: string };

  const seeds: { name: string; display: string; isDefault: boolean }[] = [
    { name: 'mock-strategy', display: '战略模型', isDefault: true },
    { name: 'mock-user', display: '用户研究模型', isDefault: false },
    { name: 'mock-tech', display: '技术模型', isDefault: false },
  ];
  const ids: string[] = [];
  for (const s of seeds) {
    const mr = await authedFetch(env, '/v1/models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider_id: provider.id,
        model_name: s.name,
        capability: 'chat',
        display_name: s.display,
        is_default_for: s.isDefault ? 'chat' : null,
        price_input_per_1m: 0.5,
        price_output_per_1m: 1.5,
      }),
    });
    if (!mr.ok) throw new Error(`model create failed: ${mr.status}`);
    const mj = (await mr.json()) as { id: string };
    ids.push(mj.id);
  }
  return { providerId: provider.id, modelIds: ids };
}

test('M3.A.6 DoD: 8-step user-view round-table happy path', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await resetSidecar(env);
  await seedThreeChatModels(env);

  // --- Step 1: type topic and click roundtable entry.
  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await page
    .getByTestId('composer-input')
    .fill('如何选 SaaS 计费模型？');
  await page.getByTestId('composer-roundtable').click();

  // --- Step 2: launch dialog — set mode=deep BEFORE submit, then analyzer
  //     is invoked when user clicks "开始分析".
  const dlg = page.getByTestId('roundtable-launch-dialog');
  await expect(dlg).toBeVisible();
  await dlg.getByTestId('roundtable-mode-select').selectOption('deep');
  await dlg.getByTestId('roundtable-launch-start').click();

  // --- Step 3: analyzer returns; preview shows ≥2 participants and a cost
  //     range. With 3 mock chat models present, mock returns 3 participants.
  await expect(dlg.getByTestId('roundtable-preview')).toBeVisible({
    timeout: 20_000,
  });
  const pCount = await dlg
    .getByTestId('roundtable-participants-list')
    .locator('li')
    .count();
  expect(pCount).toBeGreaterThanOrEqual(2);

  // --- Step 4: confirm + start → panel mounts; user clicks 开始第 1 轮.
  await dlg.getByTestId('roundtable-launch-continue').click();

  const panel = page.getByTestId('roundtable-panel');
  await expect(panel).toBeVisible({ timeout: 15_000 });

  await panel.getByTestId('roundtable-action-start-round').click();

  // Wait for round 1 cell of column 0 to reach 'complete' status.
  const cell0R1 = panel.getByTestId('roundtable-cell-0-1');
  await expect(cell0R1).toHaveClass(/roundtable-cell-complete/, {
    timeout: 30_000,
  });

  // --- Step 5: deep mode round 1 done → click 再来一轮 → round 2 streams.
  const round2Btn = panel.getByTestId('roundtable-action-next-round');
  await expect(round2Btn).toBeVisible({ timeout: 10_000 });
  await round2Btn.click();
  const cell0R2 = panel.getByTestId('roundtable-cell-0-2');
  await expect(cell0R2).toHaveClass(/roundtable-cell-complete/, {
    timeout: 30_000,
  });

  // --- Step 6: round 2 done → user clicks 总结 (deep mode requires explicit
  //     click per spec §6.1; auto-summarize is fast-mode only).
  const summarizeBtn = panel.getByTestId('roundtable-action-summarize');
  await expect(summarizeBtn).toBeVisible({ timeout: 10_000 });
  await summarizeBtn.click();
  await expect(panel.getByTestId('roundtable-summary')).toBeVisible({
    timeout: 30_000,
  });
  await expect(panel.getByTestId('roundtable-summary')).toContainText(
    '推荐决策',
  );

  // Total cost label visible & non-zero.
  const cost = panel.getByTestId('roundtable-total-cost');
  await expect(cost).toBeVisible();
  await expect(cost).toContainText('$');

  // --- Step 7: click export → triggers download.
  const downloadPromise = page.waitForEvent('download', { timeout: 10_000 });
  await panel.getByTestId('roundtable-action-export').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^roundtable_.+\.md$/);

  // --- Step 8: reload → latest loopback chat keeps messages visible. The
  //     roundtable process is still reachable through an explicit banner.
  await page.reload();
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  const firstConv = page.getByTestId('conv-item').first();
  await expect(firstConv).toBeVisible({ timeout: 10_000 });
  await firstConv.click();
  const messages = page.getByTestId('messages');
  await expect(messages).toBeVisible({ timeout: 15_000 });
  await expect(messages).toContainText('发起圆桌讨论：如何选 SaaS 计费模型？');
  await expect(messages).toContainText('来自圆桌讨论');
  await expect(page.getByTestId('roundtable-associated-banner')).toBeVisible();
  await page.getByTestId('roundtable-associated-open').click();
  await expect(page.getByTestId('roundtable-panel')).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId('roundtable-summary')).toBeVisible();
});
