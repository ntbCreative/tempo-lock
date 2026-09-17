import { describe, it, expect } from 'vitest';
import { createTapTempoState, registerTap } from './tapTempo';

describe('tapTempo', () => {
  it('produces no bpm from a single tap', () => {
    const state = registerTap(createTapTempoState(), 0);
    expect(state.bpm).toBeNull();
  });

  it('computes bpm from two taps', () => {
    let state = registerTap(createTapTempoState(), 0);
    state = registerTap(state, 0.5); // 0.5s interval -> 120 BPM
    expect(state.bpm).toBeCloseTo(120, 0);
  });

  it('uses a trimmed median so one bad tap does not ruin the result', () => {
    let state = createTapTempoState();
    const taps = [0, 0.5, 1.0, 1.5, 3.0, 3.5, 4.0]; // one long gap (1.5) among steady 0.5s taps
    for (const t of taps) state = registerTap(state, t);
    expect(state.bpm).toBeCloseTo(120, 0);
  });

  it('resets after a long pause', () => {
    let state = registerTap(createTapTempoState(), 0);
    state = registerTap(state, 0.5);
    state = registerTap(state, 10); // long gap resets the sequence
    expect(state.tapTimesSec).toEqual([10]);
    expect(state.bpm).toBeNull();
  });

  it('clamps to the 40-240 BPM range', () => {
    let state = registerTap(createTapTempoState(), 0);
    state = registerTap(state, 0.1); // 600 BPM raw -> clamp to 240
    expect(state.bpm).toBe(240);
  });
});
