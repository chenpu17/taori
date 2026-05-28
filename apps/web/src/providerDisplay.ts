/** Palette for hashing unknown providers to distinct colors. */
const PROVIDER_COLORS = [
  'var(--m-sonnet)', 'var(--m-gpt)', 'var(--m-deepseek)', 'var(--m-gemini)',
  '#f472b6', '#34d399', '#fbbf24', '#a78bfa', '#fb923c',
];

/** Deterministic color from a string hash. */
function hashColor(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return PROVIDER_COLORS[Math.abs(h) % PROVIDER_COLORS.length];
}

/** Map a provider type (and optionally name) to an identity color. */
export function providerColor(type?: string | null, name?: string | null): string {
  switch (type) {
    case 'anthropic': return 'var(--m-sonnet)';
    case 'openai': return 'var(--m-gpt)';
    case 'openrouter': return 'var(--m-deepseek)';
    case 'google': return 'var(--m-gemini)';
    default: return name ? hashColor(name) : 'var(--m-taori)';
  }
}
