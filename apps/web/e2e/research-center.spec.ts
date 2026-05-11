import { test, expect } from '@playwright/test';
import { readSidecarEnv, resetSidecar, seedDefaultModel } from './_helpers';

test.beforeEach(async () => {
  const env = readSidecarEnv();
  await resetSidecar(env);
  await seedDefaultModel(env);
});

test('research center supports quick start, lifecycle actions, and export', async ({
  page,
}) => {
  test.setTimeout(60_000);

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 15_000 });

  await page.getByTestId('workspace-tab-research').click();
  await expect(page.getByTestId('research-center')).toBeVisible();

  // Fill goal — title auto-derived from this text
  await page.getByTestId('research-input-objective').fill(
    '梳理 2026 年 AI Coding 产品的定位、价格、速度与风险差异。',
  );

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

  // One-click start: creates session, generates plan, and confirms in one shot
  await page.getByTestId('research-quick-start').click();

  // Should go directly to running state
  await expect(page.getByTestId('research-session-list')).toBeVisible();
  await expect(page.getByTestId('research-task-list')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('research-center')).toContainText('进行中');
  await expect(page.getByTestId('research-draft')).not.toContainText('（尚未生成草稿）');

  await page.getByTestId('research-action-pause').click();
  await expect(page.getByTestId('research-center')).toContainText('已暂停');
  await expect(page.getByTestId('research-action-resume')).toBeEnabled();

  await page.getByTestId('research-action-resume').click();
  await expect(page.getByTestId('research-center')).toContainText('进行中');

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

  await page.getByTestId('research-action-cancel').click();
  await expect(page.getByTestId('research-center')).toContainText('已取消');
});
