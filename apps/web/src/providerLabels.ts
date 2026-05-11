import type { Provider } from '@taori/shared';

type ProviderLabelLike = Pick<Provider, 'type' | 'name' | 'base_url'>;

export interface CompatProviderTemplate {
  id: 'aliyun-bailian' | 'zhipu-glm' | 'minimax' | 'kimi';
  label: string;
  providerName: string;
  baseUrl: string;
  hint: string;
}

const PROVIDER_TYPE_LABELS: Record<string, string> = {
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  ollama: 'Ollama',
  custom: '自定义兼容',
  replicate: 'Replicate',
  sd_webui: 'SD WebUI',
  volcengine_ark: '火山方舟',
  huawei_maas: '华为云 MaaS',
  deepseek: 'DeepSeek',
  packyapi: 'PackyAPI',
  siliconflow: '硅基流动',
};

export const CUSTOM_COMPAT_PROVIDER_TEMPLATES: CompatProviderTemplate[] = [
  {
    id: 'aliyun-bailian',
    label: '阿里云百炼',
    providerName: '阿里云百炼',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    hint: '适合通义 / Qwen 系列，按 OpenAI 兼容方式接入。',
  },
  {
    id: 'zhipu-glm',
    label: '智谱 GLM',
    providerName: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    hint: 'GLM-5.x / GLM-4.x 官方兼容端点。',
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    providerName: 'MiniMax',
    baseUrl: 'https://api.minimax.chat/v1',
    hint: 'MiniMax 官方 OpenAI 兼容端点。',
  },
  {
    id: 'kimi',
    label: 'Kimi',
    providerName: 'Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    hint: '月之暗面 / Moonshot 官方兼容端点。',
  },
];

function inferCustomProviderLabel(provider: ProviderLabelLike): string | null {
  if (provider.type !== 'custom') return null;
  const haystack = `${provider.name ?? ''} ${provider.base_url ?? ''}`.toLocaleLowerCase();
  if (haystack.includes('dashscope.aliyuncs.com') || haystack.includes('阿里') || haystack.includes('百炼')) {
    return '阿里云百炼';
  }
  if (haystack.includes('bigmodel.cn') || haystack.includes('智谱') || haystack.includes('glm')) {
    return '智谱 GLM';
  }
  if (haystack.includes('minimax')) {
    return 'MiniMax';
  }
  if (haystack.includes('moonshot') || haystack.includes('kimi')) {
    return 'Kimi';
  }
  return null;
}

export function providerTypeDisplay(provider: ProviderLabelLike): string {
  return inferCustomProviderLabel(provider) ?? PROVIDER_TYPE_LABELS[provider.type] ?? provider.type;
}
