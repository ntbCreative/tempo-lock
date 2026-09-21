import { describe, it, expect } from 'vitest';
import {
  doubleFeel,
  halveFeel,
  effectiveTicksPerBeat,
  beatsPerCycle,
  stepBeatCycle,
  MIN_FEEL,
  MAX_FEEL,
} from './feel';

describe('feel: doubleFeel', () => {
  it('doubles from 1x repeatedly', () => {
    let feel = 1;
    feel = doubleFeel(feel);
    expect(feel).toBe(2);
    feel = doubleFeel(feel);
    expect(feel).toBe(4);
    feel = doubleFeel(feel);
    expect(feel).toBe(8);
  });

  it('doubles up from below 1x too', () => {
    expect(doubleFeel(0.25)).toBe(0.5);
    expect(doubleFeel(0.5)).toBe(1);
  });

  it('caps at MAX_FEEL', () => {
    expect(doubleFeel(8)).toBe(MAX_FEEL);
    expect(doubleFeel(6)).toBe(MAX_FEEL);
  });
});

describe('feel: halveFeel', () => {
  it('halves from 1x repeatedly', () => {
    let feel = 1;
    feel = halveFeel(feel);
    expect(feel).toBe(0.5);
    feel = halveFeel(feel);
    expect(feel).toBe(0.25);
    feel = halveFeel(feel);
    expect(feel).toBe(0.125);
  });

  it('halves down from above 1x too', () => {
    expect(halveFeel(4)).toBe(2);
    expect(halveFeel(2)).toBe(1);
  });

  it('floors at MIN_FEEL', () => {
    expect(halveFeel(0.125)).toBe(MIN_FEEL);
    expect(halveFeel(0.2)).toBe(MIN_FEEL);
  });
});

describe('feel: double/halve are inverses at the values that matter', () => {
  it('doubling then halving returns to the start', () => {
    expect(halveFeel(doubleFeel(1))).toBe(1);
    expect(halveFeel(doubleFeel(2))).toBe(2);
  });
});

describe('feel: effectiveTicksPerBeat', () => {
  it('leaves ticks-per-beat unchanged at normal feel', () => {
    expect(effectiveTicksPerBeat(1, 1)).toBe(1);
    expect(effectiveTicksPerBeat(2, 1)).toBe(2);
  });

  it('scales ticks-per-beat up at faster-than-1x feel', () => {
    expect(effectiveTicksPerBeat(1, 2)).toBe(2);
    expect(effectiveTicksPerBeat(1, 4)).toBe(4);
    expect(effectiveTicksPerBeat(1, 8)).toBe(8);
    expect(effectiveTicksPerBeat(2, 2)).toBe(4);
  });

  it('leaves ticks-per-beat unchanged at slower-than-1x feel (that mutes beats, not sub-ticks)', () => {
    expect(effectiveTicksPerBeat(1, 0.5)).toBe(1);
    expect(effectiveTicksPerBeat(1, 0.25)).toBe(1);
  });

  it('treats a zero or negative base as 1', () => {
    expect(effectiveTicksPerBeat(0, 1)).toBe(1);
    expect(effectiveTicksPerBeat(-1, 2)).toBe(2);
  });
});

describe('feel: beatsPerCycle', () => {
  it('is 1 at normal feel or faster', () => {
    expect(beatsPerCycle(1)).toBe(1);
    expect(beatsPerCycle(2)).toBe(1);
    expect(beatsPerCycle(4)).toBe(1);
  });

  it('scales with how far below 1x the feel is', () => {
    expect(beatsPerCycle(0.5)).toBe(2);
    expect(beatsPerCycle(0.25)).toBe(4);
    expect(beatsPerCycle(0.125)).toBe(8);
  });
});

describe('feel: stepBeatCycle', () => {
  it('never mutes at 1x or faster, and leaves the counter untouched', () => {
    expect(stepBeatCycle(0, 1)).toEqual({ mute: false, nextCounter: 0 });
    expect(stepBeatCycle(1, 2)).toEqual({ mute: false, nextCounter: 1 });
  });

  it('plays exactly 1 beat per cycle at 0.5x (2-beat cycle)', () => {
    let counter = 0;
    let result = stepBeatCycle(counter, 0.5);
    expect(result).toEqual({ mute: false, nextCounter: 1 });
    counter = result.nextCounter;
    result = stepBeatCycle(counter, 0.5);
    expect(result).toEqual({ mute: true, nextCounter: 0 });
    counter = result.nextCounter;
    result = stepBeatCycle(counter, 0.5);
    expect(result).toEqual({ mute: false, nextCounter: 1 });
  });

  it('plays exactly 1 beat per cycle at 0.25x (4-beat cycle)', () => {
    let counter = 0;
    const mutes: boolean[] = [];
    for (let i = 0; i < 8; i++) {
      const result = stepBeatCycle(counter, 0.25);
      mutes.push(result.mute);
      counter = result.nextCounter;
    }
    expect(mutes).toEqual([false, true, true, true, false, true, true, true]);
  });

  it('produces exactly 1 unmuted beat out of every N over a longer run, for various feels', () => {
    for (const feel of [0.5, 0.25, 0.125]) {
      let counter = 0;
      let unmuted = 0;
      const cycles = 5;
      const totalBeats = beatsPerCycle(feel) * cycles;
      for (let i = 0; i < totalBeats; i++) {
        const result = stepBeatCycle(counter, feel);
        if (!result.mute) unmuted++;
        counter = result.nextCounter;
      }
      expect(unmuted).toBe(cycles);
    }
  });
});
