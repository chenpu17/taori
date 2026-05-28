import type { Model, ModelCapability, Provider } from '@taori/shared';
import { PricingMetaSchema } from '@taori/shared';
import { models, providers } from '../schema.js';

type ProviderRow = typeof providers.$inferSelect;
type ModelRow = typeof models.$inferSelect;

export function toProvider(row: ProviderRow): Provider {
  return {
    id: row.id,
    name: row.name,
    type: row.type as Provider['type'],
    base_url: row.base_url,
    api_key_ref: row.api_key_ref,
    enabled: row.enabled,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function toModel(row: ModelRow): Model {
  let modalities: Model['modalities'] = ['text'];
  if (row.modalities) {
    try {
      const parsed = JSON.parse(row.modalities);
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) {
        modalities = parsed as Model['modalities'];
      }
    } catch {
      // keep default
    }
  } else {
    // Backfill defaults based on capability for legacy rows.
    const cap = row.capability as ModelCapability;
    if (cap === 'image') modalities = ['image'];
    else if (cap === 'video') modalities = ['video'];
    else if (cap === 'multimodal') modalities = ['text', 'image'];
    else if (cap === 'asr') modalities = ['audio'];
    else if (cap === 'tts') modalities = ['audio'];
  }
  return {
    id: row.id,
    alias: row.alias,
    provider_id: row.provider_id,
    model_name: row.model_name,
    capability: row.capability as ModelCapability,
    display_name: row.display_name,
    price_input_per_1m: row.price_input_per_1m,
    price_output_per_1m: row.price_output_per_1m,
    price_per_call: row.price_per_call,
    price_per_image: row.price_per_image ?? null,
    price_per_video_second: row.price_per_video_second ?? null,
    price_currency: row.price_currency,
    pricing_meta: parsePricingMeta(row.pricing_meta),
    modalities,
    price_synced_at: row.price_synced_at ?? null,
    context_length: row.context_length,
    supports_vision: row.supports_vision,
    supports_tools: row.supports_tools,
    supports_json: row.supports_json,
    thinking_enabled: row.thinking_enabled ?? null,
    is_default_for: (row.is_default_for as ModelCapability | null) ?? null,
    enabled: row.enabled,
    fallback_order: row.fallback_order ?? 0,
    demoted: row.demoted ?? false,
    disabled_until: row.disabled_until ?? null,
    failure_count_24h: row.failure_count_24h ?? 0,
  };
}

function parsePricingMeta(raw: string | null): Model['pricing_meta'] {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    const result = PricingMetaSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function stringifyPricingMeta(value: Model['pricing_meta'] | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return JSON.stringify(value);
}

export function parseStringArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

export function parseConversationTags(raw: string | null): string[] {
  return Array.from(
    new Set(
      parseStringArray(raw)
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    ),
  ).slice(0, 3);
}
