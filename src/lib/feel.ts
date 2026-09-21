/**
 * A live, real-time "feel" multiplier for a running click track: each
 * press of 2x doubles the audible click rate again (1x -> 2x -> 4x -> 8x),
 * each press of 1/2x halves it again (1x -> 0.5x -> 0.25x -> 0.125x) --
 * without changing the underlying tempo, bar/beat structure, or accent
 * pattern, and without restarting or phase-jumping the click. Clamped to a
 * sane range rather than genuinely unbounded, since well past that the
 * result stops being musically meaningful.
 *
 * >=1x is implemented by inserting extra evenly-spaced ticks per beat
 * (structurally identical to an eighth/sixteenth-note subdivision, just
 * live-adjustable rather than a fixed setting). <1x is implemented by
 * muting all but one beat out of every N-beat cycle -- there's no
 * meaningful way to have "a fraction of a tick" within a single beat, so
 * slower-than-1x necessarily works differently from faster-than-1x.
 */

export type FeelMultiplier = number;

export const MIN_FEEL: FeelMultiplier = 0.125;
export const MAX_FEEL: FeelMultiplier = 8;

export const DEFAULT_FEEL: FeelMultiplier = 1;

/** Doubles the feel, capped at MAX_FEEL. */
export function doubleFeel(feel: FeelMultiplier): FeelMultiplier {
  return Math.min(MAX_FEEL, feel * 2);
}

/** Halves the feel, floored at MIN_FEEL. */
export function halveFeel(feel: FeelMultiplier): FeelMultiplier {
  return Math.max(MIN_FEEL, feel / 2);
}

/**
 * How many ticks make up one nominal beat, given a base (static)
 * subdivision tick count and a live feel multiplier layered on top.
 * Only feel >= 1 changes this; feel < 1 doesn't change tick count at all
 * -- see `stepBeatCycle`.
 */
export function effectiveTicksPerBeat(baseTicksPerBeat: number, feel: FeelMultiplier): number {
  const safeBase = baseTicksPerBeat > 0 ? baseTicksPerBeat : 1;
  return feel >= 1 ? Math.round(safeBase * feel) : safeBase;
}

/** How many beats make up one mute/play cycle for a sub-1x feel (e.g. 0.25x -> a 4-beat cycle, playing 1 of every 4). 1 for feel >= 1, where this concept doesn't apply. */
export function beatsPerCycle(feel: FeelMultiplier): number {
  return feel < 1 ? Math.round(1 / feel) : 1;
}

/**
 * Advances a 0..N-1 beat-cycle counter for a sub-1x feel, muting every
 * beat except the first of each cycle. Call this once per beat (not per
 * sub-tick). Returns whether *this* beat should be muted, plus the
 * counter to carry into the next beat. When feel isn't < 1, always
 * returns mute: false and leaves the counter untouched, so switching back
 * to 1x (or faster) mid-cycle and later re-engaging a slower feel doesn't
 * leave a stale counter that causes an unexpected mute.
 */
export function stepBeatCycle(counter: number, feel: FeelMultiplier): { mute: boolean; nextCounter: number } {
  if (feel >= 1) return { mute: false, nextCounter: counter };
  const cycle = beatsPerCycle(feel);
  const mute = counter !== 0;
  const nextCounter = (counter + 1) % cycle;
  return { mute, nextCounter };
}
