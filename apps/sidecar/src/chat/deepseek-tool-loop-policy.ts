import type { Provider } from '@taori/shared';

const DEEPSEEK_TOOL_LOOP_MODELS = new Set([
  'deepseek-v4-flash',
  'deepseek-v4-pro',
]);

export function shouldUseDeepSeekToolLoop(
  provider: Provider | null,
  modelName: string,
  supportsTools: boolean,
): boolean {
  if (!supportsTools) return false;
  if (provider?.type === 'deepseek') return true;
  return DEEPSEEK_TOOL_LOOP_MODELS.has(modelName.trim().toLowerCase());
}
