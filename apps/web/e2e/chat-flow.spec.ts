import { expect, test } from '@playwright/test';
import { clearAllData, seedLongConversation, seedMockChatModel, sidecarJson } from './test-api';

test('chat journey: multi-turn reply, cost metadata, markdown, and history restore', async ({ page }) => {
  const modelName = 'Qwen Chat';
  await clearAllData();
  await seedMockChatModel(modelName);

  await page.goto('/');
  await page.getByTestId('composer-textarea').fill('请用 Markdown 给我两条建议');
  await page.getByTestId('composer-send').click();

  await expect(page.locator('.msg.user', { hasText: '请用 Markdown 给我两条建议' })).toBeVisible();
  await expect(page.locator('.msg.ai', { hasText: '[M0 mock] You said' })).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.msg.ai', { hasText: 'End-to-end Renderer' })).toBeVisible();
  await expect(page.locator('.msg-cost-lead').first()).toContainText('$', { timeout: 10_000 });
  await expect(page.locator('.msg-cost-lead').first()).toContainText('tokens');
  await page.getByTestId('message-cost-toggle').first().click();
  await expect(page.locator('.msg-cost-details').first()).toContainText('首字');
  await expect(page.locator('.msg-cost-details').first()).toContainText('每字');
  await expect(page.getByTestId('composer-stop')).toHaveCount(0);

  await page.getByTestId('composer-textarea').fill('继续上文，再补充一个检查点');
  await page.getByTestId('composer-send').click();
  await expect(page.locator('.msg.user', { hasText: '继续上文' })).toBeVisible();
  await expect(page.locator('.msg.ai').nth(1)).toContainText('[M0 mock]', { timeout: 10_000 });
  await expect(page.locator('.msg.ai')).toHaveCount(2);

  const chatTitle = page.locator('.chat-row').first();
  await expect(chatTitle).toBeVisible();
  const titleText = await chatTitle.innerText();
  await expect.poll(async () => {
    const conversations = await sidecarJson<{ conversations: Array<{ id: string }> }>('/v1/conversations');
    const first = conversations.conversations[0];
    if (!first) return false;
    const data = await sidecarJson<{
      messages: Array<{ role: string; status: string; content: string }>;
    }>(`/v1/conversations/${first.id}/messages`);
    const assistant = data.messages.filter((message) => message.role === 'assistant').at(-1);
    return data.messages.length === 4 &&
      assistant?.status === 'complete' &&
      assistant.content.includes('[M0 mock]');
  }).toBe(true);
  await chatTitle.click();
  await expect(page.locator('.msg.user', { hasText: '请用 Markdown 给我两条建议' })).toBeVisible();
  await expect(page.locator('.msg.user', { hasText: '继续上文' })).toBeVisible();
  await expect(page.locator('.msg.ai', { hasText: '[M0 mock] You said' })).toHaveCount(2);
  await expect(page.getByTestId('run-timeline')).toHaveCount(0);

  await page.reload();
  await page.locator('.chat-row', { hasText: titleText.split('\n')[0] ?? 'Markdown' }).first().click();
  await expect(page.locator('.msg.user', { hasText: '继续上文' })).toBeVisible();
  await page.getByTestId('message-cost-toggle').last().click();
  await expect(page.locator('.msg-cost-details').last()).toContainText('输入');
  await expect(page.locator('.msg-cost-details').last()).toContainText('单价');
});

test('chat journey: high-frequency streaming remains responsive', async ({ page }) => {
  await clearAllData();
  const { modelId } = await seedMockChatModel('Streaming Stress');

  await page.route('**/v1/chat', async (route) => {
    const body = route.request().postDataJSON() as { model_id?: string };
    const chunks = Array.from({ length: 240 }, (_, index) => `0:${JSON.stringify(`片段${index} `)}`);
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: [
        `8:[{"type":"meta","conversation_id":"conv_stream_stress","message_id":"msg_stream_stress","model_id":"${body.model_id ?? modelId}","run_id":"run_stream_stress"}]`,
        ...chunks,
        'd:{"finishReason":"stop","usage":{"promptTokens":5,"completionTokens":240}}',
        '',
      ].join('\n'),
    });
  });

  await page.goto('/');
  await page.getByTestId('composer-textarea').fill('模拟高频小片段流式输出');
  await page.getByTestId('composer-send').click();
  await expect(page.locator('.msg.ai')).toContainText('片段239', { timeout: 10_000 });
  await expect(page.getByTestId('composer-textarea')).toBeEditable();
  await expect(page.locator('.msg.ai p').first()).toContainText('片段0');
});

test('chat journey: long conversations mount a bounded message window', async ({ page }) => {
  await clearAllData();
  const { modelId } = await seedMockChatModel('Long Window Chat');
  await seedLongConversation({
    conversationId: 'conv_long_window',
    title: '长对话窗口化验证',
    modelId,
    messageCount: 140,
  });

  await page.goto('/');
  await page.locator('.chat-row', { hasText: '长对话窗口化验证' }).first().click();

  await expect(page.locator('.msg')).toHaveCount(80);
  await expect(page.getByTestId('message-window-notice')).toContainText('已收起 60 条历史');
  await expect(page.locator('.msg', { hasText: '长对话第 1 条' })).toHaveCount(0);
  await expect(page.locator('.msg', { hasText: '长对话第 140 条' })).toBeVisible();
  await expect(page.getByTestId('composer-textarea')).toBeEditable();

  await page.getByTestId('message-load-earlier').click();
  await expect(page.locator('.msg')).toHaveCount(140);
  await expect(page.locator('.msg', { hasText: '长对话第 1 条' })).toBeVisible();
  await expect(page.getByTestId('message-window-notice')).toHaveCount(0);
});

test('chat visual: short user messages keep a natural bubble width', async ({ page }) => {
  await clearAllData();
  await seedMockChatModel('Short Bubble Chat');

  await page.goto('/');
  await page.getByTestId('composer-textarea').fill('最新的深圳新闻');
  await page.getByTestId('composer-send').click();
  const bubble = page.locator('.msg.user .bubble', { hasText: '最新的深圳新闻' }).first();
  await expect(bubble).toBeVisible();
  await expect.poll(async () => bubble.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  })).toMatchObject({
    width: expect.any(Number),
    height: expect.any(Number),
  });
  const box = await bubble.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(120);
  expect(box?.height ?? 0).toBeLessThan(70);
});

test('chat journey: history supports bulk delete', async ({ page }) => {
  await clearAllData();
  await seedMockChatModel('Bulk History Chat');

  await page.goto('/');
  await page.getByTestId('composer-textarea').fill('批量删除临时对话 A');
  await page.getByTestId('composer-send').click();
  await expect(page.locator('.msg.ai', { hasText: '[M0 mock]' })).toBeVisible({ timeout: 10_000 });

  await page.getByRole('button', { name: '新对话' }).first().click();
  await page.getByTestId('composer-textarea').fill('批量删除临时对话 B');
  await page.getByTestId('composer-send').click();
  await expect(page.locator('.msg.ai', { hasText: '[M0 mock]' }).last()).toBeVisible({ timeout: 10_000 });

  await expect.poll(async () => {
    const data = await sidecarJson<{ conversations: Array<{ id: string }> }>('/v1/conversations');
    return data.conversations.length;
  }).toBe(2);

  await page.getByTestId('history-manage').click();
  await page.getByTestId('history-select-all').click();
  await expect(page.getByText('已选 2 个')).toBeVisible();
  await page.getByTestId('history-bulk-delete').click();
  await expect(page.getByTestId('app-dialog')).toContainText('删除 2 个对话');
  await page.getByTestId('app-dialog-ok').click();
  await expect(page.locator('.toast').filter({ hasText: '已删除 2 个对话' })).toBeVisible();
  await expect(page.getByText('还没有对话。')).toBeVisible({ timeout: 10_000 });

  await expect.poll(async () => {
    const data = await sidecarJson<{ conversations: Array<{ id: string }> }>('/v1/conversations');
    return data.conversations.length;
  }).toBe(0);
});

test('chat journey: composer model switcher selects the next chat model directly', async ({ page }) => {
  await clearAllData();
  await seedMockChatModel('Switch Primary');
  const target = await seedMockChatModel('Switch Target');
  let requestedModelId: string | null = null;

  await page.route('**/v1/chat', async (route) => {
    const body = route.request().postDataJSON() as { model_id?: string };
    requestedModelId = body.model_id ?? null;
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: [
        `8:[{"type":"meta","conversation_id":"conv_switch","message_id":"msg_switch","model_id":"${target.modelId}","run_id":"run_switch"}]`,
        '0:"已使用切换后的模型回答。"',
        'd:{"finishReason":"stop","usage":{"promptTokens":3,"completionTokens":5}}',
        '',
      ].join('\n'),
    });
  });

  await page.goto('/');
  await page.getByTestId('composer-model').click();
  await expect(page.getByTestId('composer-model-picker')).toBeVisible();
  await expect(page.getByRole('heading', { name: '模型', exact: true })).toHaveCount(0);
  await page.getByTestId('composer-model-search').fill('Switch Target');
  await page.getByTestId(`composer-model-option-${target.modelId}`).click();
  await expect(page.getByTestId('composer-model-picker')).toHaveCount(0);
  await expect(page.getByTestId('composer-model')).toContainText('Switch Target');

  await page.getByTestId('composer-textarea').fill('用切换后的模型回答');
  await page.getByTestId('composer-send').click();
  await expect(page.locator('.msg.ai', { hasText: '已使用切换后的模型回答' })).toBeVisible({ timeout: 10_000 });
  expect(requestedModelId).toBe(target.modelId);
});

test('chat journey: model shortcuts hide unavailable chat models', async ({ page }) => {
  await clearAllData();
  const usableModel = await seedMockChatModel('Usable Shortcut');
  const disabledProvider = await sidecarJson<{ id: string }>('/v1/providers', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Disabled Provider',
      type: 'custom',
      base_url: 'https://disabled-provider.example/v1',
    }),
  });
  await sidecarJson(`/v1/providers/${disabledProvider.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ enabled: false }),
  });
  const disabledProviderModel = await sidecarJson<{ id: string }>('/v1/models', {
    method: 'POST',
    body: JSON.stringify({
      provider_id: disabledProvider.id,
      model_name: 'disabled-provider-model',
      display_name: 'Disabled Provider Model',
      capability: 'chat',
      enabled: true,
    }),
  });
  const disabledModel = await sidecarJson<{ id: string }>('/v1/models', {
    method: 'POST',
    body: JSON.stringify({
      provider_id: usableModel.providerId,
      model_name: 'disabled-model',
      display_name: 'Disabled Model',
      capability: 'chat',
      enabled: false,
    }),
  });

  await page.goto('/');
  await page.getByTestId('composer-model').click();
  await expect(page.getByTestId('composer-model-picker')).toBeVisible();
  await expect(page.getByTestId('composer-model-picker')).toContainText('Usable Shortcut');
  await expect(page.getByTestId('composer-model-picker')).not.toContainText('Disabled Provider Model');
  await expect(page.getByTestId('composer-model-picker')).not.toContainText('Disabled Model');
  await page.locator('[data-testid="composer-model-picker"] .modal-head .icon-btn').click();

  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
  await expect(page.getByTestId('command-palette')).toBeVisible();
  await page.getByTestId('command-palette-input').fill('Disabled');
  await expect(page.getByTestId('command-palette')).not.toContainText('Disabled Provider Model');
  await expect(page.getByTestId('command-palette')).not.toContainText('Disabled Model');

  await sidecarJson(`/v1/models/${disabledProviderModel.id}`, { method: 'DELETE' });
  await sidecarJson(`/v1/models/${disabledModel.id}`, { method: 'DELETE' });
  await sidecarJson(`/v1/providers/${disabledProvider.id}`, { method: 'DELETE' });
});

test('chat journey: image capability route is visible and persisted', async ({ page }) => {
  await clearAllData();
  await seedMockChatModel('Route Chat');

  await page.goto('/');
  await page.getByTestId('composer-textarea').fill('/image 蓝色机器人海报');
  await page.getByTestId('composer-send').click();

  await expect(page.locator('.msg.user', { hasText: '蓝色机器人海报' })).toBeVisible();
  await expect(page.locator('.msg.ai', { hasText: '已识别为图片生成请求' })).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.msg.ai', { hasText: '提示词：蓝色机器人海报' })).toBeVisible();
  await expect(page.getByTestId('composer-stop')).toHaveCount(0);

  const conversations = await sidecarJson<{ conversations: Array<{ id: string; title: string | null }> }>('/v1/conversations');
  const routed = conversations.conversations.find((item) => item.title?.includes('蓝色机器人'));
  expect(routed).toBeTruthy();
  const messages = await sidecarJson<{ messages: Array<{ role: string; content: string; status: string }> }>(
    `/v1/conversations/${routed!.id}/messages`,
  );
  expect(messages.messages).toHaveLength(1);
  expect(messages.messages[0]).toMatchObject({ role: 'user', status: 'complete' });
});

test('chat journey: provider failure releases composer and marks assistant failed', async ({ page }) => {
  await clearAllData();
  await seedMockChatModel('Failure Chat');

  await page.route('**/v1/chat', async (route) => {
    const headers = {
      ...route.request().headers(),
      'x-test-force-classification': 'network',
    };
    await route.continue({ headers });
  });

  await page.goto('/');
  await page.getByTestId('composer-textarea').fill('模拟一次网络失败');
  await page.getByTestId('composer-send').click();

  await expect(page.locator('.msg.user', { hasText: '模拟一次网络失败' })).toBeVisible();
  await expect(page.locator('.msg.ai .recovery-card')).toContainText('network', { timeout: 10_000 });
  await expect(page.getByTestId('composer-stop')).toHaveCount(0);
  await expect(page.getByTestId('composer-send')).toBeVisible();
});

test('chat journey: Enter during Chinese IME composition does not send', async ({ page }) => {
  await clearAllData();
  await seedMockChatModel('IME Chat');

  await page.goto('/');
  const textarea = page.getByTestId('composer-textarea');
  await textarea.fill('ni');
  await textarea.dispatchEvent('compositionstart');
  await textarea.press('Enter');

  await expect(page.locator('.msg.user')).toHaveCount(0);
  await expect(page.locator('.msg.ai')).toHaveCount(0);
  await expect(textarea).toHaveValue(/ni/);

  await textarea.dispatchEvent('compositionend');
  await textarea.fill('你好');
  await textarea.press('Enter');
  await expect(page.locator('.msg.user')).toHaveCount(0);
  await expect(textarea).toHaveValue('你好');

  await page.waitForTimeout(160);
  await textarea.press('Enter');
  await expect(page.locator('.msg.user', { hasText: '你好' })).toBeVisible();
  await expect(page.locator('.msg.ai', { hasText: '[M0 mock]' })).toBeVisible({ timeout: 10_000 });
});

test('chat journey: tool call trace is visible and the chat can continue', async ({ page }) => {
  await clearAllData();
  const { modelId } = await seedMockChatModel('Tool Chat');
  let callCount = 0;

  await page.route('**/v1/chat', async (route) => {
    callCount += 1;
    const messageId = `msg_tool_${callCount}`;
    const body = callCount === 1
      ? [
          `8:[{"type":"meta","conversation_id":"conv_tool","message_id":"msg_tool_1","model_id":"${modelId}","run_id":"run_tool_1"}]`,
          '8:[{"type":"tool_trace","message_id":"msg_tool_1","event":"start","call_id":"c1","tool":"builtin.web_fetch","label":"抓取网页","input":"https://example.com"}]',
          '8:[{"type":"tool_trace","message_id":"msg_tool_1","event":"finish","call_id":"c1","tool":"builtin.web_fetch","label":"抓取网页","input":"https://example.com","ok":true,"output":"Example Domain","duration_ms":12}]',
          '0:"工具结果已整合。Example Domain 是一个用于文档示例的保留域名。"',
          '8:[{"type":"cost","message_id":"msg_tool_1","input_tokens":12,"cache_input_tokens":5,"output_tokens":8,"actual_usd":0.0001}]',
          'd:{"finishReason":"stop","usage":{"promptTokens":12,"completionTokens":8}}',
        ].join('\n')
      : [
          `8:[{"type":"meta","conversation_id":"conv_tool","message_id":"${messageId}","model_id":"${modelId}","run_id":"run_tool_${callCount}"}]`,
          '0:"可以继续对话，我会沿用上一轮工具结果。"',
          `8:[{"type":"cost","message_id":"${messageId}","input_tokens":20,"output_tokens":10,"actual_usd":0.0002}]`,
          'd:{"finishReason":"stop","usage":{"promptTokens":20,"completionTokens":10}}',
        ].join('\n');
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: `${body}\n`,
    });
  });

  await page.goto('/');
  await page.getByTestId('composer-textarea').fill('请抓取 example.com 并总结用途');
  await page.getByTestId('composer-send').click();

  await expect(page.locator('.msg.user', { hasText: '请抓取 example.com' })).toBeVisible();
  await expect(page.getByTestId('tool-trace-list')).toContainText('抓取网页', { timeout: 10_000 });
  await expect(page.getByTestId('tool-trace-list')).toContainText('完成');
  await expect(page.getByTestId('tool-trace-list')).toContainText('Example Domain');
  await expect(page.locator('.msg.ai', { hasText: '工具结果已整合' })).toBeVisible();
  await expect(page.locator('.msg-cost-lead').last()).toContainText('$');
  await page.getByTestId('message-cost-toggle').last().click();
  await expect(page.locator('.msg-cost-details').last()).toContainText('缓存 5');
  await expect(page.locator('.msg-cost-details').last()).toContainText('单价');
  await expect(page.getByTestId('composer-stop')).toHaveCount(0);

  await page.getByTestId('composer-textarea').fill('继续给我一个下一步建议');
  await page.getByTestId('composer-send').click();
  await expect(page.locator('.msg.user', { hasText: '继续给我一个下一步建议' })).toBeVisible();
  await expect(page.locator('.msg.ai', { hasText: '沿用上一轮工具结果' })).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.msg.ai')).toHaveCount(2);
});

test('chat journey: orchestration notice explains automatic search and routes to research', async ({ page }) => {
  await clearAllData();
  await seedMockChatModel('Orchestration Chat');
  const objective = '系统研究 2026 年桌面 AI 助手市场格局、主要玩家、BYOK 用户需求、工具调用趋势、成本透明体验、失败兜底设计、个人知识库整合和商业化机会，输出一份可执行产品建议与分阶段路线图。';

  await page.goto('/');
  await page.getByTestId('composer-textarea').fill(objective);
  await page.getByTestId('composer-send').click();

  await expect(page.getByTestId('orchestration-notice')).toContainText('问题适合深度研究', { timeout: 10_000 });
  await expect(page.getByTestId('orchestration-notice')).toContainText('建议深度研究');
  await expect(page.getByTestId('orchestration-notice')).toContainText('要求引用来源');
  await expect.poll(async () => {
    const data = await sidecarJson<{ conversations: Array<{ id: string }> }>('/v1/conversations');
    const conversationId = data.conversations[0]?.id;
    if (!conversationId) return [];
    const events = await sidecarJson<{ data: { events: Array<{ kind: string }> } }>(
      `/v1/conversations/${conversationId}/run-events?limit=80`,
    );
    return events.data.events.map((event) => event.kind);
  }).toContain('orchestration.plan');
  await page.getByTestId('open-run-timeline').click();
  await expect(page.getByTestId('run-timeline-panel')).toBeVisible();
  await expect(page.getByTestId('run-event').filter({ hasText: '能力编排计划' }).first()).toContainText('问题适合深度研究');
  await expect(page.getByTestId('run-event').filter({ hasText: '能力编排计划' }).first()).toContainText('建议深度研究');
  await page.getByTestId('run-timeline-close').click();
  await expect(page.getByTestId('run-timeline-panel')).toHaveCount(0);
  await page.getByRole('button', { name: '转为深度研究' }).click();
  await expect(page.getByTestId('research-panel')).toBeVisible();
  await expect(page.getByTestId('research-objective')).toHaveValue(objective);
});
