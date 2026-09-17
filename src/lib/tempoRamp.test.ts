import { describe, it, expect } from 'vitest';
import { bpmForBar, computeRampClickTimes, hasReachedTarget, clickIndexAtElapsedTime, type TempoRampConfig } from './tempoRamp';

const upRamp: TempoRampConfig = { startBpm: 100, targetBpm: 120, bpmStep: 5, barsPerStep: 2, beatsPerBar: 4 };
const downRamp: TempoRampConfig = { startBpm: 120, targetBpm: 90, bpmStep: 10, barsPerStep: 1, beatsPerBar: 4 };

describe('tempoRamp: bpmForBar (ramping up)', () => {
  it('starts at startBpm for the first barsPerStep bars', () => {
    expect(bpmForBar(0, upRamp)).toBe(100);
    expect(bpmForBar(1, upRamp)).toBe(100);
  });

  it('steps up by bpmStep after barsPerStep bars', () => {
    expect(bpmForBar(2, upRamp)).toBe(105);
    expect(bpmForBar(3, upRamp)).toBe(105);
  });

  it('continues stepping up at each interval', () => {
    expect(bpmForBar(4, upRamp)).toBe(110);
    expect(bpmForBar(6, upRamp)).toBe(115);
    expect(bpmForBar(8, upRamp)).toBe(120);
  });

  it('caps at targetBpm and holds beyond it', () => {
    expect(bpmForBar(20, upRamp)).toBe(120);
    expect(bpmForBar(1000, upRamp)).toBe(120);
  });
});

describe('tempoRamp: bpmForBar (ramping down)', () => {
  it('steps down toward the lower target', () => {
    expect(bpmForBar(0, downRamp)).toBe(120);
    expect(bpmForBar(1, downRamp)).toBe(110);
    expect(bpmForBar(2, downRamp)).toBe(100);
    expect(bpmForBar(3, downRamp)).toBe(90);
  });

  it('floors at targetBpm and holds beyond it', () => {
    expect(bpmForBar(10, downRamp)).toBe(90);
  });
});

describe('tempoRamp: bpmForBar edge cases', () => {
  it('stays at startBpm when start equals target', () => {
    const flat: TempoRampConfig = { startBpm: 100, targetBpm: 100, bpmStep: 5, barsPerStep: 2, beatsPerBar: 4 };
    expect(bpmForBar(0, flat)).toBe(100);
    expect(bpmForBar(50, flat)).toBe(100);
  });

  it('treats a zero or negative bpmStep as no ramp', () => {
    const noStep: TempoRampConfig = { startBpm: 100, targetBpm: 140, bpmStep: 0, barsPerStep: 2, beatsPerBar: 4 };
    expect(bpmForBar(10, noStep)).toBe(100);
  });

  it('treats a zero barsPerStep as no ramp (avoids divide-by-zero)', () => {
    const noBars: TempoRampConfig = { startBpm: 100, targetBpm: 140, bpmStep: 5, barsPerStep: 0, beatsPerBar: 4 };
    expect(bpmForBar(10, noBars)).toBe(100);
  });

  it('treats a negative bar index as bar 0', () => {
    expect(bpmForBar(-1, upRamp)).toBe(100);
  });
});

describe('tempoRamp: hasReachedTarget', () => {
  it('is false before the target tempo is reached', () => {
    expect(hasReachedTarget(0, upRamp)).toBe(false);
  });

  it('is true once the ramp holds at target', () => {
    expect(hasReachedTarget(8, upRamp)).toBe(true);
    expect(hasReachedTarget(100, upRamp)).toBe(true);
  });
});

describe('tempoRamp: clickIndexAtElapsedTime', () => {
  it('returns 0 at or before the start', () => {
    expect(clickIndexAtElapsedTime(0, upRamp)).toBe(0);
    expect(clickIndexAtElapsedTime(-1, upRamp)).toBe(0);
  });

  it('matches the forward-computed click times within a single tempo step', () => {
    // At 100 BPM, click index 2 fires at 1.2s; just after that, 3 clicks (0,1,2) have occurred.
    expect(clickIndexAtElapsedTime(1.21, upRamp)).toBe(3);
  });

  it('lands on the correct side of a tempo-step boundary', () => {
    const times = computeRampClickTimes(0, 0, 12, upRamp);
    // times[8] is the first click at the stepped-up tempo (105 BPM).
    expect(clickIndexAtElapsedTime(times[8] - 0.001, upRamp)).toBe(8); // click 8 hasn't fired yet
    expect(clickIndexAtElapsedTime(times[8] + 0.001, upRamp)).toBe(9); // click 8 just fired
  });
});

describe('tempoRamp: computeRampClickTimes', () => {
  it('produces evenly spaced clicks within a single step (no ramp yet active)', () => {
    const times = computeRampClickTimes(0, 0, 4, upRamp);
    expect(times[0]).toBeCloseTo(0, 5);
    expect(times[1]).toBeCloseTo(0.6, 5);
    expect(times[2]).toBeCloseTo(1.2, 5);
    expect(times[3]).toBeCloseTo(1.8, 5);
  });

  it('widens or narrows the interval exactly at a bar boundary when the tempo steps', () => {
    const times = computeRampClickTimes(0, 0, 9, upRamp);
    const intervalBefore = times[7] - times[6];
    const intervalAfterStep = times[8] - times[7];
    expect(intervalBefore).toBeCloseTo(60 / 100, 5);
    expect(intervalAfterStep).toBeCloseTo(60 / 100, 5);
  });

  it('continues correctly from a non-zero start click index', () => {
    const times = computeRampClickTimes(100, 8, 2, upRamp);
    expect(times[1] - times[0]).toBeCloseTo(60 / 105, 5);
  });

  it('produces no times when count is 0', () => {
    expect(computeRampClickTimes(0, 0, 0, upRamp)).toEqual([]);
  });
});
