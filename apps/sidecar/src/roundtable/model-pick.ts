/**
 * Pick a low-cost chat model to run as the topic analyzer / summarizer when
 * the user hasn't pinned one. Heuristic matches `model_name` substring against
 * a small allow-list (haiku / gpt-4o-mini / *flash*) and falls back to the
 * first eligible enabled chat model when no match exists.
 */

import type { Model } from '@taori/shared';
import type { ModelsRepo } from '../db/repos/index.js';
import type { MemoriesRepo } from '../db/repos/index.js';
import { ROUNDTABLE_MEMORY_KEYS } from '@taori/shared';

const CHEAP_FAMILIES = [
  'haiku',
  'gpt-4o-mini',
  'gpt-4.1-mini',
  'gpt-5-mini',
  'flash',
  'mini',
];

function isEligible(m: Model): boolean {
  if (!m.enabled) return false;
  if (m.demoted) return false;
  if (!m.provider_id) return false;
  if (m.disabled_until && m.disabled_until > Date.now()) return false;
  return m.capability === 'chat';
}

export function pickAnalyzerModel(
  modelsRepo: ModelsRepo,
  memoriesRepo: MemoriesRepo,
): Model | null {
  const all = modelsRepo.list().filter(isEligible);
  if (all.length === 0) return null;

  const pinned = memoriesRepo.get('global', null, ROUNDTABLE_MEMORY_KEYS.ANALYZER_MODEL);
  if (pinned) {
    const found = all.find((m) => m.id === pinned || m.alias === pinned);
    if (found) return found;
  }

  // 2. cheap family match
  const sorted = [...all].sort(
    (a, b) => (a.fallback_order ?? 0) - (b.fallback_order ?? 0),
  );
  for (const fam of CHEAP_FAMILIES) {
    const hit = sorted.find((m) => m.model_name.toLowerCase().includes(fam));
    if (hit) return hit;
  }

  // 3. first eligible
  return sorted[0] ?? null;
}

export function pickFallbackParticipantModels(
  modelsRepo: ModelsRepo,
  desiredCount: number,
): Model[] {
  const all = modelsRepo
    .list()
    .filter(isEligible)
    .sort((a, b) => (a.fallback_order ?? 0) - (b.fallback_order ?? 0));
  if (all.length === 0) return [];
  // Allow same model to fill multiple roles when fewer than desired exist.
  const out: Model[] = [];
  for (let i = 0; i < desiredCount; i++) out.push(all[i % all.length]!);
  return out;
}
