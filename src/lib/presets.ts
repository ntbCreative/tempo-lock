/**
 * Named presets: a saved snapshot of the settings for one song, so a
 * gigging/teaching drummer can jump straight to "Song A: 128 BPM, 2&4 clap"
 * instead of re-dialing every control between numbers.
 *
 * Pure list operations only -- persistence (localStorage) and what fields
 * a preset actually captures are the caller's concern; this module just
 * manages the named list safely (unique ids, no accidental duplicates).
 */

export interface Preset<T> {
  id: string;
  name: string;
  data: T;
  /** When the preset was created or last updated, ms since epoch. Informational only. */
  updatedAt: number;
}

function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Add a new preset, appended to the end of the list. */
export function addPreset<T>(presets: Preset<T>[], name: string, data: T, nowMs: number): Preset<T>[] {
  return [...presets, { id: generateId(), name: name.trim(), data, updatedAt: nowMs }];
}

/** Overwrite an existing preset's data/name in place, by id. No-op if the id isn't found. */
export function updatePreset<T>(presets: Preset<T>[], id: string, name: string, data: T, nowMs: number): Preset<T>[] {
  return presets.map((preset) => (preset.id === id ? { ...preset, name: name.trim(), data, updatedAt: nowMs } : preset));
}

/** Remove a preset by id. No-op if the id isn't found. */
export function deletePreset<T>(presets: Preset<T>[], id: string): Preset<T>[] {
  return presets.filter((preset) => preset.id !== id);
}

/** Find a preset by id, or undefined if not present. */
export function findPreset<T>(presets: Preset<T>[], id: string): Preset<T> | undefined {
  return presets.find((preset) => preset.id === id);
}

/** Whether a name is already used by another preset (case-insensitive). Pass the current preset's id to exclude it when renaming. */
export function isNameTaken<T>(presets: Preset<T>[], name: string, excludeId?: string): boolean {
  const normalized = name.trim().toLowerCase();
  if (!normalized) return false;
  return presets.some((preset) => preset.id !== excludeId && preset.name.trim().toLowerCase() === normalized);
}
