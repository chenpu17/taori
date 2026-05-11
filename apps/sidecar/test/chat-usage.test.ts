import { describe, expect, it } from 'vitest';
import {
  extractCachedPromptTokensFromOpenAiUsage,
  extractCachedPromptTokensFromProviderMetadata,
} from '../src/chat/usage.js';

describe('chat usage helpers', () => {
  it('reads cached prompt tokens from provider metadata', () => {
    expect(
      extractCachedPromptTokensFromProviderMetadata({
        openai: { cachedPromptTokens: 321 },
      }),
    ).toBe(321);
  });

  it('returns null when provider metadata lacks cached prompt tokens', () => {
    expect(extractCachedPromptTokensFromProviderMetadata({ openai: {} })).toBeNull();
    expect(extractCachedPromptTokensFromProviderMetadata(null)).toBeNull();
  });

  it('reads cached prompt tokens from raw OpenAI usage payloads', () => {
    expect(
      extractCachedPromptTokensFromOpenAiUsage({
        prompt_tokens_details: { cached_tokens: 128 },
      }),
    ).toBe(128);
  });

  it('returns null when raw usage payload lacks cached prompt tokens', () => {
    expect(extractCachedPromptTokensFromOpenAiUsage({ prompt_tokens_details: {} })).toBeNull();
    expect(extractCachedPromptTokensFromOpenAiUsage(undefined)).toBeNull();
  });
});
