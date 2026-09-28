import type { BeatGrid } from './types';

/**
 * Placing a click onto the player's own beat grid.
 *
 * A fitted grid (see tempoRefine.ts) says where beats fall: beat k is at
 * `referenceBeatSec + k * periodSec`. That is a far better source for "when
 * should the click land" than anchoring to one detected hit plus a
 * count-in's worth of the first tempo reading:
 *
 *  - Phase comes from a regression across every on-grid onset, so one hit's
 *    timing jitter (or a detector bias on that one hit) no longer becomes
 *    the click's phase.
 *  - The period is the best available at trigger time, not the least precise
 *    reading from the moment a tempo first appeared -- which matters because
 *    period error is multiplied by however many beats lie between the
 *    reference and the start.
 *
 * Which beat counts as "1" is still a musical assumption, unchanged from
 * before: the first hit played is beat 1. The grid only makes the *timing*
 * of the chosen beat precise; it never decides which beat that is.
 */

/** Time (same base as the grid) of beat number `index` on the grid. */
export function beatTimeAt(grid: BeatGrid, index: number): number {
  return grid.referenceBeatSec + index * grid.periodSec;
}

/** The integer beat number whose grid time is closest to `timeSec`. */
export function nearestBeatIndex(grid: BeatGrid, timeSec: number): number {
  return Math.round((timeSec - grid.referenceBeatSec) / grid.periodSec);
}

/**
 * Count-in start: the downbeat `bars` bars after the beat nearest the anchor
 * onset (taken as beat 1). Returns the grid time of that downbeat.
 */
export function countInStartOnGrid(grid: BeatGrid, anchorSec: number, bars: number, beatsPerBar: number): number {
  const anchorIndex = nearestBeatIndex(grid, anchorSec);
  return beatTimeAt(grid, anchorIndex + bars * beatsPerBar);
}

/**
 * Free-running start: the first downbeat (a beat a whole number of bars from
 * the anchor's beat) that is at least `minLeadSec` after `nowSec`. The lead
 * guarantees the click is scheduled into the future -- if the target were
 * already past, the first click would have to be played late.
 */
export function nextDownbeatOnGrid(
  grid: BeatGrid,
  anchorSec: number,
  nowSec: number,
  beatsPerBar: number,
  minLeadSec: number
): number {
  const bar = Math.max(1, Math.round(beatsPerBar));
  const anchorIndex = nearestBeatIndex(grid, anchorSec);
  const earliestIndex = Math.ceil((nowSec + minLeadSec - grid.referenceBeatSec) / grid.periodSec);
  const beatsPastDownbeat = (((earliestIndex - anchorIndex) % bar) + bar) % bar;
  const index = beatsPastDownbeat === 0 ? earliestIndex : earliestIndex + (bar - beatsPastDownbeat);
  return beatTimeAt(grid, index);
}

/** BPM implied by a grid's period. */
export function gridBpm(grid: BeatGrid): number {
  return 60 / grid.periodSec;
}
