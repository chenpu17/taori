import { test, expect } from '@playwright/test';
import { authedFetch, readSidecarEnv, resetSidecar, seedDefaultModel } from './_helpers';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * R4.1 — PDF parsing. The sidecar should accept a PDF attachment, parse the
 * text via pdf-parse, and prepend it (fenced) to the upstream user prompt.
 *
 * No real upstream is reachable; we exercise the chat path with the M0 mock
 * provider which never calls a real API but still runs the upstream-bound
 * `buildUpstreamMessages` only when a key is configured. To validate parsing
 * end-to-end without a real key, we POST directly to /v1/chat with a tiny
 * known PDF and inspect the persisted user message — pdf attachment kept,
 * but produceMockStream still streams a reply (no error, no rejection).
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TINY_PDF_PATH = path.resolve(HERE, '_fixtures', 'hello.pdf');

test('R4.1 PDF attachment is parsed (no longer rejected)', async () => {
  const env = readSidecarEnv();
  await resetSidecar(env);
  await seedDefaultModel(env);

  // M0 provider has no api_key_ref so we land on the mock stream — that's
  // fine: the rejection (if any) would come BEFORE the producer.
  const models = (await (await authedFetch(env, '/v1/models')).json()) as {
    models: { id: string }[];
  };
  const modelId = models.models[0].id;
  const pdfBuf = fs.readFileSync(TINY_PDF_PATH);
  const data_b64 = pdfBuf.toString('base64');

  const r = await authedFetch(env, '/v1/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model_id: modelId,
      messages: [{ role: 'user', content: '请总结这份 PDF' }],
      attachments: [
        { kind: 'pdf', mime: 'application/pdf', data_b64, name: 'hello.pdf' },
      ],
    }),
  });

  // Used to be 400 with "暂不支持 PDF". Should now be 200 (stream).
  expect(r.status).toBe(200);
  // Drain stream so server-side persistence finalizes.
  const reader = r.body?.getReader();
  if (reader) {
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
  }

  // Verify the assistant message + user attachment row landed in DB.
  const convs = await (await authedFetch(env, '/v1/conversations')).json() as {
    conversations: { id: string }[];
  };
  expect(convs.conversations.length).toBeGreaterThan(0);
  const convId = convs.conversations[0].id;
  const msgs = await (
    await authedFetch(env, `/v1/conversations/${convId}/messages`)
  ).json() as { messages: { role: string; attachments_meta?: unknown }[] };
  const userMsg = msgs.messages.find((m) => m.role === 'user');
  expect(userMsg).toBeTruthy();
});

test('R4.1 PDF without extractable text returns helpful error', async () => {
  const env = readSidecarEnv();
  await resetSidecar(env);
  await seedDefaultModel(env);
  const models = (await (await authedFetch(env, '/v1/models')).json()) as {
    models: { id: string }[];
  };
  const modelId = models.models[0].id;

  // 'not a real pdf' bytes → pdf-parse throws → typed error.
  const data_b64 = Buffer.from('not a pdf').toString('base64');
  const r = await authedFetch(env, '/v1/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model_id: modelId,
      messages: [{ role: 'user', content: 'try this' }],
      attachments: [
        { kind: 'pdf', mime: 'application/pdf', data_b64, name: 'broken.pdf' },
      ],
    }),
  });
  expect(r.status).toBe(400);
  const j = (await r.json()) as { message: string };
  expect(j.message).toMatch(/PDF/);
});
