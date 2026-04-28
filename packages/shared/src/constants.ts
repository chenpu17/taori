export const PROVIDER_TYPES = [
  'openrouter',
  'openai',
  'anthropic',
  'ollama',
  'custom',
  // M2.4 — image-generation adapters. M2.3 reserves these enum values so
  // ProviderTypeSchema accepts them; actual adapters land in M2.4.
  'replicate',
  'sd_webui',
] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

export const MODEL_CAPABILITIES = [
  'chat',
  'image',
  'video',
  'embedding',
  'asr',
  'tts',
] as const;
export type ModelCapability = (typeof MODEL_CAPABILITIES)[number];

export const MESSAGE_STATUSES = [
  'pending',
  'streaming',
  'completed',
  'incomplete',
  'failed',
] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

/** Default OpenRouter base URL */
export const DEFAULT_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/** Sidecar Keychain service identifier (must match what Tauri Rust uses). */
export const KEYCHAIN_SERVICE = 'app.taori.desktop';
