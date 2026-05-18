import { test, expect } from '@playwright/test';
import { authedFetch, readSidecarEnv, resetSidecar, type SidecarEnv } from './_helpers';
import { startMockOpenAI } from './_mock-openai-server';

const MOCK_PORT = 17941;
const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}/v1`;

const LONG_QUOTE = [
  '这是一个很长的引用，用来模拟模型在回答里贴入用户原始需求、网页摘录或会议纪要；它需要包含足够多的信息密度，才能触发默认折叠逻辑。',
  '引用内容需要默认折叠，否则会把真正的回答结论挤到屏幕之外，让用户第一眼看不到模型给出的判断、建议和后续行动。',
  '用户应该可以明确看到还有更多内容，并用一个轻量按钮展开；按钮不能和代码复制按钮互相影响，也不能破坏消息气泡的整体布局。',
  '展开之后，引用仍然应该保持左侧强调线、柔和背景和正常阅读宽度，同时不应该影响 Mermaid、KaTeX 或代码块等其他 Markdown 增强能力。',
  '这段文本故意超过折叠阈值，确保回归测试能覆盖长引用的折叠逻辑，并防止未来样式拆分或组件拆分时悄悄失效。',
].join('\n');

const MARKDOWN_REPLY = [
  '## Markdown 回归样例',
  '',
  '这里有行内公式 $a+b=c$，以及块级公式：',
  '',
  '$$E=mc^2$$',
  '',
  '```ts',
  'const product = "Taori";',
  'console.log(product);',
  '```',
  '',
  '```mermaid',
  'flowchart TD',
  '  A[User] --> B[Taori]',
  '```',
  '',
  `<blockquote>${LONG_QUOTE}</blockquote>`,
].join('\n');

let server: ReturnType<typeof startMockOpenAI> | null = null;
let env: SidecarEnv;

test.beforeAll(() => {
  server = startMockOpenAI(MOCK_PORT, {
    fixedReply: MARKDOWN_REPLY,
    streamDelayMs: 120,
  });
  env = readSidecarEnv();
});

test.afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
});

test.beforeEach(async ({ context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await resetSidecar(env);
  await seedMarkdownModels(env);
});

test('assistant Markdown renders code, Mermaid, KaTeX and collapsible quotes', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 15_000 });

  await page.getByTestId('composer-input').fill('请返回 Markdown 回归样例');
  await page.getByTestId('composer-send').click();

  const assistant = page.locator('.msg.assistant').last();
  await expect(assistant).toContainText('Markdown 回归样例', { timeout: 20_000 });

  const codeBlock = assistant.locator('[data-code-block="true"][data-language="ts"]');
  await expect(codeBlock).toBeVisible();
  await expect(codeBlock.locator('.markdown-code-block__lang')).toHaveText('ts');
  const copyButton = codeBlock.locator('.markdown-code-block__copy');
  await copyButton.click();
  await expect(copyButton).toHaveText('已复制');

  await expect(assistant.locator('[data-mermaid-output="true"] svg')).toBeVisible({
    timeout: 20_000,
  });
  await expect(assistant.locator('.katex').first()).toBeVisible({ timeout: 10_000 });

  const quote = assistant.locator('blockquote[data-collapsible-quote="true"]').first();
  await expect(quote).toHaveAttribute('data-quote-expanded', 'false');
  const quoteToggle = assistant.locator('button[data-quote-toggle]').first();
  await expect(quoteToggle).toHaveText('展开引用');
  await quoteToggle.click();
  await expect(quote).toHaveAttribute('data-quote-expanded', 'true');
  await expect(quoteToggle).toHaveText('收起引用');
});

test('Quick Compare Markdown copy button keeps compact width', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 15_000 });

  await page.getByTestId('composer-input').fill('请对比 Markdown 回归样例');
  await page.getByTestId('composer-tools-toggle').click();
  await expect(page.getByTestId('composer-quick-compare')).toBeVisible();
  await page.getByTestId('composer-quick-compare').click();
  await expect(page.getByTestId('quick-compare-picker')).toBeVisible();
  await page.getByTestId('quick-compare-picker-submit').click();

  const output = page.getByTestId('quick-compare-output').first();
  await expect(output).toContainText('Markdown 回归样例', { timeout: 20_000 });
  const copyButton = output.locator('.markdown-code-block__copy').first();
  await expect(copyButton).toBeVisible();

  const outputBox = await output.boundingBox();
  const buttonBox = await copyButton.boundingBox();
  expect(outputBox).not.toBeNull();
  expect(buttonBox).not.toBeNull();
  expect(buttonBox!.width).toBeLessThan(outputBox!.width * 0.5);
});

test('Quick Compare streams candidate output before all models finish', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 15_000 });

  await page.getByTestId('composer-input').fill('请实时对比 Markdown 回归样例');
  await page.getByTestId('composer-tools-toggle').click();
  await expect(page.getByTestId('composer-quick-compare')).toBeVisible();
  await page.getByTestId('composer-quick-compare').click();
  await expect(page.getByTestId('quick-compare-picker')).toBeVisible();
  await page.getByTestId('quick-compare-picker-submit').click();

  const runningOutput = page.locator('.quick-compare-output.quick-compare-streaming').first();
  await expect(runningOutput).toBeVisible({ timeout: 10_000 });
  await expect(runningOutput).toContainText('Markdown', { timeout: 10_000 });
  await expect(runningOutput.locator('header')).toContainText('生成中');
  await expect(page.getByTestId('quick-compare-card')).toContainText('正在并行请求候选模型');

  await expect(page.locator('.quick-compare-output.quick-compare-complete')).toHaveCount(3, {
    timeout: 20_000,
  });
});

async function seedMarkdownModels(env: SidecarEnv): Promise<void> {
  const providerRes = await authedFetch(env, '/v1/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Markdown Mock',
      type: 'custom',
      base_url: MOCK_URL,
      api_key: 'sk-markdown-test',
    }),
  });
  if (!providerRes.ok) throw new Error(`seed provider failed: ${providerRes.status}`);
  const provider = (await providerRes.json()) as { id: string };

  for (let i = 0; i < 3; i += 1) {
    const modelRes = await authedFetch(env, '/v1/models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider_id: provider.id,
        model_name: `markdown-mock-${i}`,
        capability: 'chat',
        display_name: `Markdown Mock ${i}`,
        is_default_for: i === 0 ? 'chat' : null,
        price_input_per_1m: 0.1 + i,
        price_output_per_1m: 0.2 + i,
        context_length: 8000 + i * 1000,
        supports_tools: i === 2,
        supports_json: i === 2,
      }),
    });
    if (!modelRes.ok) throw new Error(`seed model ${i} failed: ${modelRes.status}`);
  }
}
