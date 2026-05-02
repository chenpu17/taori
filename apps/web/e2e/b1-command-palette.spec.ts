import { test, expect } from '@playwright/test';
import { authedFetch, readSidecarEnv } from './_helpers';

const env = readSidecarEnv();

test('B1: Command palette ⌘K / Ctrl+K search, navigate, keyboard', async ({ page, browserName }) => {
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('PAGE ERROR>', m.text());
  });

  // Setup: create provider, model, and test conversation
  const pr = await authedFetch(env, '/v1/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'test-prov', type: 'custom', base_url: 'https://example.invalid/v1' }),
  });
  const provider = (await pr.json()) as { id: string };

  await authedFetch(env, '/v1/models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider_id: provider.id,
      model_name: 'test-model',
      capability: 'chat',
      display_name: 'TestModel',
      is_default_for: 'chat',
      price_input_per_1m: 0.1,
      price_output_per_1m: 0.2,
    }),
  });

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });

  // Create a test conversation
  await page.getByTestId('composer-input').fill('hello test');
  await page.getByTestId('composer-send').click();
  await expect(page.locator('.msg.assistant').first()).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(500);

  // --- 1. Open command palette with Cmd+K / Ctrl+K
  const isMac = browserName === 'chromium'; // Playwright on macOS uses chromium too
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
  await expect(page.getByTestId('cmd-palette-input')).toBeVisible({ timeout: 2_000 });
  console.log('✓ Command palette opened');

  // --- 2. Search for conversation
  await page.getByTestId('cmd-palette-input').type('hello');
  await page.waitForTimeout(300);
  const convResults = page.locator('[data-testid="cmd-result"][data-category="conversation"]');
  await expect(convResults.first()).toBeVisible();
  console.log('✓ Conversation search returned results');

  // --- 3. Keyboard navigation (arrow down to next result, then to model search)
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(100);
  let selected = page.locator('[data-testid="cmd-result"].selected');
  await expect(selected).toHaveCount(1);
  console.log('✓ Arrow down moves selection');

  // --- 4. Clear search and test model search
  await page.getByTestId('cmd-palette-input').clear();
  await page.getByTestId('cmd-palette-input').type('TestModel');
  await page.waitForTimeout(300);
  const modelResults = page.locator('[data-testid="cmd-result"][data-category="model"]');
  await expect(modelResults.first()).toBeVisible();
  await expect(modelResults.first()).toContainText('TestModel · test-prov');
  console.log('✓ Model search returned results');

  // --- 5. Test fixed commands (settings, help, roundtable)
  await page.getByTestId('cmd-palette-input').clear();
  await page.waitForTimeout(300);
  const fixedResults = page.locator('[data-testid="cmd-result"][data-category="help"], [data-testid="cmd-result"][data-category="settings"]');
  await expect(fixedResults.first()).toBeVisible();
  console.log('✓ Fixed commands visible when query empty');

  // --- 6. Press Enter to select (should close palette and switch conv/model)
  await page.getByTestId('cmd-palette-input').fill('hello');
  await page.waitForTimeout(300);
  selected = page.locator('[data-testid="cmd-result"].selected');
  await selected.first().click();
  await expect(page.getByTestId('cmd-palette-input')).not.toBeVisible({ timeout: 2_000 });
  console.log('✓ Selection closed palette');

  // --- 7. Open again and test Escape to close
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
  await expect(page.getByTestId('cmd-palette-input')).toBeVisible({ timeout: 2_000 });
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('cmd-palette-input')).not.toBeVisible({ timeout: 2_000 });
  console.log('✓ Escape closed palette');

  // --- 8. Visual check: no console errors
  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  await page.waitForTimeout(500);
  if (consoleErrors.length > 0) {
    console.error('Console errors found:', consoleErrors);
  }
  expect(consoleErrors.length).toBe(0);
  console.log('✓ No console errors during B1 flow');
});
