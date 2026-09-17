/**
 * Pure logic for restoring persisted settings from a raw string (as read
 * from localStorage). Kept separate from the actual storage calls so the
 * parsing/merging behavior is testable without touching localStorage.
 */

/**
 * Parse `raw` as JSON and shallow-merge it over `defaults`. Falls back to
 * `defaults` untouched if `raw` is null, isn't valid JSON, or isn't a
 * plain object -- so a corrupted or outdated stored value never crashes
 * the app or produces a half-broken settings object.
 */
export function parseStoredSettings<T extends object>(raw: string | null, defaults: T): T {
  if (!raw) return defaults;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return defaults;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return defaults;
  }
  return { ...defaults, ...(parsed as Partial<T>) };
}

export function serializeSettings<T>(value: T): string {
  return JSON.stringify(value);
}
