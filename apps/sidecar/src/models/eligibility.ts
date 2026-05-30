import { TaoriError, type Model, type Provider } from '@taori/shared';

export function isProviderRunnable(provider: Provider | null | undefined): provider is Provider {
  return Boolean(provider?.enabled);
}

export function assertProviderRunnableForModel(args: {
  model: Model;
  provider: Provider | null | undefined;
  actionLabel: string;
}): Provider {
  if (!args.provider) {
    throw new TaoriError({
      code: 'validation_error',
      message: `${args.actionLabel}失败：模型「${modelDisplayName(args.model)}」所属服务商不存在。`,
      can_retry: false,
      details: { model_id: args.model.id, provider_id: args.model.provider_id },
    });
  }
  if (!args.provider.enabled) {
    throw new TaoriError({
      code: 'validation_error',
      message: `${args.actionLabel}失败：模型「${modelDisplayName(args.model)}」所属服务商「${args.provider.name}」已停用，请先启用服务商或切换模型。`,
      can_retry: false,
      details: { model_id: args.model.id, provider_id: args.provider.id },
    });
  }
  return args.provider;
}

function modelDisplayName(model: Model): string {
  return model.alias ?? model.display_name ?? model.model_name ?? model.id;
}
