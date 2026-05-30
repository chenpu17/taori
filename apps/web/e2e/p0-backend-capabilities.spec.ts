import path from 'node:path';
import { expect, test } from '@playwright/test';
import { clearAllData, seedMockChatModel, sidecarJson, sidecarText } from './test-api';

test('P0: conversation actions, message edit/branch, attachment, export, and recovery', async ({ page }) => {
  await clearAllData();
  await seedMockChatModel('P0 Chat');

  await page.goto('/');

  await page.getByTestId('composer-textarea').fill('第一轮：记住关键词青梅');
  await page.getByTestId('composer-send').click();
  await expect(page.locator('.msg.ai', { hasText: '[M0 mock]' })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('run-timeline')).toHaveCount(0);

  let conversations = await sidecarJson<{ conversations: Array<{ id: string; title: string | null; pinned: boolean; archived: boolean }> }>('/v1/conversations');
  const conversation = conversations.conversations[0];
  expect(conversation).toBeTruthy();
  const conversationId = conversation!.id;

  await page.getByTestId(`conversation-rename-${conversationId}`).click();
  await expect(page.getByTestId('app-dialog')).toContainText('重命名对话');
  await page.getByTestId('app-dialog-input').fill('P0 重命名对话');
  await page.getByTestId('app-dialog-ok').click();
  await expect(page.locator('.chat-row', { hasText: 'P0 重命名对话' })).toBeVisible();

  await page.getByTestId(`conversation-pin-${conversationId}`).click();
  await expect.poll(async () => {
    const data = await sidecarJson<{ conversations: Array<{ id: string; pinned: boolean }> }>('/v1/conversations');
    return data.conversations.find((item) => item.id === conversationId)?.pinned ?? false;
  }).toBe(true);

  await page.getByTestId('composer-textarea').fill('第二轮：继续回答');
  await page.getByTestId('composer-send').click();
  await expect(page.locator('.msg.ai')).toHaveCount(2, { timeout: 10_000 });

  const beforeEdit = await sidecarJson<{
    messages: Array<{ id: string; role: string; content: string; status: string }>;
  }>(`/v1/conversations/${conversationId}/messages`);
  const firstUser = beforeEdit.messages.find((message) => message.role === 'user');
  expect(firstUser).toBeTruthy();

  await page.getByTestId(`message-edit-${firstUser!.id}`).click();
  await expect(page.getByTestId('app-dialog')).toContainText('编辑这条用户消息');
  await page.getByTestId('app-dialog-input').fill('第一轮：改成关键词乌梅');
  await page.getByTestId('app-dialog-ok').click();
  await expect(page.locator(".toast").filter({ hasText: '已编辑消息' })).toBeVisible( { timeout: 10_000 });
  await expect(page.getByTestId('composer-textarea')).toHaveValue('第一轮：改成关键词乌梅');
  await expect.poll(async () => {
    const data = await sidecarJson<{ messages: Array<{ role: string; content: string }> }>(
      `/v1/conversations/${conversationId}/messages`,
    );
    return data.messages.map((message) => message.content);
  }).toEqual(['第一轮：改成关键词乌梅']);

  await page.getByTestId('composer-send').click();
  await expect(page.locator('.msg.ai', { hasText: '[M0 mock]' })).toBeVisible({ timeout: 10_000 });
  await expect.poll(async () => {
    const data = await sidecarJson<{ messages: Array<{ role: string; content: string }> }>(
      `/v1/conversations/${conversationId}/messages`,
    );
    return data.messages.filter((message) => message.role === 'user').map((message) => message.content);
  }).toEqual(['第一轮：改成关键词乌梅']);

  const afterRegenerate = await sidecarJson<{
    messages: Array<{ id: string; role: string; content: string }>;
  }>(`/v1/conversations/${conversationId}/messages`);
  const regeneratedUser = afterRegenerate.messages.find((message) => message.role === 'user');
  expect(regeneratedUser).toBeTruthy();

  await page.getByTestId(`message-branch-${regeneratedUser!.id}`).click();
  await expect(page.locator(".toast").filter({ hasText: '已创建分支对话' })).toBeVisible( { timeout: 10_000 });
  await expect(page.locator('.topbar-title')).toContainText('分支');
  conversations = await sidecarJson<{ conversations: Array<{ id: string; title: string | null }> }>('/v1/conversations');
  const branched = conversations.conversations.find((item) => item.id !== conversationId && item.title?.includes('分支'));
  expect(branched).toBeTruthy();

  await page.getByRole('button', { name: '新对话' }).click();
  await page.getByTestId('composer-file-input').setInputFiles({
    name: 'p0-note.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('P0 attachment note: hawthorn', 'utf8'),
  });
  await expect(page.locator('.attach-chip', { hasText: 'p0-note.txt' })).toBeVisible();
  await page.getByTestId('composer-textarea').fill('请读取附件并总结');
  await page.getByTestId('composer-send').click();
  await expect(page.getByTestId('message-attachment-count')).toContainText('1 个附件', { timeout: 10_000 });
  let attachmentConversationId: string | null = null;
  await expect.poll(async () => {
    const data = await sidecarJson<{ conversations: Array<{ id: string }> }>('/v1/conversations');
    for (const item of data.conversations) {
      const messages = await sidecarJson<{ messages: Array<{ role: string; content: string; attachments_count: number }> }>(
        `/v1/conversations/${item.id}/messages`,
      );
      if (messages.messages.some((message) => message.role === 'user' && message.content.includes('请读取附件'))) {
        attachmentConversationId = item.id;
        return item.id;
      }
    }
    return null;
  }).not.toBeNull();
  expect(attachmentConversationId).toBeTruthy();
  const attachmentMessages = await sidecarJson<{ messages: Array<{ role: string; content: string; attachments_count: number }> }>(
    `/v1/conversations/${attachmentConversationId!}/messages`,
  );
  expect(attachmentMessages.messages.find((message) => message.role === 'user')?.attachments_count).toBe(1);

  const exportResponse = await sidecarText(
    `/v1/conversations/${attachmentConversationId!}/export?format=markdown&include_timeline=summary`,
  );
  expect(exportResponse).toContain('请读取附件并总结');

  await page.unroute('**/v1/chat').catch(() => undefined);
  let failedRunId: string | null = null;
  await page.route('**/v1/chat', async (route) => {
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: [
        '8:[{"type":"meta","conversation_id":"conv_ui_recover","message_id":"msg_ui_recover","model_id":"mdl_ui","run_id":"run_ui_recover"}]',
        '3:"network"',
        'd:{"finishReason":"error","usage":{"promptTokens":1,"completionTokens":0}}',
        '',
      ].join('\n'),
    });
  });
  await page.route('**/v1/runs/*/recover', async (route) => {
    failedRunId = route.request().url().match(/\/v1\/runs\/([^/]+)\/recover/)?.[1] ?? null;
    const body = route.request().postDataJSON() as { action?: string; confirmed_cost?: boolean };
    expect(body.action).toBe('retry_same_model');
    expect(body.confirmed_cost).toBe(true);
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: [
        '8:[{"type":"meta","conversation_id":"conv_ui_recover","message_id":"msg_ui_recover","model_id":"mdl_ui","run_id":"run_ui_recover_retry"}]',
        '0:"恢复重试完成。"',
        'd:{"finishReason":"stop","usage":{"promptTokens":1,"completionTokens":1}}',
        '',
      ].join('\n'),
    });
  });
  await page.getByRole('button', { name: '新对话' }).click();
  await page.getByTestId('composer-textarea').fill('制造一次可恢复失败');
  await page.getByTestId('composer-send').click();
  await expect(page.locator('.msg.ai .recovery-card')).toContainText('network', { timeout: 10_000 });
  await page.getByTestId('recover-retry-msg_ui_recover').click();
  await expect(page.locator('.msg.ai', { hasText: '恢复重试完成' })).toBeVisible({ timeout: 10_000 });
  expect(failedRunId).toBe('run_ui_recover');
});

test('P0: settings center calls key status, model health, probe, recommendations, and reorder', async ({ page }) => {
  await clearAllData();
  const first = await seedMockChatModel('P0 Fast');
  const second = await sidecarJson<{ id: string }>('/v1/models', {
    method: 'POST',
    body: JSON.stringify({
      provider_id: first.providerId,
      model_name: 'p0-cheap:chat',
      display_name: 'P0 Cheap',
      capability: 'chat',
      enabled: true,
      price_input_per_1m: 0.1,
      price_output_per_1m: 0.2,
    }),
  });

  await page.goto('/');
  await page.getByRole('button', { name: '设置' }).first().click();
  await expect(page.getByRole('heading', { name: '模型', exact: true })).toBeVisible();

  // 推荐 + 健康都收纳到「推荐 ▾」下拉里
  await page.getByTestId('model-recommend-menu').locator('summary').click();
  await page.getByTestId('model-health-refresh').click();
  await expect(page.locator(".toast").filter({ hasText: '模型健康已刷新' })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId(`model-row-${first.modelId}`)).toContainText('调用');

  await page.getByTestId('model-recommend-menu').locator('summary').click();
  await page.getByTestId('model-recommend-cheap').click();
  await expect(page.locator(".toast").filter({ hasText: /已设为默认|没有可推荐/ })).toBeVisible({ timeout: 10_000 });

  // 探测按钮（单个图标按钮）现在仍直接可见
  await page.getByTestId(`model-test-${first.modelId}`).click();
  await expect(page.locator(".toast").filter({ hasText: /API key|configured|missing|失败/i })).toBeVisible({ timeout: 10_000 });

  // 上移在每行的 ⋯ 菜单里
  await page.getByTestId(`model-actions-${second.id}`).locator('summary').click();
  await page.getByTestId(`model-move-up-${second.id}`).click();
  await expect(page.locator(".toast").filter({ hasText: '备援顺序已更新' })).toBeVisible({ timeout: 10_000 });
  await expect.poll(async () => {
    const data = await sidecarJson<{ models: Array<{ id: string; fallback_order: number }> }>('/v1/models');
    return data.models
      .filter((model) => model.id === first.modelId || model.id === second.id)
      .sort((a, b) => a.fallback_order - b.fallback_order)
      .map((model) => model.id);
  }).toEqual([second.id, first.modelId]);

  await page.getByRole('button', { name: '服务商', exact: true }).click();
  await page.getByTestId('provider-key-status-refresh').click();
  await expect(page.locator(".toast").filter({ hasText: 'Key 状态已刷新' })).toBeVisible({ timeout: 10_000 });
  // The seeded provider was created without binding an API key, so the truthful
  // post-refresh state is "未绑定 Key" (not the bound-but-missing "Key 缺失" path).
  await expect(page.locator('.provider-card', { hasText: 'P0 Fast Provider' })).toContainText('未绑定 Key');
});
