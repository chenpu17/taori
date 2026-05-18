import { test, expect } from '@playwright/test';
import { readSidecarEnv, resetSidecar, authedFetch } from './_helpers';

/**
 * M3.A.5 — Roundtable main panel.
 *
 * Without a working upstream, every participant call fails (the seeded
 * provider points at api.openai.invalid). The renderer must still:
 *   1. Mount the panel after launch + display N participant columns.
 *   2. After clicking "开始第 1 轮", show failure cells with retry buttons.
 *   3. Restore the panel on page reload (spec §5.3).
 *   4. Persist a cancel via POST /v1/roundtable/:id/cancel.
 */

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

test('M3.A.5 round 1 all-failed → failure cells render with retry buttons', async ({
  page,
}) => {
  await page.route('**/api.openai.invalid/**', (route) => route.abort());

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  // Launch dialog → analyzer fallback → continue.
  await page.getByTestId('composer-input').fill('需要选 ORM 框架');
  await page.getByTestId('composer-tools-toggle').click();
  await expect(page.getByTestId('composer-roundtable')).toBeVisible();
  await page.getByTestId('composer-roundtable').click();
  const dlg = page.getByTestId('roundtable-launch-dialog');
  await expect(dlg).toBeVisible();
  await dlg.getByTestId('roundtable-launch-start').click();
  await expect(dlg.getByTestId('roundtable-preview')).toBeVisible({
    timeout: 15_000,
  });
  await dlg.getByTestId('roundtable-launch-continue').click();
  await expect(dlg).toBeHidden();

  // Panel mounts.
  const panel = page.getByTestId('roundtable-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('roundtable-grid').locator('.roundtable-column')).toHaveCount(3);

  // Start round 1.
  await panel.getByTestId('roundtable-action-start-round').click();

  // All three participant cells reach failed state.
  for (let i = 0; i < 3; i++) {
    await expect(
      panel.getByTestId(`roundtable-cell-error-${i}-1`),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      panel.getByTestId(`roundtable-retry-${i}-1`),
    ).toBeVisible();
  }
});

test('M3.A.5 panel restores on page reload (state restoration §5.3)', async ({
  page,
}) => {
  await page.route('**/api.openai.invalid/**', (route) => route.abort());

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  await page.getByTestId('composer-input').fill('需要选 ORM 框架');
  await page.getByTestId('composer-tools-toggle').click();
  await expect(page.getByTestId('composer-roundtable')).toBeVisible();
  await page.getByTestId('composer-roundtable').click();
  const dlg = page.getByTestId('roundtable-launch-dialog');
  await dlg.getByTestId('roundtable-launch-start').click();
  await expect(dlg.getByTestId('roundtable-preview')).toBeVisible({
    timeout: 15_000,
  });
  await dlg.getByTestId('roundtable-launch-continue').click();
  await expect(page.getByTestId('roundtable-panel')).toBeVisible();

  // Reload — conversations are persisted server-side; sidebar lists them.
  // The user clicks the conversation, and the panel must restore.
  await page.reload();
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  // Sidebar shows the roundtable conversation. Click to activate.
  const items = page.getByTestId('conv-item');
  await expect(items.first()).toBeVisible({ timeout: 10_000 });
  await items.first().click();
  await expect(page.getByTestId('roundtable-panel')).toBeVisible({
    timeout: 10_000,
  });
});

test('M3.A.5 cost label visible in panel header', async ({ page }) => {
  await page.route('**/api.openai.invalid/**', (route) => route.abort());

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  await page.getByTestId('composer-input').fill('需要选 ORM 框架');
  await page.getByTestId('composer-tools-toggle').click();
  await expect(page.getByTestId('composer-roundtable')).toBeVisible();
  await page.getByTestId('composer-roundtable').click();
  const dlg = page.getByTestId('roundtable-launch-dialog');
  await dlg.getByTestId('roundtable-launch-start').click();
  await expect(dlg.getByTestId('roundtable-preview')).toBeVisible({
    timeout: 15_000,
  });
  await dlg.getByTestId('roundtable-launch-continue').click();

  const panel = page.getByTestId('roundtable-panel');
  await expect(panel).toBeVisible();
  const cost = panel.getByTestId('roundtable-total-cost');
  await expect(cost).toBeVisible();
  await expect(cost).toContainText('$');
});

test('M3.A.5 completed summary shows save-template and history compare', async ({ page }) => {
  const now = Date.now();
  const participants = [
    {
      model_id: 'model_a',
      display_name: 'Chat 0',
      role_label: '综合视角',
      persona_prompt: '你从综合视角参与圆桌讨论。',
    },
    {
      model_id: 'model_b',
      display_name: 'Chat 1',
      role_label: '批判视角',
      persona_prompt: '你从批判视角参与圆桌讨论。',
    },
  ];
  const summary = {
    consensus: ['先在小范围验证'],
    divergence: [{ topic: '是否立即全量上线', positions: [{ role: '综合视角', stance: '否' }] }],
    risks: ['迁移风险'],
    recommended_decision: '先灰度再全量',
    next_steps: ['搭建灰度环境'],
  };

  await page.route('**/v1/roundtable/rt_history/template', async (route) => {
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        template: {
          id: 'prompt_rt_history',
          name: '圆桌模板：需要选 ORM 框架',
          description: '由圆桌结论生成',
          content: '请围绕新的决策问题“{{决策问题}}”输出...',
          created_at: now,
          updated_at: now,
        },
      }),
    });
  });
  await page.route('**/v1/roundtable/rt_history/loopback', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        conversation_id: 'conv_origin',
        message_id: 'msg_loopback',
      }),
    });
  });
  await page.route('**/v1/roundtable/rt_history/history?*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        roundtable_id: 'rt_history',
        items: [{
          id: 'rt_old',
          topic: '旧决策',
          mode: 'fast',
          created_at: now - 86_400_000,
          recommended_decision: '先保守推进',
          consensus: ['先验证'],
          risks: ['组织学习成本'],
          divergence_topics: ['是否立即切换'],
        }],
      }),
    });
  });
  await page.route('**/v1/roundtable/rt_history', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        roundtable: {
          id: 'rt_history',
          conversation_id: 'conv_history',
          topic: '需要选 ORM 框架',
          mode: 'fast',
          participants,
          summarizer_model_id: 'model_a',
          analyzer_fallback: false,
          status: 'completed',
          current_round: 1,
          summary,
          estimated_cost_usd_low: 0.01,
          estimated_cost_usd_high: 0.02,
          created_at: now,
          updated_at: now,
          completed_at: now,
        },
        messages: [],
        total_cost_usd: 0.0123,
      }),
    });
  });
  await page.route('**/v1/roundtable', async (route) => {
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'rt_history',
        conversation_id: 'conv_history',
        topic: '需要选 ORM 框架',
        mode: 'fast',
        participants,
        summarizer_model_id: 'model_a',
        analyzer_fallback: false,
        status: 'completed',
        current_round: 1,
        estimated_cost_usd_low: 0.01,
        estimated_cost_usd_high: 0.02,
        created_at: now,
        preview: {
          topic_type: 'technical',
          complexity: 'medium',
          requested_mode: 'auto',
          analyzer_chose_mode_reason: '这是一个需要结构化判断的技术选型问题。',
          estimated_calls: 4,
          estimated_duration_sec_low: 8,
          estimated_duration_sec_high: 16,
          alt_mode: 'deep',
          alt_estimated_cost_usd_low: 0.02,
          alt_estimated_cost_usd_high: 0.04,
          alt_estimated_calls: 6,
          alt_estimated_duration_sec_low: 16,
          alt_estimated_duration_sec_high: 32,
        },
      }),
    });
  });

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('composer-input').fill('需要选 ORM 框架');
  await page.getByTestId('composer-tools-toggle').click();
  await expect(page.getByTestId('composer-roundtable')).toBeVisible();
  await page.getByTestId('composer-roundtable').click();
  const dlg = page.getByTestId('roundtable-launch-dialog');
  await dlg.getByTestId('roundtable-launch-start').click();
  await expect(dlg.getByTestId('roundtable-preview')).toBeVisible({ timeout: 15_000 });
  await dlg.getByTestId('roundtable-launch-continue').click();

  const panel = page.getByTestId('roundtable-panel');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('roundtable-history-compare')).toContainText('旧决策');
  await page.getByTestId('roundtable-save-template').click();
  await expect(page.getByTestId('roundtable-save-template-ok')).toContainText('圆桌模板');
});

test('M3.A.5 deep round content stays scrollable and summary JSON is hidden', async ({
  page,
}) => {
  const now = Date.now();
  const participants = [
    {
      model_id: 'model_a',
      display_name: 'Doubao 1.5 Pro 32K',
      role_label: '儒家新辩者',
      persona_prompt: '你从儒家视角参与圆桌讨论，给出结构化判断。',
    },
    {
      model_id: 'model_b',
      display_name: 'Doubao Seed',
      role_label: '道家新辩者',
      persona_prompt: '你从道家视角参与圆桌讨论，给出结构化判断。',
    },
    {
      model_id: 'model_c',
      display_name: 'Chat 2',
      role_label: '现实主义者',
      persona_prompt: '你从现实主义视角参与圆桌讨论，给出结构化判断。',
    },
  ];
  const longSpeech = Array.from({ length: 28 }, (_, i) =>
    `第 ${i + 1} 点：这是一段足够长的圆桌发言，用来验证第一轮内容不会把第二轮挤出不可滚动区域。`,
  ).join('\n');
  const baseRoundtable = {
    id: 'rt_scroll',
    conversation_id: 'conv_scroll',
    topic: '孔子和老子的贡献谁更大',
    mode: 'deep',
    participants,
    summarizer_model_id: 'model_a',
    analyzer_fallback: false,
    status: 'round2',
    current_round: 2,
    summary: null,
    estimated_cost_usd_low: 0.01,
    estimated_cost_usd_high: 0.02,
    created_at: now,
    updated_at: now,
    completed_at: null,
  };
  const messages = participants.flatMap((_, participantIndex) => [
    {
      id: `msg_${participantIndex}_1`,
      roundtable_id: 'rt_scroll',
      round: 1,
      participant_index: participantIndex,
      model_id: participants[participantIndex]!.model_id,
      content: longSpeech,
      status: 'complete',
      classification: null,
      error_message: null,
      visible_to_others: true,
      created_at: now,
      updated_at: now,
    },
    {
      id: `msg_${participantIndex}_2`,
      roundtable_id: 'rt_scroll',
      round: 2,
      participant_index: participantIndex,
      model_id: participants[participantIndex]!.model_id,
      content: `第二轮观点 ${participantIndex + 1}：这里应该可以直接看到或滚动看到。`,
      status: 'complete',
      classification: null,
      error_message: null,
      visible_to_others: true,
      created_at: now,
      updated_at: now,
    },
  ]);

  await page.route('**/v1/roundtable/rt_scroll/summarize', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/plain; charset=utf-8',
      headers: { 'x-vercel-ai-data-stream': 'v1' },
      body:
        '8:[{"type":"rt.summary_delta","text_chunk":"{\\"consensus\\":[\\"raw json should not be visible\\"],\\"divergence\\":["}]\n',
    });
  });
  await page.route('**/v1/roundtable/rt_scroll', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        roundtable: baseRoundtable,
        messages,
        total_cost_usd: 0.0123,
      }),
    });
  });
  await page.route('**/v1/roundtable', async (route) => {
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        ...baseRoundtable,
        preview: {
          topic_type: 'research',
          complexity: 'medium',
          requested_mode: 'deep',
          analyzer_chose_mode_reason: '用户选择深度模式，需要两轮讨论。',
          estimated_calls: 8,
          estimated_duration_sec_low: 20,
          estimated_duration_sec_high: 40,
          alt_mode: 'fast',
          alt_estimated_cost_usd_low: 0.005,
          alt_estimated_cost_usd_high: 0.01,
          alt_estimated_calls: 5,
          alt_estimated_duration_sec_low: 10,
          alt_estimated_duration_sec_high: 20,
        },
      }),
    });
  });

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('composer-input').fill('孔子和老子的贡献谁更大');
  await page.getByTestId('composer-tools-toggle').click();
  await expect(page.getByTestId('composer-roundtable')).toBeVisible();
  await page.getByTestId('composer-roundtable').click();

  const dlg = page.getByTestId('roundtable-launch-dialog');
  await dlg.getByTestId('roundtable-mode-select').selectOption('deep');
  await dlg.getByTestId('roundtable-launch-start').click();
  await expect(dlg.getByTestId('roundtable-preview')).toBeVisible();
  await dlg.getByTestId('roundtable-launch-continue').click();

  const panel = page.getByTestId('roundtable-panel');
  await expect(panel.getByTestId('roundtable-cell-0-2')).toContainText(
    '第二轮观点 1',
  );

  const round1Body = panel.getByTestId('roundtable-cell-body-0-1');
  await expect(round1Body).toBeVisible();
  await expect
    .poll(async () =>
      round1Body.evaluate((el) => el.scrollHeight > el.clientHeight),
    )
    .toBe(true);

  await panel.getByTestId('roundtable-action-summarize').click();
  const streaming = panel.getByTestId('roundtable-summary-streaming');
  await expect(streaming).toBeVisible();
  await expect(streaming).toContainText('正在整理圆桌结论');
  await expect(streaming).not.toContainText('raw json should not be visible');
  await expect(streaming).not.toContainText('consensus');
});

test('M3.A.5 completed summary remains reachable when content is long', async ({
  page,
}) => {
  const now = Date.now();
  const participants = [
    {
      model_id: 'model_a',
      display_name: 'Doubao 1.5 Pro 32K',
      role_label: '儒家新辩者',
      persona_prompt: '你从儒家视角参与圆桌讨论，给出结构化判断。',
    },
    {
      model_id: 'model_b',
      display_name: 'Doubao Seed',
      role_label: '道家新辩者',
      persona_prompt: '你从道家视角参与圆桌讨论，给出结构化判断。',
    },
    {
      model_id: 'model_c',
      display_name: 'Chat 2',
      role_label: '现实主义者',
      persona_prompt: '你从现实主义视角参与圆桌讨论，给出结构化判断。',
    },
  ];
  const summary = {
    consensus: Array.from({ length: 8 }, (_, i) =>
      `共识 ${i + 1}：孔子与老子都在中国思想史中有不可替代的影响。`,
    ),
    divergence: Array.from({ length: 10 }, (_, i) => ({
      topic: `分歧 ${i + 1}：贡献评价维度`,
      positions: [
        {
          role: '儒家新辩者',
          stance: '孔子在制度、教育、伦理秩序上影响更广。',
        },
        {
          role: '道家新辩者',
          stance: '老子在精神超越和思想弹性上提供更深的路径。',
        },
      ],
    })),
    risks: Array.from({ length: 6 }, (_, i) =>
      `风险 ${i + 1}：用单一尺度衡量思想贡献会压扁历史语境。`,
    ),
    recommended_decision:
      '不要简单判定谁绝对更大，应按文化制度影响与哲学精神影响分维度陈述。',
    next_steps: Array.from({ length: 8 }, (_, i) =>
      `下一步 ${i + 1}：把论证拆成教育、政治伦理、个人修养、哲学本体四个维度。`,
    ),
  };
  const completedRoundtable = {
    id: 'rt_summary_scroll',
    conversation_id: 'conv_summary_scroll',
    topic: '孔子和老子的贡献谁更大',
    mode: 'deep',
    participants,
    summarizer_model_id: 'model_a',
    analyzer_fallback: false,
    status: 'completed',
    current_round: 2,
    summary,
    estimated_cost_usd_low: 0.01,
    estimated_cost_usd_high: 0.02,
    created_at: now,
    updated_at: now,
    completed_at: now,
  };

  await page.route('**/v1/roundtable/rt_summary_scroll', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        roundtable: completedRoundtable,
        messages: [],
        total_cost_usd: 0.0456,
      }),
    });
  });
  await page.route('**/v1/roundtable', async (route) => {
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        ...completedRoundtable,
        preview: {
          topic_type: 'research',
          complexity: 'medium',
          requested_mode: 'deep',
          analyzer_chose_mode_reason: '用户选择深度模式，需要两轮讨论。',
          estimated_calls: 8,
          estimated_duration_sec_low: 20,
          estimated_duration_sec_high: 40,
          alt_mode: 'fast',
          alt_estimated_cost_usd_low: 0.005,
          alt_estimated_cost_usd_high: 0.01,
          alt_estimated_calls: 5,
          alt_estimated_duration_sec_low: 10,
          alt_estimated_duration_sec_high: 20,
        },
      }),
    });
  });

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('composer-input').fill('孔子和老子的贡献谁更大');
  await page.getByTestId('composer-tools-toggle').click();
  await expect(page.getByTestId('composer-roundtable')).toBeVisible();
  await page.getByTestId('composer-roundtable').click();

  const dlg = page.getByTestId('roundtable-launch-dialog');
  await dlg.getByTestId('roundtable-mode-select').selectOption('deep');
  await dlg.getByTestId('roundtable-launch-start').click();
  await expect(dlg.getByTestId('roundtable-preview')).toBeVisible();
  await dlg.getByTestId('roundtable-launch-continue').click();

  const panel = page.getByTestId('roundtable-panel');
  await expect(panel.getByTestId('roundtable-summary')).toBeVisible();
  await expect
    .poll(async () => panel.evaluate((el) => el.scrollHeight > el.clientHeight))
    .toBe(true);

  await panel.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(panel.getByTestId('roundtable-loopback')).toBeInViewport();
  await expect(panel.getByText('总成本：$0.0456')).toBeInViewport();
});
