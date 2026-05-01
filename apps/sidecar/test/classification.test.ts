import { describe, it, expect } from 'vitest';
import { classifyProviderError } from '../src/providers/registry.js';
import { openDb } from '../src/db/index.js';
import { ModelsRepo, ProvidersRepo } from '../src/db/repos/index.js';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

describe('classifyProviderError (spec §7.5.2)', () => {
  it('AbortError → network', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    expect(classifyProviderError({ err }).classification).toBe('network');
  });

  it('cause.code (ECONNREFUSED) → network', () => {
    const err = Object.assign(new Error('connect failed'), {
      cause: { code: 'ECONNREFUSED' },
    });
    expect(classifyProviderError({ err }).classification).toBe('network');
  });

  it('402 → quota', () => {
    expect(classifyProviderError({ status: 402 }).classification).toBe('quota');
  });

  it('429 → rate_limit', () => {
    expect(classifyProviderError({ status: 429 }).classification).toBe(
      'rate_limit',
    );
  });

  it('401/403 → auth', () => {
    expect(classifyProviderError({ status: 401 }).classification).toBe('auth');
    expect(classifyProviderError({ status: 403 }).classification).toBe('auth');
  });

  it('500+ → network', () => {
    expect(classifyProviderError({ status: 502 }).classification).toBe(
      'network',
    );
  });

  it('content_filter keywords in message → content_filter', () => {
    const a = new Error('Response blocked by content_filter policy.');
    expect(classifyProviderError({ status: 400, err: a }).classification).toBe(
      'content_filter',
    );
    const b = new Error('upstream returned moderation flag');
    expect(classifyProviderError({ err: b }).classification).toBe(
      'content_filter',
    );
  });

  it('AI_RetryError lastError status/message → quota or rate_limit', () => {
    const quota = Object.assign(new Error('Failed after retries'), {
      name: 'AI_RetryError',
      lastError: Object.assign(new Error('You exceeded your current quota'), {
        statusCode: 429,
      }),
    });
    expect(classifyProviderError({ err: quota }).classification).toBe('quota');

    const rateLimit = Object.assign(new Error('Failed after retries'), {
      name: 'AI_RetryError',
      errors: [
        Object.assign(new Error('Too many requests'), {
          statusCode: 429,
        }),
      ],
    });
    expect(classifyProviderError({ err: rateLimit }).classification).toBe(
      'rate_limit',
    );
  });
});

describe('ModelsRepo demote/disable (spec §7.5.2)', () => {
  const dbPath = path.join(os.tmpdir(), `taori-failures-${Date.now()}.db`);
  const db = openDb(dbPath);
  const providers = new ProvidersRepo(db);
  const models = new ModelsRepo(db);

  const provider = providers.create({
    name: 'p',
    type: 'openrouter',
    base_url: 'https://openrouter.ai/api/v1',
  });
  const model = models.create({
    provider_id: provider.id,
    model_name: 'm/x',
    capability: 'chat',
    display_name: 'M',
  });

  afterAll(() => fs.rmSync(dbPath, { force: true }));

  it('content_filter does NOT count as strike (per-prompt policy issue)', () => {
    models.recordFailure(model.id, 'content_filter');
    const m = models.get(model.id)!;
    expect(m.failure_count_24h).toBe(0);
    expect(m.demoted).toBe(false);
  });

  it('quota / rate_limit / auth / unknown / network all count as strikes; 3× → demoted, 5× → disabled', () => {
    models.recordFailure(model.id, 'quota');
    models.recordFailure(model.id, 'unknown');
    let m = models.get(model.id)!;
    expect(m.failure_count_24h).toBe(2);
    expect(m.demoted).toBe(false);

    models.recordFailure(model.id, 'auth');
    m = models.get(model.id)!;
    expect(m.failure_count_24h).toBe(3);
    expect(m.demoted).toBe(true);
    expect(m.disabled_until).toBeNull();

    models.recordFailure(model.id, 'network');
    models.recordFailure(model.id, 'quota');
    m = models.get(model.id)!;
    expect(m.failure_count_24h).toBe(5);
    expect(m.demoted).toBe(true);
    expect(m.disabled_until).toBeGreaterThan(Date.now());
  });

  it('recordSuccess resets the rolling counter (but keeps demoted flag)', () => {
    models.recordSuccess(model.id);
    const m = models.get(model.id)!;
    expect(m.failure_count_24h).toBe(0);
    expect(m.demoted).toBe(true);
  });

  it('defaultFor skips demoted models', () => {
    models.update(model.id, { is_default_for: 'chat' });
    expect(models.defaultFor('chat')).toBeNull();
  });

  it('nextFallback orders by fallback_order asc and skips demoted/disabled', () => {
    const m2 = models.create({
      provider_id: provider.id,
      model_name: 'm/y',
      capability: 'chat',
      display_name: 'Y',
    });
    const m3 = models.create({
      provider_id: provider.id,
      model_name: 'm/z',
      capability: 'chat',
      display_name: 'Z',
    });
    models.update(m2.id, { fallback_order: 2 });
    models.update(m3.id, { fallback_order: 1 });
    const next = models.nextFallback(model.id, 'chat');
    expect(next?.id).toBe(m3.id);
  });
});

import { afterAll } from 'vitest';
