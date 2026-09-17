/**
 * "Start a metronome after N bars" logic.
 *
 * The idea: the player plays steadily, the detector settles on a tempo, and
 * once that tempo has held for a chosen number of bars, a click track kicks
 * in at that exact tempo -- phase-aligned to the moment it settled, not to
 * whenever the trigger check happens to run.
 *
 * Deliberately keys off the *displayed BPM value* rather than the
 * detector's confidence label ('locked' vs 'low-confidence'). In a real
 * band mix, confidence dips constantly -- other instruments, room noise,
 * a cymbal decaying -- even while the actual tempo reading stays rock
 * steady. Resetting the countdown on every confidence wobble would mean
 * it almost never completes outside a silent room. Instead, progress only
 * resets on a genuine change: the BPM reading drifting away from where the
 * countdown started, or the detector losing the tempo entirely.
 *
 * This module is pure (no audio, no timers): it just decides *when* the
 * metronome should start and at what BPM, given a stream of (bpm, time)
 * snapshots. `src/audio/metronomeEngine.ts` is the only place that turns
 * that decision into actual sound.
 */

export type BarCount = 0 | 1 | 2 | 4; // 0 = feature off

export interface BarCountdownConfig {
  barsRequired: BarCount;
  beatsPerBar: number;
  /** Relative BPM drift from the countdown's starting tempo treated as a genuine tempo change (resets and restarts the countdown) rather than noise. */
  driftTolerance: number;
}

export const DEFAULT_BAR_COUNTDOWN_CONFIG: BarCountdownConfig = {
  barsRequired: 0,
  beatsPerBar: 4,
  driftTolerance: 0.08,
};

export interface BarCountdownState {
  /** Wall-clock time (seconds) the current countdown began, or null if not currently counting. */
  lockStartTimeSec: number | null;
  /** BPM at the moment the countdown began; frozen for its duration so the target duration doesn't shift under drift. */
  lockStartBpm: number | null;
  /** Whether the metronome has already been triggered for this countdown. */
  triggered: boolean;
}

export function createBarCountdownState(): BarCountdownState {
  return { lockStartTimeSec: null, lockStartBpm: null, triggered: false };
}

export interface BarCountdownResult {
  state: BarCountdownState;
  /** True exactly once, on the update where the countdown completes. */
  shouldStartMetronome: boolean;
  /** When shouldStartMetronome is true: the phase-aligned time the first click should land. */
  metronomeStartTimeSec: number | null;
  /** When shouldStartMetronome is true: the BPM to play the metronome at. */
  metronomeBpm: number | null;
}

function noTrigger(state: BarCountdownState): BarCountdownResult {
  return { state, shouldStartMetronome: false, metronomeStartTimeSec: null, metronomeBpm: null };
}

/**
 * Advance the countdown by one detector snapshot: the currently displayed
 * BPM (null if the detector hasn't settled on a tempo at all yet) and the
 * current wall-clock time (seconds).
 */
export function updateBarCountdown(
  state: BarCountdownState,
  displayedBpm: number | null,
  nowSec: number,
  configOverrides: Partial<BarCountdownConfig> = {}
): BarCountdownResult {
  const cfg = { ...DEFAULT_BAR_COUNTDOWN_CONFIG, ...configOverrides };

  if (cfg.barsRequired === 0 || displayedBpm === null) {
    // Feature off, or no tempo reading at all: reset the countdown.
    return noTrigger(createBarCountdownState());
  }

  if (state.lockStartTimeSec === null) {
    // A tempo reading just appeared: start the countdown.
    return noTrigger({ lockStartTimeSec: nowSec, lockStartBpm: displayedBpm, triggered: false });
  }

  if (state.triggered) {
    // Already fired for this countdown; stay put until it's reset (start/stop).
    return noTrigger(state);
  }

  const startBpm = state.lockStartBpm ?? displayedBpm;
  const drift = Math.abs(displayedBpm - startBpm) / startBpm;
  if (drift > cfg.driftTolerance) {
    // A genuine tempo change, not just noise: restart the countdown at the new tempo.
    return noTrigger({ lockStartTimeSec: nowSec, lockStartBpm: displayedBpm, triggered: false });
  }

  const beatIntervalSec = 60 / startBpm;
  const requiredDurationSec = beatIntervalSec * cfg.beatsPerBar * cfg.barsRequired;
  const elapsed = nowSec - state.lockStartTimeSec;

  if (elapsed >= requiredDurationSec) {
    const startTimeSec = state.lockStartTimeSec + requiredDurationSec;
    return {
      state: { ...state, triggered: true },
      shouldStartMetronome: true,
      metronomeStartTimeSec: startTimeSec,
      metronomeBpm: startBpm,
    };
  }

  return noTrigger(state);
}

/**
 * Compute the next `count` click times (seconds, same clock as `startTimeSec`)
 * for a steady metronome at `bpm` starting at `startTimeSec`. Pure so the
 * scheduling math can be tested without an AudioContext.
 */
export function computeClickTimes(startTimeSec: number, bpm: number, count: number): number[] {
  const beatIntervalSec = 60 / bpm;
  return Array.from({ length: count }, (_, i) => startTimeSec + i * beatIntervalSec);
}

/** Whether click index `i` (0-based) is the first beat of a bar, for accenting. */
export function isDownbeat(clickIndex: number, beatsPerBar: number): boolean {
  return clickIndex % beatsPerBar === 0;
}

export interface SessionPosition {
  clickIndex: number;
  /** 0-indexed bar number. */
  barIndex: number;
  /** 0-indexed beat within the bar. */
  beatInBar: number;
  /** Bars left including the current one, or null when the session has no fixed length. */
  remainingBars: number | null;
  /** True once the click has reached the end of a fixed-length session. */
  finished: boolean;
}

/**
 * Where a finite (or unlimited) click-track session is at, given how many
 * clicks have played so far. `totalBars` of 0 means "no fixed length" --
 * runs until manually stopped, and `remainingBars`/`finished` reflect that.
 * Pure so a UI position readout (bar/beat/remaining) can be computed and
 * tested without touching the audio engine.
 */
export function computeSessionPosition(clickIndex: number, beatsPerBar: number, totalBars: number): SessionPosition {
  const safeBeatsPerBar = beatsPerBar > 0 ? beatsPerBar : 1;
  const barIndex = Math.floor(clickIndex / safeBeatsPerBar);
  const beatInBar = clickIndex % safeBeatsPerBar;
  const finished = totalBars > 0 && barIndex >= totalBars;
  const remainingBars = totalBars > 0 ? Math.max(0, totalBars - barIndex) : null;
  return { clickIndex, barIndex, beatInBar, remainingBars, finished };
}
