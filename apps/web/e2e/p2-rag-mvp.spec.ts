import { test, expect } from '@playwright/test';
import { readSidecarEnv, resetSidecar, seedDefaultModel } from './_helpers';

const env = readSidecarEnv();

async function dropMarkdown(page: import('@playwright/test').Page, content: string, name = 'note.md') {
  const dataTransfer = await page.evaluateHandle(
    ({ fileContent, fileName }) => {
      const dt = new DataTransfer();
      dt.items.add(new File([fileContent], fileName, { type: 'text/markdown' }));
      return dt;
    },
    { fileContent: content, fileName: name },
  );
  await page.getByTestId('composer-form').dispatchEvent('dragover', { dataTransfer });
  await page.getByTestId('composer-form').dispatchEvent('drop', { dataTransfer });
}

test.beforeEach(async () => {
  await resetSidecar(env);
});

test('P2 RAG MVP: uploaded docs become searchable and visible in follow-up retrieval', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await seedDefaultModel(env);
  await page.addInitScript(() => {
    localStorage.setItem('tip_image_first_seen', 'true');
    localStorage.setItem('tip_fallback_first_seen', 'true');
    localStorage.setItem('tip_cost_first_seen', 'true');
    localStorage.setItem('tip_roundtable_first_seen', 'true');
  });
  await page.goto('/');
  await expect(page.getByTestId('composer-form')).toBeVisible();

  await dropMarkdown(
    page,
    '# Taori Notes\n\nLocal RAG uses sqlite bm25 chunk retrieval and injects relevant snippets into answers.',
  );
  await expect(page.getByTestId('attachment-thumb')).toHaveCount(1);

  await page.getByTestId('composer-input').fill('先记住这份文档，并用一句话总结');
  await page.getByTestId('composer-send').click();
  await expect(page.getByTestId('attachments-bar')).toHaveCount(0, { timeout: 10_000 });
  await expect(page.locator('.msg.assistant').first()).toBeVisible({ timeout: 10_000 });

  await page.getByTestId('composer-input').fill('bm25 是怎么用的');
  const preview = page.getByTestId('composer-file-search-preview');
  await expect(preview).toBeVisible({ timeout: 10_000 });
  await expect(preview).toContainText('note.md');
  await expect(preview).toContainText('sqlite bm25');

  await page.getByTestId('composer-send').click();
  await expect(page.locator('.msg.assistant').first()).toBeVisible({ timeout: 10_000 });

  await page.getByTestId('open-run-timeline').click();
  const timeline = page.getByTestId('run-timeline-panel');
  await expect(timeline).toBeVisible({ timeout: 10_000 });
  const fileChunks = timeline.getByTestId('run-event-file-chunks').first();
  await expect(fileChunks).toContainText('note.md');
  await expect(fileChunks).toContainText('sqlite bm25');
});
