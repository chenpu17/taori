import path from 'node:path';
import { expect, test, type Page, type Route } from '@playwright/test';
import { clearAllData, seedMockChatModel, sidecarJson } from './test-api';

const now = 1_780_000_000_000;
const screenshotsDir = path.join(process.cwd(), 'test-results', 'visual');

async function expectNoHorizontalOverflow(page: import('@playwright/test').Page): Promise<void> {
  await expect.poll(async () => page.evaluate(() => {
    const nodes = [
      document.documentElement,
      document.body,
      ...Array.from(document.querySelectorAll('.sidebar, .main, .feature-shell, .feature-panel, .compare-grid, .round-grid, .tool-grid')),
    ];
    return nodes
      .filter((node) => node.scrollWidth > node.clientWidth + 1)
      .map((node) => ({
        tag: node instanceof Element ? node.tagName.toLowerCase() : 'node',
        className: node instanceof Element ? node.className : '',
        testId: node instanceof Element ? node.getAttribute('data-testid') : null,
        scrollWidth: node.scrollWidth,
        clientWidth: node.clientWidth,
      }));
  })).toEqual([]);
}

async function expectMobileSidebarIsIconRail(page: Page): Promise<void> {
  await expect.poll(async () => page.locator('.sidebar').evaluate((node) => node.clientWidth)).toBeLessThanOrEqual(56);
  await expect.poll(async () => page.locator('.sidebar').evaluate((node) => (node as HTMLElement).innerText.trim())).toBe('织');
}

test.setTimeout(60_000);

type ModelSeed = { providerId: string; modelId: string };

async function seedModels(names: string[]): Promise<ModelSeed[]> {
  const seeds: ModelSeed[] = [];
  for (const name of names) seeds.push(await seedMockChatModel(name));
  return seeds;
}

async function openFeatureHub(page: Page): Promise<void> {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByTestId('sidebar-features').click();
  await expect(page.getByTestId('quick-compare-panel')).toBeVisible();
}

async function fulfillStream(route: Route, lines: string[]): Promise<void> {
  await route.fulfill({
    status: 200,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
    body: `${lines.join('\n')}\n`,
  });
}

async function selectOptionByText(page: Page, testId: string, pattern: RegExp): Promise<void> {
  const select = page.getByTestId(testId).locator('select');
  const value = await select.locator('option').evaluateAll((options, source) => {
    const regex = new RegExp(source);
    const found = options.find((option) => regex.test(option.textContent ?? '')) as HTMLOptionElement | undefined;
    return found?.value ?? '';
  }, pattern.source);
  expect(value).toBeTruthy();
  await select.selectOption(value);
}

test('P1 journey: Quick Compare can compare, retry, adopt, and return to chat', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await clearAllData();
  await seedModels(['P1 Fast', 'P1 Deep', 'P1 Cheap']);

  await openFeatureHub(page);
  await expect(page.getByTestId('quick-compare-picker')).toContainText('对比模型');
  await expect(page.getByTestId('quick-compare-slots')).toContainText('模型 1');
  await expect(page.getByTestId('quick-compare-slots')).toContainText('模型 2');
  await page.getByTestId('quick-compare-open-picker').click();
  await expect(page.getByTestId('quick-compare-model-dialog')).toBeVisible();
  await page.getByTestId('quick-compare-preset-providers').click();
  await page.getByTestId('quick-compare-apply-models').click();
  await selectOptionByText(page, 'quick-compare-slot-1', /P1 Deep/);
  await expect(page.getByTestId('quick-compare-panel')).toBeVisible();
  expect(pageErrors).toEqual([]);
  await expect(page.getByTestId('quick-compare-slot-1')).toContainText('P1 Deep');
  expect(pageErrors).toEqual([]);
  await page.getByTestId('quick-compare-prompt').fill('比较 Electron 与 Tauri 的产品取舍');
  await page.getByTestId('quick-compare-start').click();

  await expect(page.getByTestId('quick-compare-output-0')).toContainText('Quick Compare 本地预览', { timeout: 10_000 });
  await expect(page.getByTestId('quick-compare-output-1')).toContainText('Quick Compare 本地预览', { timeout: 10_000 });
  await expect(page.getByTestId('quick-compare-output-2')).toContainText('Quick Compare 本地预览', { timeout: 10_000 });
  await expect(page.getByTestId('quick-compare-output-0')).toContainText('未联网调用模型', { timeout: 10_000 });
  await expect(page.getByTestId('quick-compare-output-0')).toContainText('执行：本地预览', { timeout: 10_000 });
  await expect(page.getByTestId('quick-compare-summary')).toContainText('最快', { timeout: 10_000 });

  await page.getByTestId('quick-compare-retry-0').click();
  await expect(page.locator(".toast").filter({ hasText: '候选已重试' })).toBeVisible( { timeout: 10_000 });

  await page.getByTestId('quick-compare-adopt-1').click();
  await expect(page.locator(".toast").filter({ hasText: '已采纳候选回复' })).toBeVisible( { timeout: 10_000 });
  await expect(page.locator('.msg.ai', { hasText: 'Quick Compare 本地预览' })).toBeVisible({ timeout: 10_000 });
});

test('P1 UX: Quick Compare model choices show provider source for duplicate names', async ({ page }) => {
  await clearAllData();
  const firstProvider = await sidecarJson<{ id: string }>('/v1/providers', {
    method: 'POST',
    body: JSON.stringify({
      name: 'OpenRouter 聚合',
      type: 'custom',
      base_url: 'https://openrouter.example/v1',
      enabled: true,
    }),
  });
  const secondProvider = await sidecarJson<{ id: string }>('/v1/providers', {
    method: 'POST',
    body: JSON.stringify({
      name: '火山方舟',
      type: 'custom',
      base_url: 'https://ark.example/v1',
      enabled: true,
    }),
  });
  await sidecarJson('/v1/models', {
    method: 'POST',
    body: JSON.stringify({
      provider_id: firstProvider.id,
      model_name: 'deepseek/deepseek-v4-flash',
      display_name: 'DeepSeek V4 Flash',
      capability: 'chat',
      enabled: true,
    }),
  });
  await sidecarJson('/v1/models', {
    method: 'POST',
    body: JSON.stringify({
      provider_id: secondProvider.id,
      model_name: 'deepseek-v4-flash',
      display_name: 'DeepSeek V4 Flash',
      capability: 'chat',
      enabled: true,
    }),
  });

  await openFeatureHub(page);
  await page.getByTestId('quick-compare-open-picker').click();
  await page.getByTestId('quick-compare-preset-same-name').click();
  await page.getByTestId('quick-compare-apply-models').click();
  await expect(page.getByTestId('quick-compare-slot-0')).toContainText('OpenRouter 聚合');
  await expect(page.getByTestId('quick-compare-slot-1')).toContainText('火山方舟');
});

test('P1 UX: Quick Compare remembers selected models locally', async ({ page }) => {
  await clearAllData();
  await seedModels(['Remember A', 'Remember B', 'Remember C', 'Remember D']);

  await openFeatureHub(page);
  await selectOptionByText(page, 'quick-compare-slot-1', /Remember D/);
  await expect(page.getByTestId('quick-compare-slot-1')).toContainText('Remember D');

  await openFeatureHub(page);
  await expect(page.getByTestId('quick-compare-slot-1')).toContainText('Remember D');
});

test('P1 UX: Quick Compare skips locally remembered unavailable models', async ({ page }) => {
  await clearAllData();
  const [first, second] = await seedModels(['Unavailable A', 'Unavailable B', 'Unavailable C']);

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.evaluate((modelIds) => {
    window.localStorage.setItem('taori.web.prefs.v1', JSON.stringify({
      theme: 'light',
      density: 'regular',
      selectedModelId: null,
      quickCompareModelIds: modelIds,
    }));
  }, [first.modelId, second.modelId]);
  await sidecarJson(`/v1/models/${second.modelId}`, {
    method: 'PATCH',
    body: JSON.stringify({ enabled: false }),
  });

  await openFeatureHub(page);
  await expect(page.getByTestId('quick-compare-slots')).toContainText('Unavailable A');
  await expect(page.getByTestId('quick-compare-slots')).toContainText('Unavailable C');
  await expect(page.getByTestId('quick-compare-slots')).not.toContainText('Unavailable B');
  await expect(page.getByTestId('quick-compare-slot-1')).toContainText('Unavailable C');
});

test('P1 UX: Quick Compare skips models from disabled providers', async ({ page }) => {
  await clearAllData();
  const [first, second] = await seedModels(['Provider On A', 'Provider Off B', 'Provider On C']);
  await sidecarJson(`/v1/providers/${second.providerId}`, {
    method: 'PATCH',
    body: JSON.stringify({ enabled: false }),
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.evaluate((modelIds) => {
    window.localStorage.setItem('taori.web.prefs.v1', JSON.stringify({
      theme: 'light',
      density: 'regular',
      selectedModelId: null,
      quickCompareModelIds: modelIds,
    }));
  }, [first.modelId, second.modelId]);

  await openFeatureHub(page);
  await expect(page.getByTestId('quick-compare-slots')).toContainText('Provider On A');
  await expect(page.getByTestId('quick-compare-slots')).toContainText('Provider On C');
  await expect(page.getByTestId('quick-compare-slots')).not.toContainText('Provider Off B');
  await page.getByTestId('quick-compare-open-picker').click();
  await expect(page.getByTestId('quick-compare-model-dialog')).not.toContainText('Provider Off B');
});

test('P1 stability: leaving Quick Compare aborts the active stream', async ({ page }) => {
  await clearAllData();
  await seedModels(['Abort A', 'Abort B']);
  let markRouteStarted: (() => void) | null = null;
  let releaseRoute: (() => void) | null = null;
  const routeStarted = new Promise<void>((resolve) => {
    markRouteStarted = resolve;
  });
  const routeReleased = new Promise<void>((resolve) => {
    releaseRoute = resolve;
  });
  const requestFailed = page.waitForEvent('requestfailed', (request) =>
    request.url().includes('/v1/quick-compare'),
  );

  await page.route('**/v1/quick-compare', async (route) => {
    markRouteStarted?.();
    await routeReleased;
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: 'd:{"finishReason":"stop"}\n',
    }).catch(() => undefined);
  });

  await openFeatureHub(page);
  await page.getByTestId('quick-compare-prompt').fill('这个请求应该在离开面板时取消');
  await page.getByTestId('quick-compare-start').click();
  await routeStarted;
  await expect(page.getByTestId('quick-compare-start')).toContainText('对比中');
  await page.getByTestId('feature-tab-research').click();

  await expect(requestFailed).resolves.toBeTruthy();
  releaseRoute?.();
});

test('P1 UX: Quick Compare shows orchestration reason before tool traces', async ({ page }) => {
  await clearAllData();
  await seedModels(['QC Orchestration A', 'QC Orchestration B']);

  await page.route('**/v1/quick-compare', async (route) => {
    await fulfillStream(route, [
      '8:[{"type":"qc.meta","compare_id":"qc_orch","conversation_id":"conv_qc_orch","run_id":"run_qc_orch","model_ids":["mdl_a","mdl_b"]}]',
      '8:[{"type":"qc.orchestration","compare_id":"qc_orch","message_id":"msg_qc_orch","conversation_id":"conv_qc_orch","run_id":"run_qc_orch","reason":"high_stakes_current","external_info":"web_search_fetch","local_context":"none","search_tool_name":"builtin.web_search","query_count":2,"fetch_top_k":2,"cite_required":true,"allow_model_tool_use":true}]',
      '8:[{"type":"qc.participant_start","output_id":"qco_1","index":0,"model_id":"mdl_a","provider_id":null,"execution_mode":"live","tool_names":[]}]',
      '8:[{"type":"qc.participant_done","output_id":"qco_1","index":0,"model_id":"mdl_a","content":"候选 A 已结合搜索。","cost_record_id":null,"execution_mode":"live"}]',
      '8:[{"type":"qc.participant_start","output_id":"qco_2","index":1,"model_id":"mdl_b","provider_id":null,"execution_mode":"live","tool_names":[]}]',
      '8:[{"type":"qc.participant_done","output_id":"qco_2","index":1,"model_id":"mdl_b","content":"候选 B 已结合搜索。","cost_record_id":null,"execution_mode":"live"}]',
      '8:[{"type":"qc.tool_trace","output_id":"qco_1","index":0,"model_id":"mdl_a","call_id":"pre_search","tool":"builtin.web_search","label":"预搜索网页","event":"finish","input":"深圳初升高","output":"返回 8 条结果","ok":true}]',
      '8:[{"type":"qc.done","compare_id":"qc_orch","completed_output_ids":["qco_1","qco_2"],"failed_output_ids":[]}]',
      'd:{"finishReason":"stop"}',
    ]);
  });

  await openFeatureHub(page);
  await page.getByTestId('quick-compare-prompt').fill('深圳初升高，模拟考试522分，家住坂田，如果要报名，什么建议？');
  await page.getByTestId('quick-compare-start').click();

  await expect(page.getByTestId('feature-orchestration-notice')).toContainText('涉及报名、政策或高风险时效信息', { timeout: 10_000 });
  await expect(page.getByTestId('feature-orchestration-notice')).toContainText('搜索并预读网页');
  await expect(page.getByTestId('feature-orchestration-notice')).toContainText('要求引用来源');
  await expect(page.getByTestId('quick-compare-tool-traces')).toContainText('预搜索网页');
  await expect(page.getByTestId('quick-compare-output-0')).toContainText('候选 A 已结合搜索');
});

test('P1 journey: roundtable create, round stream, summarize, loopback, and export', async ({ page }) => {
  await clearAllData();
  await seedMockChatModel('P1 Roundtable Base');

  await page.route('**/v1/roundtable', async (route) => {
    await route.fulfill({
      status: 201,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'rt_p1',
        conversation_id: 'conv_rt_p1',
        topic: 'P1 多模型圆桌验证',
        mode: 'fast',
        participants: [
          { model_id: 'mdl_rt_a', display_name: 'Planner', role_label: '产品', persona_prompt: '关注用户价值。' },
          { model_id: 'mdl_rt_b', display_name: 'Engineer', role_label: '工程', persona_prompt: '关注实现风险。' },
        ],
        summarizer_model_id: 'mdl_rt_a',
        analyzer_fallback: true,
        status: 'round1',
        current_round: 0,
        summary: null,
        estimated_cost_usd_low: 0,
        estimated_cost_usd_high: 0,
        created_at: now,
        updated_at: now,
        completed_at: null,
      }),
    });
  });
  await page.route('**/v1/roundtable/rt_p1/round', (route) => fulfillStream(route, [
    '8:[{"type":"rt.meta","roundtable_id":"rt_p1","conversation_id":"conv_rt_p1","round":1}]',
    '8:[{"type":"rt.round_start","round":1,"participants_total":2}]',
    '8:[{"type":"rt.participant_delta","participant_index":0,"model_id":"mdl_rt_a","text_chunk":"先验证核心对话旅程。"}]',
    '8:[{"type":"rt.participant_done","participant_index":0,"model_id":"mdl_rt_a","content":"先验证核心对话旅程。","cost_record_id":"cost_rt_1"}]',
    '8:[{"type":"rt.participant_delta","participant_index":1,"model_id":"mdl_rt_b","text_chunk":"需要覆盖接口失败和恢复。"}]',
    '8:[{"type":"rt.participant_done","participant_index":1,"model_id":"mdl_rt_b","content":"需要覆盖接口失败和恢复。","cost_record_id":"cost_rt_2"}]',
    '8:[{"type":"rt.round_done","round":1,"completed_indices":[0,1],"failed_indices":[]}]',
    'd:{"finishReason":"stop"}',
  ]));
  await page.route('**/v1/roundtable/rt_p1', async (route) => {
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        roundtable: {
          id: 'rt_p1', conversation_id: 'conv_rt_p1', topic: 'P1 多模型圆桌验证', mode: 'fast',
          participants: [
            { model_id: 'mdl_rt_a', display_name: 'Planner', role_label: '产品', persona_prompt: '关注用户价值。' },
            { model_id: 'mdl_rt_b', display_name: 'Engineer', role_label: '工程', persona_prompt: '关注实现风险。' },
          ],
          summarizer_model_id: 'mdl_rt_a', analyzer_fallback: true, status: 'round2', current_round: 1,
          summary: null, estimated_cost_usd_low: 0, estimated_cost_usd_high: 0, created_at: now, updated_at: now, completed_at: null,
        },
        messages: [
          { id: 'rtm_1', roundtable_id: 'rt_p1', round: 1, participant_index: 0, model_id: 'mdl_rt_a', content: '先验证核心对话旅程。', status: 'complete', classification: null, error_message: null, visible_to_others: true, created_at: now, updated_at: now },
          { id: 'rtm_2', roundtable_id: 'rt_p1', round: 1, participant_index: 1, model_id: 'mdl_rt_b', content: '需要覆盖接口失败和恢复。', status: 'complete', classification: null, error_message: null, visible_to_others: true, created_at: now, updated_at: now },
        ],
        total_cost_usd: 0,
      }),
    });
  });
  await page.route('**/v1/roundtable/rt_p1/summarize', (route) => fulfillStream(route, [
    '8:[{"type":"rt.summary_delta","text_chunk":"建议先完成 P1 能力中心，再补真实模型回归。"}]',
    '8:[{"type":"rt.summary_done","summary":{"consensus":["先做核心旅程"],"divergence":[],"risks":["接口漂移"],"recommended_decision":"建议先完成 P1 能力中心，再补真实模型回归。","next_steps":["补 E2E"]},"cost_record_id":"cost_sum"}]',
    'd:{"finishReason":"stop"}',
  ]));
  await page.route('**/v1/roundtable/rt_p1/loopback', async (route) => {
    await route.fulfill({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ conversation_id: 'conv_rt_p1', message_id: 'msg_rt_loop' }) });
  });
  await page.route('**/v1/roundtable/rt_p1/export', async (route) => {
    await route.fulfill({ status: 200, headers: { 'content-type': 'text/markdown' }, body: '# Roundtable Export' });
  });
  await page.route('**/v1/conversations/conv_rt_p1/messages', async (route) => {
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        conversation: { id: 'conv_rt_p1', type: 'chat', title: '圆桌回填', created_at: now, updated_at: now, archived: false, pinned: false, tags: null },
        messages: [{ id: 'msg_rt_loop', conversation_id: 'conv_rt_p1', role: 'assistant', content: '建议先完成 P1 能力中心，再补真实模型回归。', model_id: null, status: 'complete', error: null, created_at: now, attachments_count: 0, annotations: [] }],
      }),
    });
  });
  await page.route('**/v1/conversations/conv_rt_p1/run-events?limit=80', async (route) => {
    await route.fulfill({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: true, data: { events: [] } }) });
  });

  await openFeatureHub(page);
  await page.getByTestId('feature-tab-roundtable').click();
  await page.getByTestId('roundtable-topic').fill('P1 多模型圆桌验证');
  await page.getByTestId('roundtable-create').click();
  await expect(page.getByTestId('roundtable-detail')).toContainText('P1 多模型圆桌验证');
  await expect(page.getByTestId('roundtable-detail')).toContainText('产品 · Planner');

  await page.getByTestId('roundtable-run-round').click();
  await expect(page.getByTestId('roundtable-message-0')).toContainText('核心对话旅程', { timeout: 10_000 });
  await expect(page.getByTestId('roundtable-message-1')).toContainText('接口失败和恢复', { timeout: 10_000 });

  await page.getByTestId('roundtable-summarize').click();
  await expect(page.getByTestId('roundtable-summary')).toContainText('P1 能力中心', { timeout: 10_000 });
  await page.getByTestId('roundtable-export').click();
  await expect(page.locator(".toast").filter({ hasText: '圆桌已导出' })).toBeVisible( { timeout: 10_000 });
  await page.getByTestId('roundtable-loopback').click();
  await expect(page.locator('.msg.ai', { hasText: 'P1 能力中心' })).toBeVisible({ timeout: 10_000 });
});

test('P1 journey: research plan lifecycle covers revise, start, pause, resume, cancel, and export', async ({ page }) => {
  await clearAllData();
  await seedMockChatModel('P1 Research');

  await openFeatureHub(page);
  await page.getByTestId('feature-tab-research').click();
  await page.getByTestId('research-title').fill('P1 WebUI 深度研究验证');
  await page.getByTestId('research-objective').fill('研究 P1 WebUI 在 2026 年的用户旅程、设置中心、工具调用、文件上下文与视觉回归验证方法，给出明确执行建议。');
  await page.getByTestId('research-create').click();

  await expect(page.getByTestId('research-detail')).toContainText('P1 WebUI 深度研究验证', { timeout: 10_000 });
  await expect(page.getByTestId('research-plan')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('research-feedback').fill('补充设置中心和工具调用风险。');
  await page.getByTestId('research-revise').click();
  await expect(page.getByTestId('research-plan')).toContainText(/工具|设置|验证|WebUI/, { timeout: 10_000 });

  await page.getByTestId('research-start').click();
  await expect(page.getByTestId('research-detail')).toContainText('running', { timeout: 10_000 });
  await expect(page.getByTestId('research-detail')).toContainText(/个任务/);
  await page.getByTestId('research-pause').click();
  await expect(page.getByTestId('research-detail')).toContainText('paused', { timeout: 10_000 });
  await page.getByTestId('research-resume').click();
  await expect(page.getByTestId('research-detail')).toContainText('running', { timeout: 10_000 });
  await page.getByTestId('research-export').click();
  await expect(page.locator(".toast").filter({ hasText: '研究已导出' })).toBeVisible( { timeout: 10_000 });
  await page.getByTestId('research-cancel').click();
  await expect(page.getByTestId('research-detail')).toContainText('cancelled', { timeout: 10_000 });
});

test('P1 journey: files search plus tools and MCP management are usable', async ({ page }) => {
  await clearAllData();
  const { modelId } = await seedMockChatModel('P1 File Tool');

  await page.goto('/');
  await page.getByTestId('composer-file-input').setInputFiles({
    name: 'p1-note.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('P1 context note: hawthorn belongs to local file search and should appear in snippets.', 'utf8'),
  });
  await page.getByTestId('composer-textarea').fill('请记住附件里的 hawthorn 信息');
  await page.getByTestId('composer-send').click();
  await expect(page.locator('.msg.ai', { hasText: '[M0 mock]' })).toBeVisible({ timeout: 10_000 });
  const conversations = await sidecarJson<{ conversations: Array<{ id: string }> }>('/v1/conversations');
  const conversationId = conversations.conversations[0]!.id;

  await page.getByTestId('sidebar-features').click();
  await page.getByTestId('feature-tab-files').click();
  await page.getByTestId('file-search-query').fill('hawthorn');
  await page.getByTestId('file-search-run').click();
  await expect(page.getByTestId('file-search-result')).toContainText('hawthorn', { timeout: 10_000 });
  await page.getByTestId('file-search-result').first().click();
  await page.getByTestId('file-data-load').click();
  await expect(page.getByTestId('file-data-preview')).toContainText('text/plain', { timeout: 10_000 });

  await page.getByTestId('feature-tab-tools').click();
  await expect(page.getByTestId('tool-row-builtin.file_search')).toContainText('enabled', { timeout: 10_000 });
  await page.getByText('调试工具调用').click();
  await page.getByTestId('tool-invoke-input').fill('{"query":"hawthorn","limit":2}');
  await page.getByTestId('tool-invoke-builtin.file_search').click();
  await expect(page.getByTestId('tool-invoke-result')).toContainText('hawthorn', { timeout: 10_000 });
  await page.getByTestId('tool-session-toggle-builtin.file_search').click();
  await expect(page.getByTestId('tool-row-builtin.file_search')).toContainText('disabled', { timeout: 10_000 });

  await page.getByTestId('mcp-name').fill('P1 MCP');
  await page.getByTestId('mcp-command').fill('node');
  await page.getByTestId('mcp-create').click();
  await expect(page.locator('[data-testid^="mcp-server-"]')).toContainText('P1 MCP', { timeout: 10_000 });
  const serverRow = page.locator('[data-testid^="mcp-server-"]').filter({ hasText: 'P1 MCP' }).first();
  const serverTestId = await serverRow.getAttribute('data-testid');
  expect(serverTestId).toBeTruthy();
  const serverId = serverTestId!.replace('mcp-server-', '');
  await page.getByTestId(`mcp-runtime-${serverId}`).click();
  await expect(page.getByTestId('tool-invoke-result')).toContainText('session_running', { timeout: 10_000 });
  await page.getByTestId(`mcp-refresh-${serverId}`).click();
  await page.getByTestId(`mcp-delete-${serverId}`).click();
  await expect(page.locator('[data-testid^="mcp-server-"]').filter({ hasText: 'P1 MCP' })).toHaveCount(0, { timeout: 10_000 });

  await expect.poll(async () => {
    const models = await sidecarJson<{ models: Array<{ id: string }> }>('/v1/models');
    return models.models.some((model) => model.id === modelId);
  }).toBe(true);
  await expect.poll(async () => {
    const data = await sidecarJson<{ ok: true; data: Array<{ name: string; session_enabled: boolean | null; effective_enabled: boolean }> }>(`/v1/tools/effective?conversation_id=${conversationId}`);
    return data.data.find((tool) => tool.name === 'builtin.file_search');
  }).toMatchObject({ session_enabled: false, effective_enabled: false });
});

test('P1 visual: feature hub key states on desktop and mobile', async ({ page }) => {
  await clearAllData();
  await seedModels(['P1 Visual A', 'P1 Visual B', 'P1 Visual C']);

  await openFeatureHub(page);
  await page.getByTestId('quick-compare-prompt').fill('视觉验证：对比三种用户旅程覆盖方案');
  await page.getByTestId('quick-compare-start').click();
  await expect(page.getByTestId('quick-compare-output-0')).toContainText('Quick Compare 本地预览', { timeout: 10_000 });
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: path.join(screenshotsDir, '17-p1-quick-compare.png'), fullPage: true });

  await page.getByTestId('feature-tab-research').click();
  await page.getByTestId('research-objective').fill('研究能力中心视觉回归、移动端可用性和工具面板状态，输出测试计划。这个目标足够明确，可以直接生成计划。');
  await page.getByTestId('research-create').click();
  await expect(page.getByTestId('research-plan')).toBeVisible({ timeout: 10_000 });
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: path.join(screenshotsDir, '18-p1-research.png'), fullPage: true });

  await page.getByTestId('feature-tab-tools').click();
  await expect(page.getByTestId('tool-row-builtin.web_fetch')).toBeVisible({ timeout: 10_000 });
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: path.join(screenshotsDir, '19-p1-tools.png'), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  await expectMobileSidebarIsIconRail(page);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: path.join(screenshotsDir, '20-p1-tools-mobile.png'), fullPage: true });
});

test('P1 mobile journey: history drawer restores previous conversations without cramped sidebar text', async ({ page }) => {
  await clearAllData();
  await seedMockChatModel('P1 Mobile History');

  await page.goto('/');
  await page.getByTestId('composer-textarea').fill('移动端历史对话 A');
  await page.getByTestId('composer-send').click();
  await expect(page.locator('.msg.ai', { hasText: '[M0 mock]' })).toBeVisible({ timeout: 10_000 });

  await page.getByRole('button', { name: /新对话/ }).first().click();
  await page.getByTestId('composer-textarea').fill('移动端历史对话 B');
  await page.getByTestId('composer-send').click();
  await expect(page.locator('.msg.user', { hasText: '移动端历史对话 B' })).toBeVisible({ timeout: 10_000 });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  await expectMobileSidebarIsIconRail(page);

  await page.getByTestId('mobile-history-open').click();
  await expect(page.getByTestId('mobile-history-drawer')).toBeVisible();
  await expect(page.getByTestId('mobile-history-drawer')).toContainText('移动端历史对话 A', { timeout: 10_000 });
  await page.getByTestId('mobile-history-drawer').locator('.chat-row', { hasText: '移动端历史对话 A' }).click();
  await expect(page.locator('.msg.user', { hasText: '移动端历史对话 A' })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('mobile-history-drawer')).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
});
