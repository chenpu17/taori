import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEST_ENV_FILE = path.join(HERE, '.test-env');

export interface SidecarEnv {
  url: string;
  bearer: string;
}

export function readSidecarEnv(): SidecarEnv {
  // Prefer .test-env written by global-setup (isolated test sidecar).
  // Fall back to .env.local for backwards-compat standalone usage.
  const envPath = fs.existsSync(TEST_ENV_FILE)
    ? TEST_ENV_FILE
    : path.resolve(HERE, '..', '.env.local');
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
  // Delete conversations first — clears history + sidebar entries (cascades
  // to messages via FK; cost_records keep with conversation_id=NULL).
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
