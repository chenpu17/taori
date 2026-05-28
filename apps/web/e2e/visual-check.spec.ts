import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { Server } from 'node:http';
import { expect, test } from '@playwright/test';
import { startMockOpenAI } from './_mock-openai-server';
import { authedFetch, readSidecarEnv, resetSidecar, seedDefaultModel, type SidecarEnv } from './_helpers';

const DIR = '/tmp/taori-visual';
const HERE = path.dirname(new URL(import.meta.url).pathname);
const PDF_FIXTURE = path.join(HERE, '_fixtures', 'hello.pdf');

function ensureDir(): void {
  fs.mkdirSync(DIR, { recursive: true });
}

async function snap(page: import('@playwright/test').Page, name: string): Promise<void> {
  await page.screenshot({ path: `${DIR}/${name}.png`, fullPage: false });
}

async function gotoApp(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await page.waitForSelector('.app', { timeout: 15_000 });
  await expect(page.locator('.foot')).toBeVisible({ timeout: 10_000 });
}

async function createProvider(
  env: SidecarEnv,
  body: {
    name: string;
    type: string;
    base_url: string;
    api_key?: string;
  },
): Promise<{ id: string }> {
  const res = await authedFetch(env, '/v1/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(res.ok).toBeTruthy();
  return (await res.json()) as { id: string };
}

async function createModel(
  env: SidecarEnv,
  body: {
    provider_id: string;
    model_name: string;
    capability: 'chat' | 'image';
    display_name: string;
    is_default_for?: 'chat' | 'image';
    price_input_per_1m?: number;
    price_output_per_1m?: number;
  },
): Promise<{ id: string }> {
  const res = await authedFetch(env, '/v1/models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(res.ok).toBeTruthy();
  return (await res.json()) as { id: string };
}

async function seedProviderVisualState(env: SidecarEnv): Promise<void> {
  const success = await createProvider(env, {
    name: 'Visual Success',
    type: 'openai',
    base_url: mockBaseUrl,
    api_key: 'sk-visual-success',
  });
  await createModel(env, {
    provider_id: success.id,
    model_name: 'mock-strategy',
    capability: 'chat',
    display_name: 'Visual Chat',
    is_default_for: 'chat',
    price_input_per_1m: 0.2,
    price_output_per_1m: 0.8,
  });
  await createProvider(env, {
    name: 'Visual Missing Key',
    type: 'openai',
    base_url: mockBaseUrl,
  });
}

async function openProviderDrawer(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('.hdr-icon').click();
  await page.locator('.over-menu-item').filter({ hasText: '模型' }).click();
  await page.locator('.drawer-tab').filter({ hasText: 'Providers' }).click();
  await expect(page.locator('.drawer .section-h').first()).toContainText('已连接');
}

let server: Server | null = null;
let mockBaseUrl = '';

test.beforeAll(async () => {
  ensureDir();
  server = startMockOpenAI(0, {
    models: [
      { id: 'mock-strategy', object: 'model' },
      { id: 'mock-user', object: 'model' },
      { id: 'mock-tech', object: 'model' },
    ],
  });
  await new Promise<void>((resolve) => {
    server!.once('listening', () => {
      const addr = server!.address() as AddressInfo;
      mockBaseUrl = `http://127.0.0.1:${addr.port}/v1`;
      resolve();
    });
  });
});

test.afterAll(async () => {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server!.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
  server = null;
});

test.describe('visual verification', () => {
  test('desktop chat reply + attachment chips', async ({ page }) => {
    const env = readSidecarEnv();
    await resetSidecar(env);
    await seedDefaultModel(env);

    await gotoApp(page);

    const fileInput = page.locator('.composer-shell input[type="file"]');
    await fileInput.setInputFiles(PDF_FIXTURE);
    await expect(page.locator('.attach-chip')).toHaveCount(1);
    await snap(page, '01-desktop-attachments');

    const textarea = page.locator('.composer-input');
    await textarea.fill('请基于附件给一个摘要');
    await page.locator('.composer-send').click();
    await expect(page.locator('.msg').last()).toContainText('End-to-end Renderer→Sidecar streaming is working.', {
      timeout: 10_000,
    });
    await snap(page, '02-desktop-chat-reply');
  });

  test('footer health popup and settings drawer', async ({ page }) => {
    const env = readSidecarEnv();
    await resetSidecar(env);
    await seedProviderVisualState(env);

    await gotoApp(page);

    await page.locator('.foot-item').first().click();
    await expect(page.locator('.foot-popup')).toBeVisible();
    await snap(page, '03-footer-health-popup');

    await page.locator('.main').click({ position: { x: 220, y: 220 } });
    await page.locator('.hdr-icon').click();
    await page.locator('.over-menu-item').filter({ hasText: '设置' }).click();
    await expect(page.locator('.drawer .title')).toContainText('设置');
    await snap(page, '04-settings-drawer');
  });

  test('provider connection success toast', async ({ page }) => {
    const env = readSidecarEnv();
    await resetSidecar(env);
    await seedProviderVisualState(env);

    await gotoApp(page);
    await openProviderDrawer(page);

    await page.locator('.list-row').filter({ hasText: 'Visual Success' }).click();
    await expect(page.locator('.section-h')).toContainText('Visual Success');
    await page.getByRole('button', { name: /测试连接/ }).click();
    await expect(page.locator('text=连接成功 ✓ · 发现 3 个模型')).toBeVisible({ timeout: 10_000 });
    await snap(page, '05-provider-test-success');
  });

  test('provider connection failure toast shows classification', async ({ page }) => {
    const env = readSidecarEnv();
    await resetSidecar(env);
    await seedProviderVisualState(env);

    await gotoApp(page);
    await openProviderDrawer(page);

    await page.locator('.list-row').filter({ hasText: 'Visual Missing Key' }).click();
    await expect(page.locator('.section-h')).toContainText('Visual Missing Key');
    await page.getByRole('button', { name: /测试连接/ }).click();
    await expect(page.locator('text=连接失败: 缺少 API Key · API key is not configured')).toBeVisible({
      timeout: 10_000,
    });
    await snap(page, '06-provider-test-failure');
  });

  test('mobile sidebar overlay and composer', async ({ page }) => {
    const env = readSidecarEnv();
    await resetSidecar(env);
    await seedProviderVisualState(env);

    await page.setViewportSize({ width: 390, height: 844 });
    await gotoApp(page);
    await snap(page, '07-mobile-home');

    await page.locator('.hdr-hamburger').click();
    await expect(page.locator('.side-backdrop')).toBeVisible();
    await snap(page, '08-mobile-sidebar-overlay');
  });
});
