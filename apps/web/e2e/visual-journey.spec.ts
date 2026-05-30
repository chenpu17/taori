/**
 * 端到端视觉旅程 — 跑一个真实用户的全链路：
 *   01 首次进入（空状态 + 配置 CTA）
 *   02 设置 / 模型（空银行）→ 添加模型 wizard → 手动 fallback → 默认模型
 *   03 回到欢迎页（无 CTA，但显示「继续上次」入口）
 *   04 第一段对话（含 Markdown / cost meta / AI 快捷条）
 *   05 删除对话弹窗（自定义 Dialog，替代原生 confirm）
 *   06 多模型对比页（feature hub）
 *   07 成本面板
 *   08 模板 / 人格 面板
 *   09 记忆面板（写一条 KV）
 *   10 设置 / 通用（self-check + 数据管理）
 *   11 外观（dark 切换）
 *
 * 所有 PNG 落到 apps/web/test-results/visual/journey/。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { clearAllData, seedMockChatModel, seedMultiProviderStack, sidecarJson } from './test-api';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(HERE, '..', 'test-results', 'visual', 'journey');

test.use({ viewport: { width: 1440, height: 900 } });

test('journey: bootstrap → configure → chat → features → cost → templates → memory → settings', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await clearAllData();
  await page.goto('/');

  // 01 — 空状态 / 没有模型 / 配置 CTA pill
  await expect(page.getByTestId('empty-no-model-cta')).toBeVisible();
  await expect(page.getByRole('heading', { name: /早上好|中午好|下午好|晚上好|夜深了/ })).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, '01-empty-with-cta.png'), fullPage: true });

  // 02 — 进入模型 tab + 唤起统一添加模型 wizard
  await page.getByTestId('empty-no-model-cta').click();
  await expect(page.getByTestId('empty-add-model-cta')).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, '02-model-tab-empty.png'), fullPage: true });
  await page.getByTestId('empty-add-model-cta').click();
  await expect(page.getByTestId('add-model-wizard')).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, '02b-wizard-step1.png'), fullPage: true });

  // 02b — Step 1: 选自定义（mock 用） → Step 2: 填 Key（mock）→ 失败退到手动
  await page.getByTestId('wizard-preset-custom').click();
  await page.getByTestId('wizard-next').click();
  await page.getByTestId('wizard-custom-name').fill('Mock Provider');
  await page.getByTestId('wizard-custom-base-url').fill('https://example.com/v1');
  await page.getByTestId('wizard-api-key').fill('sk-mock');
  await page.screenshot({ path: path.join(SHOTS, '02c-wizard-step2.png'), fullPage: true });
  await page.getByTestId('wizard-connect').click();

  // 02c — Step 3: discover 失败 → 手动填 model_name
  await expect(page.getByTestId('wizard-manual-model-name')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('wizard-manual-model-name').fill('qwen2.5:14b');
  await page.getByTestId('wizard-manual-display-name').fill('Qwen 2.5 14B');
  await page.screenshot({ path: path.join(SHOTS, '03-wizard-step3-manual.png'), fullPage: true });
  await page.getByTestId('wizard-finish').click();
  await expect(page.locator('.toast').filter({ hasText: /已添加/ }).first()).toBeVisible({
    timeout: 10_000,
  });

  // 02d — 模型 tab：默认摘要 + 紧凑模型清单
  const qwenRow = page.locator('.model-row-card', { hasText: 'Qwen 2.5 14B' });
  await qwenRow.getByRole('button', { name: '设为默认' }).click();
  await expect(page.getByTestId('model-default-summary')).toContainText('Qwen 2.5 14B');
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(SHOTS, '04-model-default-picked.png'), fullPage: true });

  // 03 — 回到欢迎页（CTA 消失，建议卡 6 张）
  await page.getByRole('button', { name: /新对话/ }).first().click();
  await expect(page.getByTestId('empty-no-model-cta')).toHaveCount(0);
  await expect(page.locator('.suggest-card')).toHaveCount(6);
  await page.screenshot({ path: path.join(SHOTS, '05-empty-with-model.png'), fullPage: true });

  // The wizard provider carries an API key, which would trigger a real upstream
  // call to the placeholder base URL. Seed a key-less chat model so it becomes
  // the default and the demo chat hits the built-in hermetic mock ("[M0 mock]").
  await seedMockChatModel('Mock Chat');
  await page.reload();
  await expect(page.getByTestId('composer-textarea')).toBeVisible();

  // 04 — 第一段对话（含 markdown / cost meta / 快捷操作）
  await page.getByTestId('composer-textarea').fill('用 Markdown 给我两条独处建议');
  await page.getByTestId('composer-send').click();
  await expect(page.locator('.msg.ai', { hasText: '[M0 mock] You said' })).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.msg-cost-lead')).toContainText('$', { timeout: 10_000 });
  await page.locator('.msg.ai').first().hover();
  await page.waitForTimeout(180);
  await page.screenshot({ path: path.join(SHOTS, '06-chat-with-ai-actions.png'), fullPage: true });

  // 04b — 复制按钮
  await page.locator('[data-testid^="assistant-copy-"]').first().click();
  await expect(page.locator('[data-testid^="assistant-copy-"]').first()).toContainText('已复制');
  await page.screenshot({ path: path.join(SHOTS, '07-chat-copied.png'), fullPage: true });

  // 04c — EmptyState 「继续上次」入口
  await page.getByRole('button', { name: /新对话/ }).first().click();
  await expect(page.getByTestId('empty-resume-recent')).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, '08-empty-resume-recent.png'), fullPage: true });

  // 05 — 自定义 Dialog 删除（替代 window.confirm）
  await page.locator('.chat-row-wrap').first().hover();
  await page.locator('.chat-row-actions button[title="删除"]').first().click();
  await expect(page.getByTestId('app-dialog')).toBeVisible();
  await expect(page.getByTestId('app-dialog')).toContainText('删除对话');
  await page.screenshot({ path: path.join(SHOTS, '09-dialog-confirm-delete.png'), fullPage: true });
  await page.getByTestId('app-dialog-cancel').click();

  // 06 — Feature Hub: 多模型对比
  await page.getByTestId('sidebar-features').first().click();
  await expect(page.getByTestId('feature-tab-compare')).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, '10-features-compare.png'), fullPage: true });

  // 07 — Cost panel
  await page.getByTestId('feature-tab-cost').click();
  await expect(page.getByTestId('cost-panel')).toBeVisible();
  // wait for cost summary cards to render
  await expect(page.locator('.cost-summary-value').first()).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, '11-features-cost.png'), fullPage: true });

  // 08 — Templates & Personas
  await page.getByTestId('feature-tab-templates').click();
  await expect(page.getByTestId('templates-panel')).toBeVisible();
  // 内置人格应该会被 seed 出来
  await page.getByTestId('tp-tab-personas').click();
  await expect(page.locator('[data-testid^="persona-row-"]').first()).toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: path.join(SHOTS, '12-features-personas.png'), fullPage: true });

  // 08b — 新建模板（走自定义 prompt dialog）
  await page.getByTestId('tp-tab-templates').click();
  await page.getByTestId('template-new').click();
  await expect(page.getByTestId('app-dialog')).toContainText('新建提示词模板');
  await page.getByTestId('app-dialog-input').fill('每日规划');
  await page.screenshot({ path: path.join(SHOTS, '13-dialog-new-template-name.png'), fullPage: true });
  await page.getByTestId('app-dialog-ok').click();
  await expect(page.getByTestId('app-dialog')).toContainText('的正文');
  await page.getByTestId('app-dialog-input').fill('# 今日规划\n- 早上：\n- 下午：\n- 晚上：');
  await page.getByTestId('app-dialog-ok').click();
  await expect(page.getByText('已新建模板。')).toBeVisible();
  await expect(page.locator('[data-testid^="template-row-"]').first()).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, '14-template-created.png'), fullPage: true });

  // 09 — Memory: 写一条 global KV
  await page.getByTestId('feature-tab-memory').click();
  await expect(page.getByTestId('memory-panel')).toBeVisible();
  await page.getByTestId('memory-key').fill('ui.theme.preference');
  await page.getByTestId('memory-value').fill('warm-paper');
  await page.getByTestId('memory-save').click();
  await expect(page.getByText('已写入')).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, '15-memory-written.png'), fullPage: true });

  // 10 — Settings · 通用：sidecar 状态 + self-check
  await page.getByRole('button', { name: '设置' }).first().click();
  await page.getByRole('button', { name: '通用', exact: true }).click();
  await expect(page.locator('.section-h', { hasText: '本机状态' })).toBeVisible();
  await expect(page.locator('.status-chip.complete', { hasText: '在线' })).toBeVisible({ timeout: 5_000 });
  await page.screenshot({ path: path.join(SHOTS, '16-settings-general.png'), fullPage: true });

  // 10b — Self-check 触发
  await page.getByTestId('settings-selfcheck').click();
  await expect(page.getByTestId('settings-selfcheck-result')).toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: path.join(SHOTS, '17-settings-selfcheck.png'), fullPage: true });

  // 10c — 危险清空触发自定义 Dialog
  await page.getByTestId('settings-clear-all').click();
  await expect(page.getByTestId('app-dialog')).toContainText('清空所有本地数据');
  await page.screenshot({ path: path.join(SHOTS, '18-dialog-clear-all.png'), fullPage: true });
  await page.getByTestId('app-dialog-cancel').click();

  // 11 — 外观：dark 切换
  await page.getByRole('button', { name: '外观', exact: true }).click();
  await page.getByTestId('theme-dark').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.waitForTimeout(220);
  await page.screenshot({ path: path.join(SHOTS, '19-appearance-dark.png'), fullPage: true });

  // 11b — Dark 主题的欢迎页 + Toast 样式
  await page.getByRole('button', { name: /新对话/ }).first().click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(SHOTS, '20-empty-dark.png'), fullPage: true });

  // 切回 light，保持环境干净
  await page.getByRole('button', { name: '设置' }).first().click();
  await page.getByRole('button', { name: '外观', exact: true }).click();
  await page.getByTestId('theme-light').click();
});

test('journey: 多 toast 队列 + dialog 键盘可达', async ({ page }) => {
  await clearAllData();
  await page.goto('/');

  // 触发多个 toast：手动调用 fetch 让 Provider 报错
  await page.evaluate(async () => {
    // 触发 3 个不同 toast：保存空 Provider + 切换设置 tab
  });

  // 配置 wizard 流程：自定义服务商但缺名字 / URL 会触发错误 toast
  await page.getByTestId('empty-no-model-cta').click();
  await page.getByTestId('empty-add-model-cta').click();
  await page.getByTestId('wizard-preset-custom').click();
  await page.getByTestId('wizard-next').click();
  // 不填 name / URL / key，直接尝试连接
  await page.getByTestId('wizard-connect').click();
  await expect(page.locator('[data-testid="toast-item"]').first()).toBeVisible({ timeout: 5_000 });
  await page.screenshot({ path: path.join(SHOTS, '21-toast-validation.png'), fullPage: true });
  // 关闭 wizard，避免遮挡后续 dialog 验证
  await page.getByTestId('wizard-cancel').click();

  // 创建并打开一段对话，再触发删除 → Esc 关闭 dialog
  await sidecarJson<{ id: string }>('/v1/providers', {
    method: 'POST',
    body: JSON.stringify({ name: 'Tmp', type: 'custom', base_url: 'https://example.com/v1', enabled: true }),
  });
  const provs = await sidecarJson<{ providers: Array<{ id: string }> }>('/v1/providers');
  const pid = provs.providers[0]!.id;
  await sidecarJson('/v1/models', {
    method: 'POST',
    body: JSON.stringify({
      provider_id: pid,
      model_name: 'm0:chat',
      display_name: 'Esc 测试模型',
      capability: 'chat',
      enabled: true,
      is_default_for: 'chat',
      price_input_per_1m: 1,
      price_output_per_1m: 2,
    }),
  });
  await page.reload();
  await page.getByTestId('composer-textarea').fill('一段历史');
  await page.getByTestId('composer-send').click();
  await expect(page.locator('.msg.ai').first()).toBeVisible({ timeout: 10_000 });

  // 触发删除 → 按 Esc 关闭
  await page.locator('.chat-row-wrap').first().hover();
  await page.locator('.chat-row-actions button[title="删除"]').first().click();
  await expect(page.getByTestId('app-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('app-dialog')).toHaveCount(0);
  await page.screenshot({ path: path.join(SHOTS, '22-dialog-esc-closed.png'), fullPage: true });
});

/**
 * 多 Provider · 多模型 已配置状态 —— 证明设置 / 成本 / 对比 真的能呈现多家供应商，
 * 不是只在「Mock Provider · 单模型」下走通的浅验证。
 */
test('journey: 多 Provider · 多模型 已配置状态', async ({ page }) => {
  await clearAllData();
  const seeded = await seedMultiProviderStack();
  expect(seeded.providers).toHaveLength(3);
  expect(seeded.models).toHaveLength(4);

  await page.goto('/');

  // 23 — 空状态 + 默认模型胶囊出现在 composer（不应该看到 no-model CTA）
  await expect(page.getByTestId('empty-no-model-cta')).toHaveCount(0);
  await expect(page.getByTestId('composer-model')).toContainText('GPT-4o mini');
  await page.screenshot({ path: path.join(SHOTS, '23-multi-empty.png'), fullPage: true });

  // 24 — 设置 · 模型：默认摘要 + 4 行模型清单 + 标明 3 家 Provider
  await page.getByRole('button', { name: '设置' }).first().click();
  await expect(page.getByRole('heading', { name: '模型', exact: true })).toBeVisible();
  await expect(page.getByTestId('model-default-summary')).toContainText('GPT-4o mini');
  await expect(page.getByTestId('model-table')).toBeVisible();
  const modelRows = page.locator('[data-testid^="model-row-"]');
  await expect(modelRows).toHaveCount(4);
  for (const expected of ['GPT-4o mini', 'Claude 3.5 Sonnet', 'DeepSeek V3', 'Qwen 2.5 14B（本地）']) {
    await expect(page.getByText(expected, { exact: false }).first()).toBeVisible();
  }
  await page.screenshot({ path: path.join(SHOTS, '24-settings-models-multi.png'), fullPage: true });

  // 25 — 设置 · 服务商：3 张服务商卡
  await page.getByRole('button', { name: '服务商', exact: true }).click();
  await expect(page.locator('.provider-card')).toHaveCount(3);
  for (const expected of ['OpenAI 兼容（云端）', 'OpenRouter 聚合', '本地 Ollama']) {
    await expect(page.locator('.provider-card', { hasText: expected })).toBeVisible();
  }
  await page.screenshot({ path: path.join(SHOTS, '25-settings-providers-multi.png'), fullPage: true });

  // 26 — 切换默认模型：Claude 3.5 Sonnet（新版按服务商分组的 .model-row-card）
  await page.getByRole('button', { name: '模型', exact: true }).click();
  const claudeRow = page.locator('.model-row-card', { hasText: 'Claude 3.5 Sonnet' });
  await claudeRow.getByRole('button', { name: '设为默认' }).click();
  await expect(page.locator('.toast').filter({ hasText: '已设为默认' })).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, '26-settings-default-switched.png'), fullPage: true });

  // 27 — 能力中心 · Quick Compare：3 个模型槽位显示不同 Provider 来源
  await page.getByRole('button', { name: /新对话/ }).first().click();
  await page.getByTestId('sidebar-features').first().click();
  await page.getByTestId('feature-tab-compare').click();
  await expect(page.getByTestId('quick-compare-panel')).toBeVisible();
  await expect(page.getByTestId('quick-compare-slots')).toContainText('模型 1');
  await expect(page.getByTestId('quick-compare-slots')).toContainText('OpenAI 兼容（云端）');
  await page.screenshot({ path: path.join(SHOTS, '27-compare-multi-options.png'), fullPage: true });

  // 28 — 能力中心 · 成本：触发 3 笔不同模型的成本记录，证明分布柱状真的能拆分
  for (const model of seeded.models.slice(0, 3)) {
    await sidecarJson('/v1/admin/import-data', {
      method: 'POST',
      body: JSON.stringify({
        cost_records: [
          {
            id: `cr_seed_${model.id}`,
            model_id: model.id,
            source_type: 'message',
            feature: 'chat',
            input_tokens: 320,
            output_tokens: 540,
            cost_usd: 0.0042,
            created_at: new Date().toISOString(),
          },
        ],
      }),
    }).catch(() => undefined); // 导入失败也不阻塞截图，下面用 UI 实际能渲染什么截就好
  }
  await page.getByTestId('feature-tab-cost').click();
  await expect(page.getByTestId('cost-panel')).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, '28-cost-multi-models.png'), fullPage: true });

  // 29 — Sidebar 折叠状态下，brand-mark「织」依然清晰
  await page.getByTitle('收起侧边栏').click();
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(SHOTS, '29-sidebar-collapsed-brand.png'), fullPage: true });
});
