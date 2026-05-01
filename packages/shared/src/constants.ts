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
  // M2.5 — Volcengine Ark MaaS (one API key, many model families:
  // doubao chat/vision, doubao-seed image, wan/seedance video).
  'volcengine_ark',
  // Huawei Cloud ModelArts MaaS (OpenAI-compatible chat + MaaS image API).
  'huawei_maas',
] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

export const MODEL_CAPABILITIES = [
  'chat',
  // M2.5 — multimodal models can also serve `chat` requests; UI groups them
  // separately, but the chat candidate pool treats `multimodal` as `chat-able`.
  'multimodal',
  'image',
  'video',
  'embedding',
  'asr',
  'tts',
] as const;
export type ModelCapability = (typeof MODEL_CAPABILITIES)[number];

/** Capabilities that can serve a chat request (text-in/text-out). */
export const CHAT_CAPABLE_CAPABILITIES = ['chat', 'multimodal'] as const;
export function isChatCapable(c: string): boolean {
  return (CHAT_CAPABLE_CAPABILITIES as readonly string[]).includes(c);
}

/** Modality flags for a model — independent of capability bucket. */
export const MODALITIES = ['text', 'image', 'audio', 'video'] as const;
export type Modality = (typeof MODALITIES)[number];

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
