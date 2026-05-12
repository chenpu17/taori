import { describe, expect, it } from 'vitest';
import { isSearchToolLike, pickPreferredSearchToolName } from '../src/search/tool-selection.js';

describe('search tool selection', () => {
  it('does not treat ai_search tools as structured search candidates', () => {
    expect(
      isSearchToolLike(
        'mcp.server.bocha_ai_search',
        'Search with Bocha AI Search and return structured modal cards',
      ),
    ).toBe(false);
    expect(
      isSearchToolLike(
        'mcp.server.bocha_web_search',
        'Search with Bocha Web Search and get titles, urls, and summaries',
      ),
    ).toBe(true);
  });

  it('falls back to builtin web search when default search tool is not a supported evidence search tool', () => {
    const descriptors = new Map([
      ['builtin.web_search', { name: 'builtin.web_search', description: 'web search', enabled: true }],
      ['mcp.server.bocha_ai_search', { name: 'mcp.server.bocha_ai_search', description: 'ai search', enabled: true }],
    ]);
    const bus = {
      get(name: string) {
        return descriptors.get(name) ?? null;
      },
    };

    expect(
      pickPreferredSearchToolName(bus as never, 'mcp.server.bocha_ai_search', [
        'mcp.server.bocha_ai_search',
        'builtin.web_search',
      ]),
    ).toBe('builtin.web_search');
  });
});
