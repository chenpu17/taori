import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEST_ENV_FILE = path.join(HERE, '.test-env');

function readEnv(): Record<string, string> {
  const result: Record<string, string> = {};
  if (!fs.existsSync(TEST_ENV_FILE)) return result;
  for (const line of fs.readFileSync(TEST_ENV_FILE, 'utf8').split('\n')) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match) result[match[1]!] = match[2]!;
  }
  return result;
}

export async function sidecarJson<T>(pathName: string, init: RequestInit = {}): Promise<T> {
  const env = readEnv();
  const url = env.VITE_SIDECAR_URL;
  const bearer = env.VITE_SIDECAR_BEARER;
  if (!url || !bearer) throw new Error('Missing e2e sidecar env');
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${bearer}`);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const response = await fetch(`${url}${pathName}`, { ...init, headers });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

export async function sidecarText(pathName: string, init: RequestInit = {}): Promise<string> {
  const env = readEnv();
  const url = env.VITE_SIDECAR_URL;
  const bearer = env.VITE_SIDECAR_BEARER;
  if (!url || !bearer) throw new Error('Missing e2e sidecar env');
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${bearer}`);
  const response = await fetch(`${url}${pathName}`, { ...init, headers });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  return await response.text();
}

export async function cleanupByNames(args: {
  providerNames?: string[];
  modelDisplayNames?: string[];
}): Promise<void> {
  const modelNames = new Set(args.modelDisplayNames ?? []);
  if (modelNames.size > 0) {
    const data = await sidecarJson<{ models: Array<{ id: string; display_name: string; alias: string | null }> }>('/v1/models');
    for (const model of data.models) {
      if (modelNames.has(model.display_name) || (model.alias && modelNames.has(model.alias))) {
        await sidecarJson<void>(`/v1/models/${model.id}`, { method: 'DELETE' });
      }
    }
  }

  const providerNames = new Set(args.providerNames ?? []);
  if (providerNames.size > 0) {
    const data = await sidecarJson<{ providers: Array<{ id: string; name: string }> }>('/v1/providers');
    for (const provider of data.providers) {
      if (providerNames.has(provider.name)) {
        await sidecarJson<void>(`/v1/providers/${provider.id}`, { method: 'DELETE' });
      }
    }
  }
}

export async function clearAllData(): Promise<void> {
  await sidecarJson('/v1/admin/clear-all-data', { method: 'POST' });
}

export interface SeededProvider {
  id: string;
  name: string;
}

export interface SeededModel {
  id: string;
  providerId: string;
  displayName: string;
}

/**
 * Seed 3 mock providers (OpenAI-like, OpenRouter-like, Ollama-like) + 4 distinct models.
 * Lets visual journey screenshots show a realistic multi-provider / multi-model stack
 * rather than a single "Mock Provider · Qwen 2.5 14B" everywhere.
 */
export async function seedMultiProviderStack(): Promise<{
  providers: SeededProvider[];
  models: SeededModel[];
  defaultModelId: string;
}> {
  const providerSpecs: Array<{ name: string; type: string; base_url: string }> = [
    { name: 'OpenAI 兼容（云端）', type: 'custom', base_url: 'https://api.openai-mock.test/v1' },
    { name: 'OpenRouter 聚合', type: 'custom', base_url: 'https://openrouter-mock.test/api/v1' },
    { name: '本地 Ollama', type: 'ollama', base_url: 'http://127.0.0.1:11434/v1' },
  ];
  const providers: SeededProvider[] = [];
  for (const spec of providerSpecs) {
    const created = await sidecarJson<{ id: string }>('/v1/providers', {
      method: 'POST',
      body: JSON.stringify({ ...spec, enabled: true }),
    });
    providers.push({ id: created.id, name: spec.name });
  }

  const [openai, openrouter, ollama] = providers;
  const modelSpecs: Array<{
    providerId: string;
    model_name: string;
    display_name: string;
    price_in: number;
    price_out: number;
    isDefault?: boolean;
  }> = [
    { providerId: openai!.id, model_name: 'gpt-4o-mini', display_name: 'GPT-4o mini', price_in: 0.15, price_out: 0.6, isDefault: true },
    { providerId: openrouter!.id, model_name: 'anthropic/claude-3.5-sonnet', display_name: 'Claude 3.5 Sonnet', price_in: 3, price_out: 15 },
    { providerId: openrouter!.id, model_name: 'deepseek/deepseek-chat', display_name: 'DeepSeek V3', price_in: 0.27, price_out: 1.1 },
    { providerId: ollama!.id, model_name: 'qwen2.5:14b', display_name: 'Qwen 2.5 14B（本地）', price_in: 0, price_out: 0 },
  ];

  const models: SeededModel[] = [];
  let defaultModelId = '';
  for (const spec of modelSpecs) {
    const created = await sidecarJson<{ id: string }>('/v1/models', {
      method: 'POST',
      body: JSON.stringify({
        provider_id: spec.providerId,
        model_name: spec.model_name,
        display_name: spec.display_name,
        capability: 'chat',
        enabled: true,
        is_default_for: spec.isDefault ? 'chat' : null,
        price_input_per_1m: spec.price_in,
        price_output_per_1m: spec.price_out,
      }),
    });
    models.push({ id: created.id, providerId: spec.providerId, displayName: spec.display_name });
    if (spec.isDefault) defaultModelId = created.id;
  }
  return { providers, models, defaultModelId };
}

export async function seedMockChatModel(displayName: string): Promise<{ providerId: string; modelId: string }> {
  const provider = await sidecarJson<{ id: string }>('/v1/providers', {
    method: 'POST',
    body: JSON.stringify({
      name: `${displayName} Provider`,
      type: 'custom',
      base_url: 'https://example.com/v1',
      enabled: true,
    }),
  });
  const model = await sidecarJson<{ id: string }>('/v1/models', {
    method: 'POST',
    body: JSON.stringify({
      provider_id: provider.id,
      model_name: `${displayName.toLowerCase().replace(/\s+/g, '-')}:chat`,
      display_name: displayName,
      capability: 'chat',
      enabled: true,
      is_default_for: 'chat',
      price_input_per_1m: 1,
      price_output_per_1m: 2,
    }),
  });
  return { providerId: provider.id, modelId: model.id };
}
