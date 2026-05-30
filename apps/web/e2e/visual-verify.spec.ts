import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { clearAllData, seedMockChatModel, sidecarJson } from './test-api';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOTS_DIR = path.join(HERE, '..', 'test-results', 'visual');

test.use({ viewport: { width: 1440, height: 900 } });

test('visual: 织 design coverage', async ({ page }) => {
  await clearAllData();
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /早上好|中午好|下午好|晚上好|夜深了/ })).toBeVisible();

  // 1. Empty state, light theme — should now show the no-model CTA pill
  await expect(page.getByTestId('empty-no-model-cta')).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS_DIR, '01-empty-light-with-cta.png'), fullPage: true });

  // 2. Sidebar collapsed
  await page.locator('.sidebar-head .icon-btn').first().click();
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(SHOTS_DIR, '02-empty-collapsed.png'), fullPage: true });

  await page.locator('.icon-btn').first().click();
  await page.waitForTimeout(250);

  // 3. Settings · 模型 with empty CTA banner
  await page.getByRole('button', { name: '设置' }).first().click();
  await expect(page.getByRole('heading', { name: '模型', exact: true })).toBeVisible();
  await expect(page.getByTestId('model-settings-cta')).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS_DIR, '03-settings-model-empty.png'), fullPage: true });

  // 4. Settings · 服务商 — fresh empty CTA
  await page.getByRole('button', { name: '服务商', exact: true }).click();
  await expect(page.getByTestId('provider-empty-cta')).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS_DIR, '04-settings-providers-empty.png'), fullPage: true });

  // 5+6. 通过 wizard 接入自定义 mock provider + 添加模型
  await page.getByRole('button', { name: '模型', exact: true }).click();
  await page.getByTestId('empty-add-model-cta').click();
  await expect(page.getByTestId('add-model-wizard')).toBeVisible();
  await page.getByTestId('wizard-preset-custom').click();
  await page.getByTestId('wizard-next').click();
  await page.getByTestId('wizard-custom-name').fill('Mock Provider');
  await page.getByTestId('wizard-custom-base-url').fill('https://example.com/v1');
  await page.getByTestId('wizard-api-key').fill('sk-mock');
  await page.getByTestId('wizard-connect').click();
  // discovery 失败 → 手动填模型
  await expect(page.getByTestId('wizard-manual-model-name')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('wizard-manual-model-name').fill('qwen2.5:14b');
  await page.getByTestId('wizard-manual-display-name').fill('Qwen 2.5 14B');
  await page.getByTestId('wizard-finish').click();
  await expect(page.locator('.toast').filter({ hasText: /已添加/ }).first()).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: '服务商', exact: true }).click();
  await expect(page.locator('.provider-card', { hasText: 'Mock Provider' })).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS_DIR, '05-providers-with-card.png'), fullPage: true });
  await page.getByRole('button', { name: '模型', exact: true }).click();
  await page.screenshot({ path: path.join(SHOTS_DIR, '06-providers-after-model-add.png'), fullPage: true });

  // 7. Settings · 模型 — populated default summary + compact inventory (CTA banner gone)
  await page.getByRole('button', { name: '模型', exact: true }).click();
  const qwenRow = page.locator('.model-row-card', { hasText: 'Qwen 2.5 14B' });
  await expect(qwenRow).toBeVisible();
  await qwenRow.getByRole('button', { name: '设为默认' }).click();
  await expect(page.getByTestId('model-default-summary')).toContainText('Qwen 2.5 14B');
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(SHOTS_DIR, '07-settings-model-populated.png'), fullPage: true });

  // 8. Inline alias rename — 经过新版的 ⋯ 菜单
  await qwenRow.locator('details summary').click();
  await page.getByRole('menuitem', { name: '重命名为别名' }).click();
  await expect(page.locator('input.alias-input')).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS_DIR, '08-rename-alias.png'), fullPage: true });
  await page.locator('input.alias-input').fill('通义');
  await page.locator('input.alias-input').press('Enter');
  await expect(page.locator('.toast').filter({ hasText: '已更新模型别名' })).toBeVisible();

  // 9. Empty state without CTA (since now we have a model)
  await page.getByRole('button', { name: /新对话/ }).first().click();
  await page.waitForTimeout(150);
  await expect(page.getByTestId('empty-no-model-cta')).toHaveCount(0);
  await page.screenshot({ path: path.join(SHOTS_DIR, '09-empty-with-model.png'), fullPage: true });

  // The wizard provider carries an API key, which would trigger a real upstream
  // call to the placeholder base URL. Seed a key-less chat model so it becomes
  // the default and the demo chat hits the built-in hermetic mock ("[M0 mock]").
  await seedMockChatModel('Mock Chat');
  await page.reload();
  await expect(page.getByTestId('composer-textarea')).toBeVisible();

  // 10. Completed chat state with streamed assistant reply + cost meta
  await page.getByTestId('composer-textarea').fill('写一个简短的 Markdown 回复');
  await page.getByTestId('composer-send').click();
  await expect(page.locator('.msg.ai', { hasText: '[M0 mock] You said' })).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.msg-cost-lead')).toContainText('$', { timeout: 10_000 });
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(SHOTS_DIR, '14-chat-completed.png'), fullPage: true });

  // 10b. Tool/capability route visible state
  await page.getByRole('button', { name: /新对话/ }).first().click();
  await page.getByTestId('composer-textarea').fill('/image 蓝色机器人海报');
  await page.getByTestId('composer-send').click();
  await expect(page.locator('.msg.ai', { hasText: '已识别为图片生成请求' })).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(SHOTS_DIR, '15-capability-route.png'), fullPage: true });

  // 10c. Tool trace visible state
  const modelData = await sidecarJson<{ models: Array<{ id: string; display_name: string }> }>('/v1/models');
  const visualModelId = modelData.models.find((model) => model.display_name === 'Qwen 2.5 14B')?.id;
  expect(visualModelId).toBeTruthy();
  await sidecarJson(`/v1/models/${visualModelId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      price_input_per_1m: 1,
      price_output_per_1m: 2,
    }),
  });
  await page.reload();
  await expect(page.getByTestId('composer-textarea')).toBeVisible();
  await page.route('**/v1/chat', async (route) => {
    const body = [
      `8:[{"type":"meta","conversation_id":"conv_visual_tool","message_id":"msg_visual_tool","model_id":"${visualModelId}","run_id":"run_visual_tool"}]`,
      '8:[{"type":"tool_trace","message_id":"msg_visual_tool","event":"finish","call_id":"visual_tool_1","tool":"builtin.web_fetch","label":"抓取网页","input":"https://example.com","ok":true,"output":"Example Domain","duration_ms":18}]',
      '0:"工具结果已整合。"',
      '8:[{"type":"cost","message_id":"msg_visual_tool","input_tokens":16,"cache_input_tokens":4,"output_tokens":6}]',
      'd:{"finishReason":"stop","usage":{"promptTokens":16,"completionTokens":6}}',
    ].join('\n');
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: `${body}\n`,
    });
  });
  await page.getByRole('button', { name: /新对话/ }).first().click();
  await page.getByTestId('composer-textarea').fill('抓取 example.com 并总结');
  await page.getByTestId('composer-send').click();
  await expect(page.getByTestId('tool-trace-list')).toContainText('抓取网页', { timeout: 10_000 });
  await expect(page.locator('.msg-cost-lead').last()).toContainText('约');
  await page.getByTestId('message-cost-toggle').last().click();
  await expect(page.locator('.msg-cost-details').last()).toContainText('缓存 4');
  await expect(page.locator('.msg-cost-details').last()).toContainText('单价');
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(SHOTS_DIR, '16-tool-trace.png'), fullPage: true });

  // 11. Provider edit dialog
  await page.getByRole('button', { name: '设置' }).first().click();
  await page.getByRole('button', { name: '服务商', exact: true }).click();
  await page.locator('.provider-card', { hasText: 'Mock Provider' }).locator('details summary').click();
  await page.getByRole('menuitem', { name: /编辑名称/ }).click();
  await expect(page.getByTestId('provider-edit-dialog')).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS_DIR, '10-provider-edit-dialog.png'), fullPage: true });
  await page.getByRole('button', { name: '取消' }).click();

  // 12. Dark theme — settings · 外观
  await page.getByRole('button', { name: '外观', exact: true }).click();
  await page.getByTestId('theme-dark').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(SHOTS_DIR, '11-settings-appearance-dark.png'), fullPage: true });

  // 13. Empty state in dark theme
  await page.getByRole('button', { name: /新对话/ }).first().click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(SHOTS_DIR, '12-empty-dark.png'), fullPage: true });

  // 14. Density: comfy + back to light
  await page.getByRole('button', { name: '设置' }).first().click();
  await page.getByRole('button', { name: '外观', exact: true }).click();
  await page.getByTestId('theme-light').click();
  await page.getByRole('button', { name: '宽松' }).click();
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(SHOTS_DIR, '13-density-comfy.png'), fullPage: true });

  // Cleanup
  await page.getByRole('button', { name: '模型', exact: true }).click();
  const cleanupModelData = await sidecarJson<{ models: Array<{ id: string; alias: string | null; display_name: string }> }>('/v1/models');
  const cleanupModelId = cleanupModelData.models.find((item) => item.alias === '通义' || item.display_name === 'Qwen 2.5 14B')?.id;
  expect(cleanupModelId).toBeTruthy();
  await sidecarJson(`/v1/models/${cleanupModelId}`, { method: 'DELETE' });
  await page.getByRole('button', { name: '服务商', exact: true }).click();
  await page.locator('.provider-card', { hasText: 'Mock Provider' }).locator('details summary').click();
  await page.getByRole('menuitem', { name: '删除整个服务商' }).click();
  await page.getByTestId('app-dialog-ok').click();
});
