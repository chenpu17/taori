import { describe, expect, it } from 'vitest';
import type { Model, Provider } from '@taori/shared';
import { TaoriError } from '@taori/shared';
import { pickQuickCompareModels } from '../src/quick-compare/model-picker.js';

function model(patch: Partial<Model> & { id: string }): Model {
  return {
    id: patch.id,
    alias: null,
    provider_id: 'prov_test',
    model_name: patch.id,
    capability: 'chat',
    display_name: patch.id,
    price_input_per_1m: null,
    price_output_per_1m: null,
    price_per_call: null,
    price_per_image: null,
    price_per_video_second: null,
    price_currency: 'USD',
    pricing_meta: null,
    modalities: ['text'],
    price_synced_at: null,
    context_length: 8_000,
    supports_vision: false,
    supports_tools: false,
    supports_json: false,
    thinking_enabled: null,
    is_default_for: null,
    enabled: true,
    fallback_order: 0,
    demoted: false,
    disabled_until: null,
    failure_count_24h: 0,
    ...patch,
  };
}

function provider(patch: Partial<Provider> & { id: string }): Provider {
  return {
    id: patch.id,
    name: patch.name ?? patch.id,
    type: patch.type ?? 'openai',
    base_url: patch.base_url ?? 'https://example.com/v1',
    api_key_ref: patch.api_key_ref ?? null,
    enabled: patch.enabled ?? true,
    created_at: 0,
    updated_at: 0,
  };
}

describe('pickQuickCompareModels', () => {
  it('selects current, cheap, and quality candidates with reasons', () => {
    const selected = pickQuickCompareModels({
      currentModelId: 'mdl_current',
      now: 1000,
      models: [
        model({ id: 'mdl_current', price_input_per_1m: 2, fallback_order: 2 }),
        model({ id: 'mdl_cheap', price_input_per_1m: 0.1, fallback_order: 3 }),
        model({
          id: 'mdl_quality',
          price_input_per_1m: 5,
          context_length: 200_000,
          supports_tools: true,
          supports_json: true,
          fallback_order: 4,
        }),
      ],
    });

    expect(selected.map((item) => item.model.id)).toEqual([
      'mdl_current',
      'mdl_cheap',
      'mdl_quality',
    ]);
    expect(selected.map((item) => item.role)).toEqual(['current', 'cheap', 'quality']);
  });

  it('honors explicit model ids and rejects ineligible models', () => {
    const models = [
      model({ id: 'mdl_a' }),
      model({ id: 'mdl_b', enabled: false }),
      model({ id: 'mdl_c' }),
    ];

    expect(
      pickQuickCompareModels({
        currentModelId: 'mdl_a',
        requestedModelIds: ['mdl_a', 'mdl_c'],
        models,
      }).map((item) => item.model.id),
    ).toEqual(['mdl_a', 'mdl_c']);

    expect(() =>
      pickQuickCompareModels({
        requestedModelIds: ['mdl_a', 'mdl_b'],
        models,
      }),
    ).toThrow(TaoriError);
  });

  it('uses a friendly message when the current model is ineligible', () => {
    expect(() =>
      pickQuickCompareModels({
        currentModelId: 'mdl_current',
        requestedModelIds: ['mdl_current', 'mdl_peer'],
        models: [
          model({ id: 'mdl_current', display_name: 'Current Model', demoted: true }),
          model({ id: 'mdl_peer', display_name: 'Peer Model' }),
        ],
      }),
    ).toThrow('当前会话模型暂不可用于 Quick Compare');
  });

  it('uses display names instead of internal ids for non-current invalid models', () => {
    expect(() =>
      pickQuickCompareModels({
        currentModelId: 'mdl_a',
        requestedModelIds: ['mdl_a', 'mdl_b'],
        models: [
          model({ id: 'mdl_a', display_name: 'Alpha' }),
          model({ id: 'mdl_b', display_name: 'Beta', enabled: false }),
        ],
      }),
    ).toThrow('模型「Beta」当前不可用于 Quick Compare');
  });

  it('falls back to alias when display name is missing for invalid non-current models', () => {
    expect(() =>
      pickQuickCompareModels({
        currentModelId: 'mdl_a',
        requestedModelIds: ['mdl_a', 'mdl_b'],
        models: [
          model({ id: 'mdl_a', display_name: 'Alpha' }),
          model({ id: 'mdl_b', display_name: null, alias: 'Beta Alias', enabled: false }),
        ],
      }),
    ).toThrow('模型「Beta Alias」当前不可用于 Quick Compare');
  });

  it('falls back to model_name when alias and display name are missing', () => {
    expect(() =>
      pickQuickCompareModels({
        currentModelId: 'mdl_a',
        requestedModelIds: ['mdl_a', 'mdl_b'],
        models: [
          model({ id: 'mdl_a', display_name: 'Alpha' }),
          model({ id: 'mdl_b', display_name: null, alias: null, model_name: 'beta-model', enabled: false }),
        ],
      }),
    ).toThrow('模型「beta-model」当前不可用于 Quick Compare');
  });

  it('uses a generic message when a requested model id no longer exists', () => {
    expect(() =>
      pickQuickCompareModels({
        currentModelId: 'mdl_a',
        requestedModelIds: ['mdl_a', 'mdl_missing'],
        models: [
          model({ id: 'mdl_a', display_name: 'Alpha' }),
        ],
      }),
    ).toThrow('所选模型当前不可用于 Quick Compare');
  });

  it('skips models whose provider is disabled when provider state is supplied', () => {
    const selected = pickQuickCompareModels({
      providers: [
        provider({ id: 'prov_enabled' }),
        provider({ id: 'prov_disabled', name: 'Disabled Provider', enabled: false }),
      ],
      models: [
        model({ id: 'mdl_disabled', provider_id: 'prov_disabled', price_input_per_1m: 0.001 }),
        model({ id: 'mdl_a', provider_id: 'prov_enabled', price_input_per_1m: 1 }),
        model({ id: 'mdl_b', provider_id: 'prov_enabled', price_input_per_1m: 2 }),
      ],
    });

    expect(selected.map((item) => item.model.id)).toEqual(['mdl_a', 'mdl_b']);
  });

  it('uses a provider-disabled message for explicit disabled-provider selections', () => {
    expect(() =>
      pickQuickCompareModels({
        requestedModelIds: ['mdl_a', 'mdl_disabled'],
        providers: [
          provider({ id: 'prov_enabled' }),
          provider({ id: 'prov_disabled', name: 'Disabled Provider', enabled: false }),
        ],
        models: [
          model({ id: 'mdl_a', provider_id: 'prov_enabled' }),
          model({ id: 'mdl_disabled', provider_id: 'prov_disabled', display_name: 'Disabled Model' }),
        ],
      }),
    ).toThrow('服务商「Disabled Provider」已停用');
  });
});
