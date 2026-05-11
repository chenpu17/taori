import { test, expect } from '@playwright/test';
import {
  authedFetch,
  readSidecarEnv,
  resetSidecar,
  type SidecarEnv,
} from './_helpers';

let env: SidecarEnv;

test.beforeAll(() => {
  env = readSidecarEnv();
});

async function seedDefaultChatModel(): Promise<void> {
  const providerRes = await authedFetch(env, '/v1/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Template Market Mock',
      type: 'openai',
      base_url: 'http://127.0.0.1:18999/v1',
      api_key: 'sk-test',
    }),
  });
  expect(providerRes.ok).toBeTruthy();
  const provider = (await providerRes.json()) as { id: string };
  const modelRes = await authedFetch(env, '/v1/models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider_id: provider.id,
      model_name: 'template-market-chat',
      display_name: 'Template Market Chat',
      capability: 'chat',
      is_default_for: 'chat',
      price_input_per_1m: 0.4,
      price_output_per_1m: 1.2,
      supports_tools: true,
    }),
  });
  expect(modelRes.ok).toBeTruthy();
}

test('P3 模板市场支持搜索、预览和一键套用本地 Recipe', async ({ page }) => {
  await resetSidecar(env);
  await seedDefaultChatModel();

  const templateRes = await authedFetch(env, '/v1/prompt-templates', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: '会议纪要快写',
      description: '把讨论快速整理为纪要骨架',
      content: '请把以下讨论整理成会议纪要：背景、关键结论、负责人、下一步。',
    }),
  });
  expect(templateRes.ok).toBeTruthy();

  const recipeRes = await authedFetch(env, '/v1/workflow-recipes', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: '竞品对比清单',
      description: '按统一维度生成竞品对比提纲',
      enabled: true,
      spec: {
        schema_version: 1,
        name: '竞品对比清单',
        description: '按统一维度生成竞品对比提纲',
        prompt_template: '请围绕 {{product}} 输出一份竞品对比清单：包含定位、差异、风险和建议。',
        variables: [{ name: 'product', label: '产品', required: true }],
        recommended_task: 'cheap',
        model_strategy: 'prefer_cheap',
        persona: { mode: 'none' },
        tools: { required: [], optional: ['builtin.web_fetch'] },
        output_format: { kind: 'markdown', sections: ['定位', '差异', '风险', '建议'] },
        budget: { mode: 'soft_cap', max_estimated_usd: 0.2 },
        metadata: {},
      },
    }),
  });
  expect(recipeRes.ok).toBeTruthy();

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  await page.getByTestId('open-template-picker').click();
  await expect(page.getByTestId('template-picker-overlay')).toBeVisible();
  await expect(page.getByTestId('template-market-preview')).toContainText('网页调研报告');

  await page.getByTestId('template-market-search').fill('竞品');
  await expect(page.getByTestId('template-market-preview')).toContainText('竞品对比清单');
  await expect(page.getByTestId('template-market-preview')).toContainText('预算敏感');
  await expect(page.getByTestId('template-market-preview')).toContainText('优先低成本');

  await page.getByTestId('template-market-apply').click();
  await expect(page.getByTestId('template-vars-overlay')).toBeVisible();
  await page.getByTestId('template-var-input-product').fill('Taori');
  await page.getByTestId('template-vars-apply').click();
  await expect(page.getByTestId('composer-input')).toHaveValue(
    '请围绕 Taori 输出一份竞品对比清单：包含定位、差异、风险和建议。',
  );
});
