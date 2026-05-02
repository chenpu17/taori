import type { Model } from '@taori/shared';

export type ModelDisplayLike = Pick<
  Model,
  'id' | 'model_name' | 'display_name'
> &
  Partial<Pick<Model, 'alias' | 'provider_id'>>;

export interface ProviderDisplayLike {
  id: string;
  name: string;
  type: string;
}

export function providerDisplayName(
  providers: ProviderDisplayLike[],
  providerId: string | null | undefined,
): string {
  if (!providerId) return '本地';
  const provider = providers.find((p) => p.id === providerId);
  if (!provider) return '未知供应商';
  return provider.name || provider.type;
}

export function modelBaseDisplayName(
  model: Pick<ModelDisplayLike, 'display_name'> &
    Partial<Pick<ModelDisplayLike, 'alias'>>,
): string {
  return model.alias ?? model.display_name;
}

export function modelDisplayWithProvider(
  model: ModelDisplayLike,
  providers: ProviderDisplayLike[],
): string {
  return `${modelBaseDisplayName(model)} · ${providerDisplayName(providers, model.provider_id)}`;
}
