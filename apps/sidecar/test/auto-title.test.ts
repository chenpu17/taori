/**
 * V2b — conversation auto-title helpers.
 *
 * Covers the two pure functions that decide the immediate title and clean up the
 * model output. The async generation path (model pick / keystore / generateText)
 * mirrors memory extraction and is verified end-to-end in the preview.
 */
import { describe, it, expect } from 'vitest';
import { computeAutoTitle, sanitizeTitle } from '../src/chat/auto-title.js';

describe('computeAutoTitle', () => {
  it('keeps short text as-is', () => {
    expect(computeAutoTitle('你好')).toBe('你好');
    expect(computeAutoTitle('帮我介绍量子计算')).toBe('帮我介绍量子计算');
  });

  it('collapses whitespace', () => {
    expect(computeAutoTitle('  hello   world  ')).toBe('hello world');
    expect(computeAutoTitle('a\n\nb\tc')).toBe('a b c');
  });

  it('truncates beyond 30 chars with an ellipsis', () => {
    const long = '一'.repeat(40);
    const out = computeAutoTitle(long);
    expect(out).toBe('一'.repeat(30) + '…');
    expect(out.length).toBe(31); // 30 + ellipsis
  });
});

describe('sanitizeTitle', () => {
  it('strips wrapping quotes and brackets', () => {
    expect(sanitizeTitle('"量子计算介绍"')).toBe('量子计算介绍');
    expect(sanitizeTitle('「周末计划」')).toBe('周末计划');
    expect(sanitizeTitle('《数据库设计》')).toBe('数据库设计');
    expect(sanitizeTitle("'Refactor tips'")).toBe('Refactor tips');
  });

  it('drops a 标题/title prefix', () => {
    expect(sanitizeTitle('标题：重构建议')).toBe('重构建议');
    expect(sanitizeTitle('Title: Refactor tips')).toBe('Refactor tips');
  });

  it('drops leading markdown heading marks', () => {
    expect(sanitizeTitle('## 数据库设计')).toBe('数据库设计');
  });

  it('strips trailing punctuation', () => {
    expect(sanitizeTitle('量子计算。')).toBe('量子计算');
    expect(sanitizeTitle('周末计划！')).toBe('周末计划');
  });

  it('collapses internal whitespace', () => {
    expect(sanitizeTitle('  数据库   设计  ')).toBe('数据库 设计');
  });

  it('caps length at 24 chars', () => {
    const out = sanitizeTitle('标题：' + '词'.repeat(40));
    expect(out.length).toBe(24);
  });

  it('handles combined noise', () => {
    expect(sanitizeTitle('### 标题：「桌面 AI 助手市场趋势」。')).toBe('桌面 AI 助手市场趋势');
  });
});
