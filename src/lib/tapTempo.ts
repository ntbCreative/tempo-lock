/**
 * Tap Tempo: derive a BPM from a series of manual taps, independent of the
 * microphone detector. Pure and stateless-in/stateless-out so the UI just
 * threads state through it.
 */

export interface TapTempoConfig {
  minBpm: number;
  maxBpm: number;
  /** How many of the most recent taps to keep/consider. */
  maxTaps: number;
  /** A gap longer than this (seconds) since the last tap starts a fresh sequence. */
  resetGapSeconds: number;
}

export const DEFAULT_TAP_TEMPO_CONFIG: TapTempoConfig = {
  minBpm: 40,
  maxBpm: 240,
  maxTaps: 8,
  resetGapSeconds: 2,
};

export interface TapTempoState {
  tapTimesSec: number[];
  bpm: number | null;
}

export function createTapTempoState(): TapTempoState {
  return { tapTimesSec: [], bpm: null };
}

export const resetTapTempo = createTapTempoState;

/** Median of a sorted-in-place-safe array. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Register one tap at `nowSec` and return the updated state (with recalculated bpm). */
export function registerTap(
  state: TapTempoState,
  nowSec: number,
  configOverrides: Partial<TapTempoConfig> = {}
): TapTempoState {
  const cfg = { ...DEFAULT_TAP_TEMPO_CONFIG, ...configOverrides };

  let taps = state.tapTimesSec;
  if (taps.length > 0 && nowSec - taps[taps.length - 1] > cfg.resetGapSeconds) {
    taps = [];
  }
  taps = [...taps, nowSec].slice(-cfg.maxTaps);

  if (taps.length < 2) {
    return { tapTimesSec: taps, bpm: null };
  }

  const intervals: number[] = [];
  for (let i = 1; i < taps.length; i++) {
    intervals.push(taps[i] - taps[i - 1]);
  }

  // Trim the single fastest and slowest interval when we have enough taps,
  // so one mis-timed tap doesn't skew the result; fall back to plain median
  // for short sequences.
  const trimmed =
    intervals.length >= 4
      ? [...intervals].sort((a, b) => a - b).slice(1, -1)
      : intervals;

  const medianInterval = median(trimmed);
  if (medianInterval <= 0) {
    return { tapTimesSec: taps, bpm: state.bpm };
  }

  const bpm = Math.min(cfg.maxBpm, Math.max(cfg.minBpm, 60 / medianInterval));
  return { tapTimesSec: taps, bpm };
}
