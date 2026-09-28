import { describe, it, expect } from 'vitest';
import { beatTimeAt, nearestBeatIndex, countInStartOnGrid, nextDownbeatOnGrid, gridBpm } from './beatGrid';
import { estimateTempo } from './tempoEstimator';
import type { BeatGrid } from './types';

const grid: BeatGrid = { periodSec: 0.5, referenceBeatSec: 1.0, beats: 12, rmsSec: 0.004 };

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('beatGrid: basics', () => {
  it('places beats at reference + k * period, including negative and future k', () => {
    expect(beatTimeAt(grid, 0)).toBe(1.0);
    expect(beatTimeAt(grid, 8)).toBeCloseTo(5.0, 9);
    expect(beatTimeAt(grid, -2)).toBeCloseTo(0.0, 9);
  });

  it('finds the nearest beat index for any time', () => {
    expect(nearestBeatIndex(grid, 1.0)).toBe(0);
    expect(nearestBeatIndex(grid, 1.24)).toBe(0);
    expect(nearestBeatIndex(grid, 1.26)).toBe(1);
    expect(nearestBeatIndex(grid, 4.98)).toBe(8);
  });

  it('reports the BPM implied by the period', () => {
    expect(gridBpm(grid)).toBeCloseTo(120, 9);
  });
});

describe('beatGrid: countInStartOnGrid', () => {
  it('lands N bars after the beat nearest the anchor onset, on the grid', () => {
    // 2 bars of 4/4 = 8 beats after beat 0 -> t = 1.0 + 8 * 0.5
    expect(countInStartOnGrid(grid, 1.0, 2, 4)).toBeCloseTo(5.0, 9);
  });

  it('ignores a jittery anchor: a hit 20ms off the grid still means beat 0', () => {
    expect(countInStartOnGrid(grid, 1.02, 2, 4)).toBeCloseTo(5.0, 9);
    expect(countInStartOnGrid(grid, 0.98, 2, 4)).toBeCloseTo(5.0, 9);
  });

  it('respects the beats-per-bar setting', () => {
    expect(countInStartOnGrid(grid, 1.0, 1, 3)).toBeCloseTo(2.5, 9); // 3 beats
    expect(countInStartOnGrid(grid, 1.0, 4, 4)).toBeCloseTo(9.0, 9); // 16 beats
  });
});

describe('beatGrid: nextDownbeatOnGrid', () => {
  const lead = 0.3;

  it('always lands at least minLeadSec in the future', () => {
    for (let now = 2.0; now < 9.0; now += 0.037) {
      expect(nextDownbeatOnGrid(grid, 1.0, now, 4, lead)).toBeGreaterThanOrEqual(now + lead - 1e-9);
    }
  });

  it('always lands exactly on the grid and on a bar boundary from the anchor', () => {
    for (let now = 2.0; now < 9.0; now += 0.041) {
      const t = nextDownbeatOnGrid(grid, 1.0, now, 4, lead);
      const idx = (t - grid.referenceBeatSec) / grid.periodSec;
      expect(Math.abs(idx - Math.round(idx))).toBeLessThan(1e-9);
      expect((((Math.round(idx) - 0) % 4) + 4) % 4).toBe(0);
    }
  });

  it('picks the FIRST qualifying downbeat, not a later one', () => {
    for (let now = 2.0; now < 9.0; now += 0.043) {
      const t = nextDownbeatOnGrid(grid, 1.0, now, 4, lead);
      expect(t - 4 * grid.periodSec).toBeLessThan(now + lead + 1e-9);
    }
  });

  it('keeps the bar phase defined by the anchor, not by grid index zero', () => {
    // Anchor sits on beat 3 of the grid, so downbeats are beats 3, 7, 11 ...
    const anchor = beatTimeAt(grid, 3);
    const t = nextDownbeatOnGrid(grid, anchor, 2.6, 4, lead);
    const idx = Math.round((t - grid.referenceBeatSec) / grid.periodSec);
    expect((((idx - 3) % 4) + 4) % 4).toBe(0);
  });

  it('treats an invalid beatsPerBar as 1 rather than breaking', () => {
    const t = nextDownbeatOnGrid(grid, 1.0, 3.0, 0, lead);
    expect(Number.isFinite(t)).toBe(true);
    expect(t).toBeGreaterThanOrEqual(3.3 - 1e-9);
  });
});

describe('beatGrid: end-to-end accuracy of a count-in start', () => {
  // A player counts in 2 bars of 4/4 with sticks, with realistic timing
  // jitter. The click must start on the *true* downbeat that follows.
  const BARS = 2;
  const BPB = 4;
  const N = BARS * BPB;
  const T0 = 1.0;

  function gridStartError(bpm: number, jitterSec: number, seed: number): number {
    const rand = mulberry32(seed);
    const period = 60 / bpm;
    const onsets = Array.from({ length: N }, (_, i) => T0 + i * period + (rand() * 2 - 1) * jitterSec);
    const trueStart = T0 + N * period;
    const shippedStart = onsets[0] + N * period; // reference point for the trigger time only
    const heard = onsets.filter((t) => t <= shippedStart - 0.3); // trigger fires 0.3s ahead
    const est = estimateTempo(heard.map((t) => t - heard[0]));
    expect(est.grid).toBeTruthy();
    const g: BeatGrid = { ...est.grid!, referenceBeatSec: est.grid!.referenceBeatSec + heard[0] };
    return Math.abs(countInStartOnGrid(g, onsets[0], BARS, BPB) - trueStart);
  }

  it('lands within a few milliseconds of the true downbeat across tempos (+/-8ms jitter)', () => {
    for (const bpm of [90, 117.3, 140, 170]) {
      let total = 0;
      const seeds = 40;
      for (let s = 1; s <= seeds; s++) total += gridStartError(bpm, 0.008, s * 131 + Math.round(bpm));
      expect(total / seeds).toBeLessThan(0.008); // measured ~2.5-2.9ms
    }
  });

  it('stays accurate with sloppier playing (+/-15ms jitter)', () => {
    for (const bpm of [90, 140]) {
      let total = 0;
      const seeds = 40;
      for (let s = 1; s <= seeds; s++) total += gridStartError(bpm, 0.015, s * 97 + Math.round(bpm));
      expect(total / seeds).toBeLessThan(0.014); // measured ~5ms
    }
  });
});
