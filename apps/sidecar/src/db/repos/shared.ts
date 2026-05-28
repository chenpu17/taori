/**
 * Shared helpers and type aliases used across per-Repo files.
 */

export function pickDefined<T extends object, K extends keyof T>(
  input: T,
  keys: readonly K[],
): Partial<Pick<T, K>> {
  const out: Partial<Pick<T, K>> = {};
  for (const key of keys) {
    if (input[key] !== undefined) out[key] = input[key];
  }
  return out;
}

export function isForeignKeyConstraintError(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  if (code === 'SQLITE_CONSTRAINT_FOREIGNKEY') return true;
  const message = err instanceof Error ? err.message : String(err);
  return /FOREIGN KEY constraint failed/i.test(message);
}
