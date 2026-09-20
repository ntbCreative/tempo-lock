/**
 * A live, real-time "feel" toggle for a running click track: half-time
 * (fewer audible clicks) or double-time (more, evenly inserted), without
 * changing the underlying tempo, bar/beat structure, or accent pattern,
 * and without restarting or phase-jumping the click. Deliberately simpler
 * than a full subdivision editor (no 16ths/32nds) -- just three states:
 * half, normal, double.
 *
 * Double-time is implemented by inserting one extra evenly-spaced tick
 * per beat (structurally identical to an eighth-note subdivision, just
 * live-toggleable rather than a fixed setting). Half-time is implemented
 * by muting every other beat entirely, at the beat level -- there's no
 * meaningful way to have "half a tick" within a single beat, so
 * half-time necessarily works differently from double-time.
 */

export type FeelMultiplier = 0.5 | 1 | 2;

export const FEEL_OPTIONS: { label: string; value: FeelMultiplier }[] = [
  { label: '½×', value: 0.5 },
  { label: '1×', value: 1 },
  { label: '2×', value: 2 },
];

/**
 * How many ticks make up one nominal beat, given a base (static)
 * subdivision tick count and a live feel multiplier layered on top.
 * Only feel=2 changes this (adds one extra tick per beat); feel=0.5
 * doesn't change tick count at all -- see `stepHalfTimeParity`.
 */
export function effectiveTicksPerBeat(baseTicksPerBeat: number, feel: FeelMultiplier): number {
  const safeBase = baseTicksPerBeat > 0 ? baseTicksPerBeat : 1;
  return feel === 2 ? safeBase * 2 : safeBase;
}

/**
 * Advances a 0/1 parity counter used to mute every other beat for
 * half-time feel. Call this once per beat (not per sub-tick). Returns
 * whether *this* beat should be muted, plus the parity to carry into the
 * next beat. When feel isn't 0.5, always returns mute: false and leaves
 * parity untouched, so switching back to normal feel mid-cycle doesn't
 * leave a stale parity that causes an unexpected mute the next time
 * half-time is re-engaged.
 */
export function stepHalfTimeParity(parity: 0 | 1, feel: FeelMultiplier): { mute: boolean; nextParity: 0 | 1 } {
  if (feel !== 0.5) return { mute: false, nextParity: parity };
  return { mute: parity === 1, nextParity: parity === 0 ? 1 : 0 };
}
