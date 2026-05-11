import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEST_ENV_FILE = path.join(HERE, '.test-env');
const DEFAULT_HERMETIC_E2E_URL = 'http://127.0.0.1:17900';
const DEFAULT_HERMETIC_E2E_BEARER = 'test_bearer_playwright_e2e_isolated';

export interface SidecarEnv {
  url: string;
  bearer: string;
}

export function readSidecarEnv(): SidecarEnv {
  // E2E tests must never fall back to the developer's .env.local: many specs
  // call resetSidecar(), which would wipe the real dev.db/providers/models if
  // another Playwright process removed .test-env mid-run.
  if (!fs.existsSync(TEST_ENV_FILE)) {
    if (process.env.ALLOW_E2E_DEV_SIDECAR === '1') {
      const devEnvPath = path.resolve(HERE, '..', '.env.local');
      return readEnvFile(devEnvPath);
    }
    // Some specs read the env at module scope, but Playwright may import test
    // files before globalSetup has written .test-env. Fall back to the fixed
    // hermetic defaults used by global-setup so those imports stay isolated.
    return {
      url: process.env.VITE_SIDECAR_URL ?? DEFAULT_HERMETIC_E2E_URL,
      bearer: process.env.VITE_SIDECAR_BEARER ?? DEFAULT_HERMETIC_E2E_BEARER,
    };
  }
  return readEnvFile(TEST_ENV_FILE);
}

function readEnvFile(envPath: string): SidecarEnv {
  const raw = fs.readFileSync(envPath, 'utf8');
  const map: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m) map[m[1]!] = m[2]!.trim();
  }
  const url = map['VITE_SIDECAR_URL'];
  const bearer = map['VITE_SIDECAR_BEARER'];
  if (!url || !bearer) {
    throw new Error(`missing VITE_SIDECAR_* in ${envPath}`);
  }
  return { url, bearer };
}

export async function authedFetch(
  env: SidecarEnv,
  pathPart: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`${env.url}${pathPart}`, {
    ...init,
    headers: { ...(init.headers ?? {}), authorization: `Bearer ${env.bearer}` },
  });
}

/** Reset sidecar state to "no providers/models" so an Onboarding flow runs. */
export async function resetSidecar(env: SidecarEnv): Promise<void> {
  await authedFetch(env, '/v1/admin/clear-all-data', { method: 'POST' });

  // Keep the legacy targeted cleanup as a compatibility fallback for older
  // sidecars that may not yet implement the admin clear endpoint.
  const c = await authedFetch(env, '/v1/conversations');
  if (c.ok) {
    const { conversations } = (await c.json()) as { conversations: { id: string }[] };
    for (const x of conversations) {
      await authedFetch(env, `/v1/conversations/${x.id}`, { method: 'DELETE' });
    }
  }
  const m = await authedFetch(env, '/v1/models');
  if (m.ok) {
    const { models } = (await m.json()) as { models: { id: string }[] };
    for (const x of models) {
      await authedFetch(env, `/v1/models/${x.id}`, { method: 'DELETE' });
    }
  }
  const p = await authedFetch(env, '/v1/providers');
  if (p.ok) {
    const { providers } = (await p.json()) as { providers: { id: string }[] };
    for (const x of providers) {
      await authedFetch(env, `/v1/providers/${x.id}`, { method: 'DELETE' });
    }
  }

  // E2E isolation also needs the renderer-side preference keys cleared;
  // otherwise a previous spec can leak global budget / confirm gates into
  // the next one even though chat/model state was reset.
  const globalMemoryKeys = [
    'daily_budget_usd',
    'daily_budget_alert_state',
    'monthly_budget_usd',
    'monthly_budget_alert_state',
    'daily_budget_hard_limit',
    'monthly_budget_hard_limit',
    'cost_confirm_threshold_usd',
    'cost_confirm_image_always',
    'cost_confirm_disabled_models',
    'cost_confirm_disabled_conversations',
    'active_chat_model_id',
    'image_model_default',
    'thinking_enabled',
  ];
  for (const key of globalMemoryKeys) {
    await authedFetch(
      env,
      `/v1/memories?scope=global&key=${encodeURIComponent(key)}`,
      { method: 'DELETE' },
    );
  }
}

/** Seed one provider + a default chat model so the chat panel boots. */
export async function seedDefaultModel(env: SidecarEnv): Promise<void> {
  const pr = await authedFetch(env, '/v1/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'M0 mock provider',
      type: 'custom',
      base_url: 'https://example.invalid/v1',
    }),
  });
  if (!pr.ok) throw new Error(`seed provider failed: ${pr.status}`);
  const provider = (await pr.json()) as { id: string };
  const mr = await authedFetch(env, '/v1/models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider_id: provider.id,
      model_name: 'mock-model',
      capability: 'chat',
      display_name: 'Mock chat',
      is_default_for: 'chat',
      price_input_per_1m: 0.5,
      price_output_per_1m: 1.5,
    }),
  });
  if (!mr.ok) throw new Error(`seed model failed: ${mr.status}`);
}
