function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function extractCachedPromptTokensFromProviderMetadata(metadata: unknown): number | null {
  const provider = asRecord(metadata);
  const openai = asRecord(provider?.openai);
  const cached = openai?.cachedPromptTokens;
  return typeof cached === 'number' ? cached : null;
}

export function extractCachedPromptTokensFromOpenAiUsage(usage: unknown): number | null {
  const usageRecord = asRecord(usage);
  const details = asRecord(usageRecord?.prompt_tokens_details);
  const cached = details?.cached_tokens;
  return typeof cached === 'number' ? cached : null;
}
