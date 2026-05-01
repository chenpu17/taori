import { test, expect, type Page } from '@playwright/test';
import { authedFetch, readSidecarEnv, resetSidecar, seedDefaultModel } from './_helpers';

async function suppressTips(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('tip_image_first_seen', 'true');
    localStorage.setItem('tip_fallback_first_seen', 'true');
    localStorage.setItem('tip_cost_first_seen', 'true');
    localStorage.setItem('tip_roundtable_first_seen', 'true');
  });
}

async function getDefaultModelId() {
  const env = readSidecarEnv();
  const res = await authedFetch(env, '/v1/models');
  const body = (await res.json()) as { models: Array<{ id: string }> };
  return body.models[0]!.id;
}

async function sendChat(modelId: string, content: string, classification?: string) {
  const env = readSidecarEnv();
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (classification) headers['x-test-force-classification'] = classification;
  const res = await authedFetch(env, '/v1/chat', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model_id: modelId,
      messages: [{ role: 'user', content }],
    }),
  });
  expect(res.ok).toBeTruthy();
  await res.text();
}

test.beforeEach(async () => {
  const env = readSidecarEnv();
  await resetSidecar(env);
  await seedDefaultModel(env);
});

test('E1 model health panel shows 24h calls, failures, latency and last failure class', async ({
  page,
}) => {
  const modelId = await getDefaultModelId();
  await sendChat(modelId, 'health success');
  await sendChat(modelId, 'health failure', 'rate_limit');

  await suppressTips(page);
  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  await page.getByTestId('open-model-center').click();
  await expect(page.getByTestId('model-center')).toBeVisible();

  await page.getByTestId(`model-health-toggle-${modelId}`).click();
  const panel = page.getByTestId(`model-health-panel-${modelId}`);
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('model-health-calls')).toHaveText('2');
  await expect(panel.getByTestId('model-health-failures')).toHaveText('1');
  await expect(panel.getByTestId('model-health-ttfb')).toContainText('ms');
  await expect(panel.getByTestId('model-health-last-failure')).toContainText('限流');
});
