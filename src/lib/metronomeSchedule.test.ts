import { describe, it, expect } from 'vitest';
import {
  createBarCountdownState,
  updateBarCountdown,
  computeClickTimes,
  computeSessionPosition,
  isDownbeat,
  blendTowards,
  type BarCountdownState,
} from './metronomeSchedule';

describe('metronomeSchedule: bar countdown feature-off', () => {
  it('never triggers when barsRequired is 0', () => {
    let state = createBarCountdownState();
    for (let t = 0; t <= 10; t++) {
      const result = updateBarCountdown(state, 120, t, { barsRequired: 0 });
      state = result.state;
      expect(result.shouldStartMetronome).toBe(false);
    }
  });
});

describe('metronomeSchedule: countdown lifecycle', () => {
  it('does not trigger before any tempo reading exists', () => {
    const result = updateBarCountdown(createBarCountdownState(), null, 0, { barsRequired: 1 });
    expect(result.shouldStartMetronome).toBe(false);
    expect(result.state.lockStartTimeSec).toBeNull();
  });

  it('starts the countdown the moment a tempo reading appears', () => {
    const result = updateBarCountdown(createBarCountdownState(), 120, 5, { barsRequired: 1 });
    expect(result.shouldStartMetronome).toBe(false);
    expect(result.state.lockStartTimeSec).toBe(5);
    expect(result.state.lockStartBpm).toBe(120);
  });

  it('triggers after exactly one bar (4 beats) at 120 BPM = 2 seconds', () => {
    let state = createBarCountdownState();
    let result = updateBarCountdown(state, 120, 0, { barsRequired: 1 });
    state = result.state;

    result = updateBarCountdown(state, 120, 1.9, { barsRequired: 1 });
    state = result.state;
    expect(result.shouldStartMetronome).toBe(false);

    result = updateBarCountdown(state, 120, 2.0, { barsRequired: 1 });
    expect(result.shouldStartMetronome).toBe(true);
    expect(result.metronomeBpm).toBe(120);
    expect(result.metronomeStartTimeSec).toBeCloseTo(2.0, 5);
  });

  it('phase-aligns the start time to countdown-start + exact bar duration, not to the check time', () => {
    let state = createBarCountdownState();
    let result = updateBarCountdown(state, 100, 10, { barsRequired: 2 });
    state = result.state;
    // 2 bars at 100 BPM, 4 beats/bar: 2 * 4 * 0.6s = 4.8s -> triggers at t=14.8
    result = updateBarCountdown(state, 100, 15.3, { barsRequired: 2 }); // checked a bit late
    expect(result.shouldStartMetronome).toBe(true);
    expect(result.metronomeStartTimeSec).toBeCloseTo(14.8, 5);
  });

  it('only fires once, even if updates continue after triggering', () => {
    let state = createBarCountdownState();
    let result = updateBarCountdown(state, 120, 0, { barsRequired: 1 });
    state = result.state;
    result = updateBarCountdown(state, 120, 2.0, { barsRequired: 1 });
    state = result.state;
    expect(result.shouldStartMetronome).toBe(true);

    result = updateBarCountdown(state, 120, 2.5, { barsRequired: 1 });
    expect(result.shouldStartMetronome).toBe(false);
    result = updateBarCountdown(result.state, 120, 3.0, { barsRequired: 1 });
    expect(result.shouldStartMetronome).toBe(false);
  });

  it('resets the countdown if the tempo reading is lost entirely', () => {
    let state = createBarCountdownState();
    let result = updateBarCountdown(state, 120, 0, { barsRequired: 4 });
    state = result.state;
    result = updateBarCountdown(state, null, 1, { barsRequired: 4 });
    expect(result.state.lockStartTimeSec).toBeNull();
    expect(result.shouldStartMetronome).toBe(false);

    // Re-acquiring starts a fresh countdown from the new time.
    result = updateBarCountdown(result.state, 120, 5, { barsRequired: 4 });
    expect(result.state.lockStartTimeSec).toBe(5);
  });

  it('scales required duration with barsRequired and tempo', () => {
    // 4 bars at 80 BPM, 4 beats/bar: 4*4*(60/80) = 12s
    let state = createBarCountdownState();
    let result = updateBarCountdown(state, 80, 0, { barsRequired: 4 });
    state = result.state;
    result = updateBarCountdown(state, 80, 11.9, { barsRequired: 4 });
    expect(result.shouldStartMetronome).toBe(false);
    result = updateBarCountdown(result.state, 80, 12.0, { barsRequired: 4 });
    expect(result.shouldStartMetronome).toBe(true);
  });

  it('freezes the metronome bpm at countdown-start even if the displayed bpm drifts slightly during the countdown', () => {
    let state: BarCountdownState = createBarCountdownState();
    let result = updateBarCountdown(state, 120, 0, { barsRequired: 1 });
    state = result.state;
    result = updateBarCountdown(state, 121.5, 1.0, { barsRequired: 1 });
    state = result.state;
    result = updateBarCountdown(state, 122, 2.0, { barsRequired: 1 });
    expect(result.metronomeBpm).toBe(120);
  });
});

describe('metronomeSchedule: anchor time phase-aligns the countdown to the actual first hit', () => {
  it('anchors the countdown start to anchorTimeSec, not to nowSec, when one is given', () => {
    // Detection took a couple of beats to accumulate enough onsets to
    // produce a reading at all: "now" (t=1.3) is well after the player's
    // actual first hit (t=0.1).
    const result = updateBarCountdown(createBarCountdownState(), 120, 1.3, { barsRequired: 1 }, 0.1);
    expect(result.state.lockStartTimeSec).toBe(0.1);
  });

  it('the click lands exactly N bars after the true first hit, not N bars after the detector caught up', () => {
    let state = createBarCountdownState();
    // First onset at t=0.1; detector only manages a reading at t=1.3.
    let result = updateBarCountdown(state, 120, 1.3, { barsRequired: 2 }, 0.1);
    state = result.state;
    // 2 bars at 120 BPM, 4 beats/bar: 2 * 4 * 0.5s = 4s -> should land at 0.1 + 4 = 4.1,
    // NOT at 1.3 + 4 = 5.3 (which is what anchoring to the detection moment would give).
    result = updateBarCountdown(state, 120, 4.15, { barsRequired: 2 }, 0.1);
    expect(result.shouldStartMetronome).toBe(true);
    expect(result.metronomeStartTimeSec).toBeCloseTo(4.1, 5);
  });

  it('falls back to nowSec when no anchor is given (unchanged prior behavior)', () => {
    const result = updateBarCountdown(createBarCountdownState(), 120, 5, { barsRequired: 1 });
    expect(result.state.lockStartTimeSec).toBe(5);
  });

  it('falls back to nowSec when the anchor is explicitly null', () => {
    const result = updateBarCountdown(createBarCountdownState(), 120, 5, { barsRequired: 1 }, null);
    expect(result.state.lockStartTimeSec).toBe(5);
  });

  it('only applies the anchor to a fresh countdown start, not to an already-running one', () => {
    let state = createBarCountdownState();
    let result = updateBarCountdown(state, 120, 1.3, { barsRequired: 1 }, 0.1);
    state = result.state;
    expect(state.lockStartTimeSec).toBe(0.1);
    // A later call with a *different* anchor value shouldn't retroactively
    // move an already-started countdown.
    result = updateBarCountdown(state, 120, 1.5, { barsRequired: 1 }, 999);
    expect(result.state.lockStartTimeSec).toBe(0.1);
  });

  it('a genuine tempo-change reset still anchors to nowSec, not to the stale original-session anchor', () => {
    let state = createBarCountdownState();
    let result = updateBarCountdown(state, 120, 1.3, { barsRequired: 1 }, 0.1);
    state = result.state;
    // A real tempo change (>8% drift) resets the countdown; the original
    // first-onset anchor (0.1) is no longer relevant to the new tempo.
    result = updateBarCountdown(state, 90, 3.0, { barsRequired: 1 }, 0.1);
    expect(result.state.lockStartTimeSec).toBe(3.0);
  });
});

describe('metronomeSchedule: tolerating real-world confidence noise', () => {
  // The countdown intentionally does NOT take detector confidence/status as
  // input at all -- only the displayed BPM. A noisy room (band mix, other
  // instruments) makes the detector's confidence wobble constantly even
  // while the tempo reading itself stays put; the countdown must keep
  // counting through that, or it would never complete outside a silent room.

  it('keeps counting through small bpm jitter without ever resetting', () => {
    let state = createBarCountdownState();
    let result = updateBarCountdown(state, 120, 0, { barsRequired: 2 });
    state = result.state;
    const jitteredReadings: [number, number][] = [
      [118, 0.5],
      [122, 1.0],
      [119, 1.5],
      [121, 2.5],
      [120, 3.5],
    ];
    for (const [bpm, t] of jitteredReadings) {
      result = updateBarCountdown(state, bpm, t, { barsRequired: 2 });
      state = result.state;
      expect(state.lockStartTimeSec).toBe(0);
    }
    // 2 bars at 120 BPM = 4s: by t=4.0 it should have fired.
    result = updateBarCountdown(state, 120, 4.0, { barsRequired: 2 });
    expect(result.shouldStartMetronome).toBe(true);
  });

  it('does not reset on a long run of identical readings', () => {
    let state = createBarCountdownState();
    let result = updateBarCountdown(state, 120, 0, { barsRequired: 1 });
    state = result.state;
    for (let t = 0.2; t < 2.0; t += 0.2) {
      result = updateBarCountdown(state, 120, t, { barsRequired: 1 });
      state = result.state;
      expect(state.lockStartTimeSec).toBe(0);
    }
  });
});

describe('metronomeSchedule: genuine tempo change resets the countdown', () => {
  it('restarts the countdown when the bpm drifts beyond tolerance', () => {
    let state = createBarCountdownState();
    let result = updateBarCountdown(state, 120, 0, { barsRequired: 4 });
    state = result.state;
    // A real tempo change: 120 -> 160 is way outside the default 8% tolerance.
    result = updateBarCountdown(state, 160, 1, { barsRequired: 4 });
    expect(result.state.lockStartTimeSec).toBe(1);
    expect(result.state.lockStartBpm).toBe(160);
  });

  it('uses a configurable drift tolerance', () => {
    let state = createBarCountdownState();
    let result = updateBarCountdown(state, 120, 0, { barsRequired: 4, driftTolerance: 0.2 });
    state = result.state;
    // 130 is ~8.3% off 120, within a widened 20% tolerance: should NOT reset.
    result = updateBarCountdown(state, 130, 1, { barsRequired: 4, driftTolerance: 0.2 });
    expect(result.state.lockStartTimeSec).toBe(0);
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

describe('metronomeSchedule: session position', () => {
  it('reports bar/beat position for an unlimited session', () => {
    const pos = computeSessionPosition(9, 4, 0);
    expect(pos).toEqual({ clickIndex: 9, barIndex: 2, beatInBar: 1, remainingBars: null, finished: false });
  });

  it('reports remaining bars for a fixed-length session', () => {
    const pos = computeSessionPosition(9, 4, 8);
    expect(pos.remainingBars).toBe(6);
    expect(pos.finished).toBe(false);
  });

  it('flags finished once the click reaches the end of the session', () => {
    const pos = computeSessionPosition(32, 4, 8);
    expect(pos.finished).toBe(true);
    expect(pos.remainingBars).toBe(0);
  });

  it('handles a 3/4 signature correctly', () => {
    const pos = computeSessionPosition(7, 3, 0);
    expect(pos.barIndex).toBe(2);
    expect(pos.beatInBar).toBe(1);
  });
});

describe('metronomeSchedule: blendTowards', () => {
  it('leaves current unchanged at factor 0', () => {
    expect(blendTowards(120, 130, 0)).toBe(120);
  });

  it('snaps straight to target at factor 1', () => {
    expect(blendTowards(120, 130, 1)).toBe(130);
  });

  it('moves partway toward the target at an intermediate factor', () => {
    expect(blendTowards(120, 130, 0.5)).toBe(125);
    expect(blendTowards(120, 140, 0.25)).toBe(125);
  });

  it('works when the target is lower than current', () => {
    expect(blendTowards(130, 120, 0.5)).toBe(125);
  });

  it('clamps an out-of-range factor', () => {
    expect(blendTowards(120, 130, -1)).toBe(120);
    expect(blendTowards(120, 130, 2)).toBe(130);
  });

  it('is a no-op when current already equals target', () => {
    expect(blendTowards(120, 120, 0.5)).toBe(120);
  });
});
