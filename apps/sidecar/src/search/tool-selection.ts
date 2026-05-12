import type { CapabilityBus } from '../bus/index.js';

export function isSearchToolLike(name: string, description?: string | null): boolean {
  if (name === 'builtin.web_search') return true;
  if (name === 'builtin.file_search') return false;
  if (/(^|[\s._-])ai_search([\s._-]|$)/i.test(name)) return false;
  const haystack = `${name} ${description ?? ''}`.toLowerCase();
  return /(^|[\s._-])(search|websearch|retrieval)([\s._-]|$)/.test(haystack) || /搜索|检索/.test(haystack);
}

export function pickPreferredSearchToolName(
  bus: CapabilityBus | null | undefined,
  defaultSearchToolName: string | null | undefined,
  names: string[],
): string | null {
  const candidates = names.filter((name) => {
    const descriptor = bus?.get(name);
    return descriptor ? descriptor.enabled && isSearchToolLike(descriptor.name, descriptor.description) : false;
  });
  if (candidates.length === 0) return null;
  if (defaultSearchToolName && candidates.includes(defaultSearchToolName)) {
    return defaultSearchToolName;
  }
  if (candidates.includes('builtin.web_search')) {
    return 'builtin.web_search';
  }
  return candidates[0] ?? null;
}

export function applyPreferredSearchToolSelection(
  bus: CapabilityBus | null | undefined,
  defaultSearchToolName: string | null | undefined,
  names: string[],
): string[] {
  const selected = pickPreferredSearchToolName(bus, defaultSearchToolName, names);
  if (!selected) return names;
  return names.filter((name) => {
    const descriptor = bus?.get(name);
    return !descriptor || !isSearchToolLike(descriptor.name, descriptor.description) || name === selected;
  });
}
