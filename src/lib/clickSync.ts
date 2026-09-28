/**
 * Re-syncing a running click to a tap on beat 1.
 *
 * The player presses a button on their downbeat; the click's grid slides so
 * one of its own downbeats lands exactly on that tap. Tempo is untouched --
 * this is a pure phase (and bar-position) correction, for when a click that
 * started slightly off, or drifted, needs to snap back onto the player.
 *
 * Pure so the tricky parts are testable: the scheduler queues ticks ~100ms
 * ahead into the audio graph, and those can't be recalled. Sliding the grid
 * EARLIER can therefore put the next tick before -- or nearly on top of -- one
 * that is already queued, which would sound as a doubled click (a flam), and
 * a tick whose time has already passed would just be dropped. So after the
 * slide, ticks are skipped (silently, advancing the counters exactly as the
 * scheduler would) until the next one is safely in the future and clear of
 * the last one queued. That costs at most a click or two at the moment of the
 * correction and keeps everything after it exactly on the new grid.
 */

/** Where the click scheduler is in its grid. Mirrors the engine's own counters. */
export interface ClickPhase {
  /** Time (perf seconds) of the next tick the scheduler will process. */
  nextTickTimeSec: number;
  /** Which sub-tick of its beat that tick is (0 = a main beat). */
  nextSubTick: number;
  /** Ticks per beat (subdivision x feel). */
  ticksPerBeat: number;
  /** Session-wide beat counter of the next tick (0-based; bar position = index mod beatsPerBar). */
  nextClickIndex: number;
  bpm: number;
  beatsPerBar: number;
}

export interface SyncOptions {
  nowSec: number;
  /** Time of the most recently queued tick, or null if none yet. */
  lastTickTimeSec: number | null;
  /** The next tick must be at least this far after `nowSec`. */
  minLeadSec: number;
}

export interface SyncResult {
  phase: ClickPhase;
  /** How far the grid moved (seconds, + = later). Within half a beat. */
  shiftSec: number;
  /** Ticks skipped to keep the next one safely in the future and clear of the last queued. */
  skippedTicks: number;
}

/**
 * Slide the click's grid so that the main beat nearest `tapTimeSec` lands
 * exactly on it, and make that beat a downbeat (bar position 0).
 */
export function syncDownbeatToTap(phase: ClickPhase, tapTimeSec: number, opts: SyncOptions): SyncResult {
  const periodSec = 60 / phase.bpm;
  const tickSec = periodSec / phase.ticksPerBeat;
  const bar = Math.max(1, Math.round(phase.beatsPerBar));

  // The next main beat the scheduler will reach (may be the very next tick).
  const ticksToBeat = (phase.ticksPerBeat - phase.nextSubTick) % phase.ticksPerBeat;
  const nextBeatTimeSec = phase.nextTickTimeSec + ticksToBeat * tickSec;
  const nextBeatIndex = phase.nextClickIndex + (phase.nextSubTick === 0 ? 0 : 1);

  // The main beat nearest the tap (possibly already played -- only the
  // grid's phase matters, and future ticks all derive from it).
  const j = Math.round((tapTimeSec - nextBeatTimeSec) / periodSec);
  const nearestBeatTimeSec = nextBeatTimeSec + j * periodSec;
  const nearestBeatIndex = nextBeatIndex + j;
  const shiftSec = tapTimeSec - nearestBeatTimeSec;

  // Renumber so that beat is a downbeat, moving the fewest beats.
  const pastDownbeat = ((nearestBeatIndex % bar) + bar) % bar;
  let indexShift = pastDownbeat === 0 ? 0 : pastDownbeat <= bar / 2 ? -pastDownbeat : bar - pastDownbeat;
  if (phase.nextClickIndex + indexShift < 0) indexShift += bar;

  let timeSec = phase.nextTickTimeSec + shiftSec;
  let subTick = phase.nextSubTick;
  let index = phase.nextClickIndex + indexShift;

  const earliestSec = Math.max(
    opts.nowSec + opts.minLeadSec,
    opts.lastTickTimeSec !== null ? opts.lastTickTimeSec + 0.5 * tickSec : -Infinity
  );
  let skippedTicks = 0;
  while (timeSec < earliestSec && skippedTicks < 1000) {
    timeSec += tickSec;
    subTick += 1;
    if (subTick >= phase.ticksPerBeat) {
      subTick = 0;
      index += 1;
    }
    skippedTicks += 1;
  }

  return {
    phase: { ...phase, nextTickTimeSec: timeSec, nextSubTick: subTick, nextClickIndex: index },
    shiftSec,
    skippedTicks,
  };
}

/**
 * Convert a DOM event timestamp into perf seconds. `event.timeStamp` is the
 * time the OS stamped the touch -- much closer to when the finger landed than
 * the moment a handler happens to run -- but on some browsers it is not in
 * the performance.now() timebase, so anything implausible falls back to now.
 */
export function eventTimeToPerfSec(eventTimeStampMs: number, nowMs: number): number {
  const plausible = Number.isFinite(eventTimeStampMs) && eventTimeStampMs <= nowMs + 50 && eventTimeStampMs >= nowMs - 2000;
  return (plausible ? eventTimeStampMs : nowMs) / 1000;
}
