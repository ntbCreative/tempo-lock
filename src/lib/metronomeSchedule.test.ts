import { describe, it, expect } from 'vitest';
import {
  createBarCountdownState,
  updateBarCountdown,
  computeClickTimes,
  isDownbeat,
  type BarCountdownState,
} from './metronomeSchedule';

describe('metronomeSchedule: bar countdown feature-off', () => {
  it('never triggers when barsRequired is 0', () => {
    let state = createBarCountdownState();
    for (let t = 0; t <= 10; t++) {
      const result = updateBarCountdown(state, 'locked', 120, t, { barsRequired: 0 });
      state = result.state;
      expect(result.shouldStartMetronome).toBe(false);
    }
  });
});

describe('metronomeSchedule: countdown lifecycle', () => {
  it('does not trigger while not yet locked', () => {
    const result = updateBarCountdown(createBarCountdownState(), 'finding', null, 0, {
      barsRequired: 1,
    });
    expect(result.shouldStartMetronome).toBe(false);
    expect(result.state.lockStartTimeSec).toBeNull();
  });

  it('starts the countdown the moment lock begins', () => {
    const result = updateBarCountdown(createBarCountdownState(), 'locked', 120, 5, {
      barsRequired: 1,
    });
    expect(result.shouldStartMetronome).toBe(false);
    expect(result.state.lockStartTimeSec).toBe(5);
    expect(result.state.lockStartBpm).toBe(120);
  });

  it('triggers after exactly one bar (4 beats) at 120 BPM = 2 seconds', () => {
    let state = createBarCountdownState();
    let result = updateBarCountdown(state, 'locked', 120, 0, { barsRequired: 1 });
    state = result.state;

    // Not yet at 2s.
    result = updateBarCountdown(state, 'locked', 120, 1.9, { barsRequired: 1 });
    state = result.state;
    expect(result.shouldStartMetronome).toBe(false);

    // At/after 2s: triggers.
    result = updateBarCountdown(state, 'locked', 120, 2.0, { barsRequired: 1 });
    expect(result.shouldStartMetronome).toBe(true);
    expect(result.metronomeBpm).toBe(120);
    expect(result.metronomeStartTimeSec).toBeCloseTo(2.0, 5);
  });

  it('phase-aligns the start time to lock-start + exact bar duration, not to the check time', () => {
    let state = createBarCountdownState();
    let result = updateBarCountdown(state, 'locked', 100, 10, { barsRequired: 2 });
    state = result.state;
    // 2 bars at 100 BPM, 4 beats/bar: 2 * 4 * 0.6s = 4.8s -> triggers at t=14.8
    result = updateBarCountdown(state, 'locked', 100, 15.3, { barsRequired: 2 }); // checked a bit late
    expect(result.shouldStartMetronome).toBe(true);
    expect(result.metronomeStartTimeSec).toBeCloseTo(14.8, 5);
  });

  it('only fires once per lock, even if updates continue after triggering', () => {
    let state = createBarCountdownState();
    let result = updateBarCountdown(state, 'locked', 120, 0, { barsRequired: 1 });
    state = result.state;
    result = updateBarCountdown(state, 'locked', 120, 2.0, { barsRequired: 1 });
    state = result.state;
    expect(result.shouldStartMetronome).toBe(true);

    result = updateBarCountdown(state, 'locked', 120, 2.5, { barsRequired: 1 });
    expect(result.shouldStartMetronome).toBe(false);
    result = updateBarCountdown(result.state, 'locked', 120, 3.0, { barsRequired: 1 });
    expect(result.shouldStartMetronome).toBe(false);
  });

  it('resets the countdown if the lock breaks before completing', () => {
    let state = createBarCountdownState();
    let result = updateBarCountdown(state, 'locked', 120, 0, { barsRequired: 4 });
    state = result.state;
    result = updateBarCountdown(state, 'low-confidence', 120, 1, { barsRequired: 4 });
    state = result.state;
    expect(state.lockStartTimeSec).toBeNull();
    expect(result.shouldStartMetronome).toBe(false);

    // Re-locking starts a fresh countdown from the new time.
    result = updateBarCountdown(state, 'locked', 120, 5, { barsRequired: 4 });
    expect(result.state.lockStartTimeSec).toBe(5);
  });

  it('resets the countdown if displayed BPM becomes null', () => {
    let state = createBarCountdownState();
    let result = updateBarCountdown(state, 'locked', 120, 0, { barsRequired: 1 });
    state = result.state;
    result = updateBarCountdown(state, 'locked', null, 1, { barsRequired: 1 });
    expect(result.state.lockStartTimeSec).toBeNull();
  });

  it('scales required duration with barsRequired and tempo', () => {
    // 4 bars at 80 BPM, 4 beats/bar: 4*4*(60/80) = 12s
    let state = createBarCountdownState();
    let result = updateBarCountdown(state, 'locked', 80, 0, { barsRequired: 4 });
    state = result.state;
    result = updateBarCountdown(state, 'locked', 80, 11.9, { barsRequired: 4 });
    expect(result.shouldStartMetronome).toBe(false);
    result = updateBarCountdown(result.state, 'locked', 80, 12.0, { barsRequired: 4 });
    expect(result.shouldStartMetronome).toBe(true);
  });

  it('freezes the metronome bpm at lock-start even if displayed bpm drifts during the countdown', () => {
    let state: BarCountdownState = createBarCountdownState();
    let result = updateBarCountdown(state, 'locked', 120, 0, { barsRequired: 1 });
    state = result.state;
    // Small drift while counting down shouldn't change the eventual metronome tempo.
    result = updateBarCountdown(state, 'locked', 121.5, 1.0, { barsRequired: 1 });
    state = result.state;
    result = updateBarCountdown(state, 'locked', 122, 2.0, { barsRequired: 1 });
    expect(result.metronomeBpm).toBe(120);
  });
});

describe('metronomeSchedule: click scheduling', () => {
  it('computes evenly spaced click times at the given bpm', () => {
    const clicks = computeClickTimes(10, 120, 4); // 0.5s per beat
    expect(clicks).toEqual([10, 10.5, 11, 11.5]);
  });

  it('produces no clicks when count is 0', () => {
    expect(computeClickTimes(10, 120, 0)).toEqual([]);
  });
});

describe('metronomeSchedule: downbeat detection', () => {
  it('flags every beatsPerBar-th click as a downbeat', () => {
    const beatsPerBar = 4;
    const downbeats = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => isDownbeat(i, beatsPerBar));
    expect(downbeats).toEqual([true, false, false, false, true, false, false, false]);
  });
});
