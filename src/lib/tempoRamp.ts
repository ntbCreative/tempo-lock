/**
 * Tempo ramp: a practice click track that steps its BPM up (or down) by a
 * fixed amount every N bars, from a starting tempo to a target, then holds.
 * Classic "start slow, build speed" practice tool.
 *
 * Pure math only -- no audio, no timers -- so the stepping and variable-
 * interval scheduling logic can be verified without an AudioContext.
 */

export interface TempoRampConfig {
  startBpm: number;
  targetBpm: number;
  /** BPM change applied at each step. Always given as a positive number; direction is inferred from start vs target. */
  bpmStep: number;
  /** How many bars to hold each tempo before stepping. */
  barsPerStep: number;
  beatsPerBar: number;
}

/** The tempo that should be playing during bar `barIndex` (0-indexed), stepping from startBpm toward targetBpm and holding once reached. */
export function bpmForBar(barIndex: number, config: TempoRampConfig): number {
  const { startBpm, targetBpm, bpmStep, barsPerStep } = config;
  if (startBpm === targetBpm || bpmStep <= 0 || barsPerStep <= 0) return startBpm;

  const steps = Math.floor(Math.max(0, barIndex) / barsPerStep);
  const direction = targetBpm > startBpm ? 1 : -1;
  const bpm = startBpm + direction * steps * bpmStep;

  return direction > 0 ? Math.min(bpm, targetBpm) : Math.max(bpm, targetBpm);
}

/**
 * Generate `count` click times (seconds, same clock as `startTimeSec`),
 * where the interval between clicks tracks whatever tempo `bpmForBar`
 * says should be playing at that point -- so the ramp actually changes
 * the click spacing, not just a displayed number.
 */
export function computeRampClickTimes(
  startTimeSec: number,
  startClickIndex: number,
  count: number,
  config: TempoRampConfig
): number[] {
  const times: number[] = [];
  let t = startTimeSec;
  const safeBeatsPerBar = config.beatsPerBar > 0 ? config.beatsPerBar : 1;

  for (let i = 0; i < count; i++) {
    times.push(t);
    const clickIndex = startClickIndex + i;
    const barIndex = Math.floor(clickIndex / safeBeatsPerBar);
    const bpm = bpmForBar(barIndex, config);
    t += 60 / bpm;
  }

  return times;
}

/** Given elapsed seconds since a ramp began, how many clicks have already occurred (equivalently, the index of the next upcoming click). Inverse of the spacing computeRampClickTimes produces; used to derive a live bar/beat position while a ramp session plays. */
export function clickIndexAtElapsedTime(elapsedSec: number, config: TempoRampConfig): number {
  if (elapsedSec <= 0) return 0;
  const safeBeatsPerBar = config.beatsPerBar > 0 ? config.beatsPerBar : 1;
  let t = 0; // cumulative time of click `index`
  let index = 0;
  // Bounded walk: even a long practice session is at most a few thousand clicks.
  for (let guard = 0; guard < 100000; guard++) {
    if (t > elapsedSec) break; // click `index` hasn't happened yet
    const barIndex = Math.floor(index / safeBeatsPerBar);
    const bpm = bpmForBar(barIndex, config);
    t += 60 / bpm;
    index += 1;
  }
  return index;
}

/** Whether the ramp has reached (and is now holding at) its target tempo by the given bar. */
export function hasReachedTarget(barIndex: number, config: TempoRampConfig): boolean {
  return bpmForBar(barIndex, config) === config.targetBpm;
}
