import { test, expect } from '@playwright/test';
import { authedFetch, readSidecarEnv, resetSidecar, seedDefaultModel } from './_helpers';

test.beforeEach(async () => {
  const env = readSidecarEnv();
  await resetSidecar(env);
  await seedDefaultModel(env);
});

test('research center supports chatlike plan preview, lifecycle, and export', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 760 });

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 15_000 });

  await page.getByTestId('composer-input').fill(
    '梳理 2026 年 AI Coding 产品的定位、价格、速度与风险差异。',
  );
  await page.getByTestId('composer-deep-research').click();
  await expect(page.getByTestId('research-center')).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 440 });
  const canScrollHome = await page.getByTestId('research-center').evaluate((node) => {
    const el = node as HTMLElement;
    el.scrollTop = 0;
    const before = el.scrollTop;
    el.scrollTop = el.scrollHeight;
    return el.scrollTop > before;
  });
  expect(canScrollHome).toBe(true);
  await page.setViewportSize({ width: 1440, height: 760 });

  // Goal is carried from main composer into the research input
  await expect(page.getByTestId('research-input-objective')).toHaveValue(
    '梳理 2026 年 AI Coding 产品的定位、价格、速度与风险差异。',
  );
  const inputHasBorder = await page.locator('.research-center__composer-input-shell').first().evaluate((node) => {
    const style = getComputedStyle(node as HTMLElement);
    return style.borderTopWidth !== '0px' && style.borderTopStyle !== 'none';
  });
  expect(inputHasBorder).toBe(true);

  // Open advanced options and configure
  await page.locator('.research-center__advanced-opts summary').click();
  await page.getByTestId('research-input-output-kind').selectOption('comparison');
  await page.getByTestId('research-input-budget-mode').selectOption('deep');
  await page.getByTestId('research-input-budget-limit').fill('15');
  await page.getByTestId('research-input-min-citations').fill('6');
  await page.getByTestId('research-input-time-range').fill('近 12 个月');
  await page.getByTestId('research-input-region').fill('全球');
  await page.getByTestId('research-input-language').fill('中文 + 英文');
  await page.getByTestId('research-input-must-cover').fill('价格, 速度, 风险');

  // First generate a plan preview instead of starting the run immediately
  await page.getByTestId('research-quick-start').click();

  await expect(page.getByTestId('research-thread')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('research-user-message')).toContainText(
    '梳理 2026 年 AI Coding 产品的定位、价格、速度与风险差异。',
  );
  await expect(page.getByTestId('research-plan-preview')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('research-center')).toContainText('待确认');
  await expect(page.getByTestId('research-action-confirm')).toBeVisible();
  await expect(page.getByTestId(/sidebar-research-row-rs_/).first()).toBeVisible();
  const previewBox = await page.getByTestId('research-plan-preview').boundingBox();
  const dockBox = await page.getByTestId('research-followup-dock').boundingBox();
  expect(Boolean(previewBox && dockBox && dockBox.y >= previewBox.y + previewBox.height - 1)).toBe(true);

  await page.getByTestId('research-action-confirm').click();

  await expect(page.getByTestId('research-thread')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('research-reading-pane')).toBeVisible();
  await expect(page.getByTestId('research-evidence-panel')).toBeVisible();
  await expect(page.getByTestId('research-followup-dock')).toBeVisible();
  await expect(page.getByTestId('research-task-list')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('research-center')).toContainText(/进行中|已完成/);
  await expect(page.getByTestId('research-draft')).not.toContainText('（尚未生成草稿）');

  const canPause = await page.getByTestId('research-action-pause').isVisible().catch(() => false);
  if (canPause) {
    await page.getByTestId('research-action-pause').click();
    await expect(page.getByTestId('research-center')).toContainText('已暂停');
    await expect(page.getByTestId('research-action-resume')).toBeEnabled();

    await page.getByTestId('research-action-resume').click();
    await expect(page.getByTestId('research-center')).toContainText(/进行中|已完成/);
  } else {
    await expect(page.getByTestId('research-center')).toContainText('已完成');
  }

  const [markdownDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('research-action-export-markdown').click(),
  ]);
  expect(markdownDownload.suggestedFilename()).toMatch(/^taori-research-.+\.md$/);

  const [jsonDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('research-action-export-json').click(),
  ]);
  expect(jsonDownload.suggestedFilename()).toMatch(/^taori-research-.+\.json$/);

  const canCancel = await page.getByTestId('research-action-cancel').isVisible().catch(() => false);
  if (canCancel) {
    await page.getByTestId('research-action-cancel').click();
    await expect(page.getByTestId('research-center')).toContainText('已取消');
  }
});

test('research center keeps market-analysis runs readable and collects evidence for the user scenario', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const env = readSidecarEnv();
  for (const [key, value] of [
    ['builtin_web_search_engine', 'bocha'],
    ['builtin_web_search_bocha_api_key', 'invalid-key-for-ui-check'],
  ] as const) {
    await authedFetch(env, '/v1/memories', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scope: 'global',
        scope_id: null,
        key,
        value,
      }),
    });
  }

  await page.setViewportSize({ width: 1440, height: 860 });
  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 15_000 });

  await page.getByTestId('composer-input').fill('分析 2026 年 AI Coding 市场格局与主要玩家差异');
  await page.getByTestId('composer-deep-research').click();
  await expect(page.getByTestId('research-center')).toBeVisible();
  await page.getByTestId('research-quick-start').click();
  await expect(page.getByTestId('research-action-confirm')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('research-action-confirm').click();

  await expect(page.getByTestId('research-task-list')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('research-task-list')).not.toContainText('web_search returned no usable results', {
    timeout: 60_000,
  });
  await expect(page.getByTestId('research-task-list')).not.toContainText('DuckDuckGo blocked the automated search', {
    timeout: 60_000,
  });
  await expect(page.getByTestId('research-task-list')).not.toContainText('Invalid API KEY', {
    timeout: 60_000,
  });
  await expect(page.getByTestId('research-source-list').locator('li').first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('research-reading-pane')).toBeVisible({ timeout: 60_000 });
  // Draft is now rendered as HTML — check for content rather than raw markdown syntax
  await expect(page.getByTestId('research-draft')).toContainText('证据');
});
