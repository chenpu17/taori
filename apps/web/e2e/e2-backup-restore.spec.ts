import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSidecarEnv, resetSidecar, seedDefaultModel } from './_helpers';

test.beforeEach(async () => {
  const env = readSidecarEnv();
  await resetSidecar(env);
  await seedDefaultModel(env);
});

test('E2 export backup triggers a JSON download from Settings', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('open-settings').click();
  await expect(page.getByTestId('settings-danger-zone')).toBeVisible();

  const downloadPromise = page.waitForEvent('download', { timeout: 10_000 });
  await page.getByTestId('settings-export-backup').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^taori_backup_.+\.json$/);
});

test('E2 import backup restores a conversation from JSON file', async ({ page }) => {
  const now = Date.now();
  const backup = {
    format_version: 'taori-backup-v1',
    exported_at: now,
    app_version: '0.0.0-test',
    counts: {
      providers: 1,
      models: 1,
      conversations: 1,
      messages: 1,
      files: 0,
      memories: 0,
      prompt_templates: 0,
      personas: 0,
      cost_records: 0,
      roundtables: 0,
      roundtable_messages: 0,
    },
    warnings: [],
    data: {
      providers: [
        {
          id: 'prov_import_backup',
          name: 'Imported Provider',
          type: 'custom',
          base_url: 'https://example.invalid/import',
          enabled: true,
          created_at: now,
          updated_at: now,
          had_api_key: false,
        },
      ],
      models: [
        {
          id: 'mdl_import_backup',
          alias: null,
          provider_id: 'prov_import_backup',
          model_name: 'import-model',
          capability: 'chat',
          display_name: 'Imported Model',
          price_input_per_1m: 1,
          price_output_per_1m: 2,
          price_per_call: null,
          price_per_image: null,
          price_per_video_second: null,
          price_currency: 'USD',
          price_synced_at: null,
          modalities: '["text"]',
          context_length: null,
          supports_vision: false,
          supports_tools: false,
          supports_json: false,
          is_default_for: null,
          fallback_order: 9,
          user_rating: null,
          failure_count_24h: 0,
          last_failure_at: null,
          demoted: false,
          disabled_until: null,
          enabled: true,
          created_at: now,
          updated_at: now,
        },
      ],
      conversations: [
        {
          id: 'conv_import_backup',
          type: 'chat',
          title: 'Imported Conversation',
          created_at: now,
          updated_at: now,
          archived: false,
          pinned: false,
          tags: null,
        },
      ],
      messages: [
        {
          id: 'msg_import_backup',
          conversation_id: 'conv_import_backup',
          role: 'assistant',
          content: 'Imported content',
          model_id: 'mdl_import_backup',
          parent_message_id: null,
          attachments: null,
          status: 'complete',
          error: null,
          created_at: now,
        },
      ],
      files: [],
      memories: [],
      prompt_templates: [],
      personas: [],
      cost_records: [],
      roundtables: [],
      roundtable_messages: [],
    },
  };
  const tmpPath = path.join(os.tmpdir(), `taori-import-${now}.json`);
  fs.writeFileSync(tmpPath, JSON.stringify(backup, null, 2), 'utf8');

  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('open-settings').click();
  await expect(page.getByTestId('settings-danger-zone')).toBeVisible();
  await page.getByTestId('settings-import-strategy').selectOption('overwrite');
  await page.getByTestId('settings-import-file').setInputFiles(tmpPath);

  await page.waitForLoadState('networkidle');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('conv-item').filter({ hasText: 'Imported Conversation' })).toBeVisible({
    timeout: 10_000,
  });

  fs.rmSync(tmpPath, { force: true });
});
