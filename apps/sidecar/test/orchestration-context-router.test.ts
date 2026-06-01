import { describe, expect, it } from 'vitest';
import { buildChatOrchestrationPlan } from '../src/orchestration/context-router.js';

function createMemories(defaultSearchToolName: string | null = 'builtin.web_search') {
  return {
    get() {
      return null;
    },
    getEffective(_conversationId: string | null, key: string) {
      return key === 'default_search_tool' ? defaultSearchToolName : null;
    },
  };
}

function createBus(toolNames = ['builtin.web_search', 'builtin.web_fetch']) {
  return {
    list() {
      return toolNames.map((name) => ({
        name,
        description: name === 'builtin.web_search' ? 'Search the public web' : 'Fetch a web page',
        capability: 'web',
        source: 'builtin',
        source_id: name,
        enabled: true,
      }));
    },
    get(name: string) {
      if (!toolNames.includes(name)) return undefined;
      return {
        name,
        description: name === 'builtin.web_search' ? 'Search the public web' : 'Fetch a web page',
        enabled: true,
      };
    },
  };
}

function plan(userText: string, opts: {
  hasConversationFiles?: boolean;
  defaultSearchToolName?: string | null;
  toolNames?: string[];
} = {}) {
  return buildChatOrchestrationPlan({
    bus: createBus(opts.toolNames) as never,
    memoriesRepo: createMemories(opts.defaultSearchToolName) as never,
    conversationId: 'conv_test',
    userText,
    hasConversationFiles: opts.hasConversationFiles ?? false,
  });
}

describe('orchestration context router', () => {
  it('routes high-stakes current education questions to search plus fetch', () => {
    const result = plan('深圳初升高，模拟考试522分，家住坂田，如果要报名，什么建议？');

    expect(result).toMatchObject({
      externalInfo: 'web_search_fetch',
      reason: 'high_stakes_current',
      searchToolName: 'builtin.web_search',
      fetchTopK: 2,
      citeRequired: true,
    });
    expect(result.queries[0]).toContain('深圳初升高');
  });

  it('routes fresh news questions to lightweight web search', () => {
    const result = plan('深圳最新的新闻');

    expect(result.externalInfo).toBe('web_search');
    expect(result.reason).toBe('freshness_required');
    expect(result.fetchTopK).toBe(0);
    expect(result.citeRequired).toBe(true);
  });

  it('routes evidence and recommendation questions to search plus fetch', () => {
    const result = plan('请对比几个模型管理方案，给出来源和推荐');

    expect(result.externalInfo).toBe('web_search_fetch');
    expect(result.reason).toBe('evidence_required');
    expect(result.fetchTopK).toBe(2);
  });

  it('detects local file context without forcing web search', () => {
    const result = plan('总结这份附件的主要观点', { hasConversationFiles: true });

    expect(result.localContext).toBe('file_search');
    expect(result.externalInfo).toBe('none');
    expect(result.reason).toBe('local_context_available');
    expect(result.searchToolName).toBeNull();
  });

  it('falls back when the configured search tool is unavailable', () => {
    const result = plan('请查一下 Taori 最新资料', {
      defaultSearchToolName: 'mcp.missing.search',
    });

    expect(result.searchToolName).toBe('builtin.web_search');
  });
});
