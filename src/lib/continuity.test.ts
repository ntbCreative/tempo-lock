import { describe, it, expect } from 'vitest';
import {
  createContinuityState,
  updateContinuity,
  type RawTempoEvidence,
  type ContinuityState,
} from './continuity';

function evidence(bpm: number, overrides: Partial<RawTempoEvidence> = {}): RawTempoEvidence {
  return { bpm, confidence: 0.8, onsetCount: 8, coherent: true, ...overrides };
}

/** Feed the same (or slightly varying) estimate N times and return the final state. */
function feed(state: ContinuityState, estimates: (RawTempoEvidence | null)[]): ContinuityState {
  return estimates.reduce((s, e) => updateContinuity(s, e), state);
}

describe('continuity: initial acquisition', () => {
  it('locks onto the first strong, coherent estimate', () => {
    const state = updateContinuity(createContinuityState(), evidence(120));
    expect(state.displayedBpm).toBe(120);
    expect(state.status).toBe('locked');
    expect(state.pendingCandidate).toBeNull();
  });

  it('starts in the finding state before any evidence arrives', () => {
    const state = createContinuityState();
    expect(state.displayedBpm).toBeNull();
    expect(state.status).toBe('finding');
  });

  it('reports low-confidence on acquisition if the first estimate is weak-but-usable', () => {
    const state = updateContinuity(createContinuityState(), evidence(120, { confidence: 0.36 }));
    expect(state.displayedBpm).toBe(120);
    expect(state.status).toBe('low-confidence');
  });
});

describe('continuity: small drift smoothing', () => {
  it('smooths gradually toward a nearby estimate instead of jumping', () => {
    let state = updateContinuity(createContinuityState(), evidence(120));
    state = updateContinuity(state, evidence(123)); // ~2.5% change, within threshold
    expect(state.displayedBpm).toBeGreaterThan(120);
    expect(state.displayedBpm).toBeLessThan(123);
    expect(state.status).toBe('locked');
    expect(state.pendingCandidate).toBeNull();
  });

  it('converges toward a small, real drift over several updates', () => {
    let state = updateContinuity(createContinuityState(), evidence(120));
    for (let i = 0; i < 20; i++) {
      state = updateContinuity(state, evidence(125));
    }
    expect(state.displayedBpm).toBeCloseTo(125, 0);
  });
});

describe('continuity: rejecting an isolated large jump', () => {
  it('does not move the displayed BPM on a single large-jump estimate', () => {
    let state = updateContinuity(createContinuityState(), evidence(120));
    state = updateContinuity(state, evidence(90)); // 25% jump: major change
    expect(state.displayedBpm).toBe(120);
    expect(state.pendingCandidate).not.toBeNull();
    expect(state.pendingCandidate?.count).toBe(1);
  });

  it('reverts a pending candidate if the very next estimate returns to the current tempo', () => {
    let state = updateContinuity(createContinuityState(), evidence(120));
    state = updateContinuity(state, evidence(90));
    state = updateContinuity(state, evidence(121)); // back near current -> small-change branch
    expect(state.displayedBpm).toBeCloseTo(120, 0);
    expect(state.pendingCandidate).toBeNull();
  });
});

describe('continuity: accepting a large change after consensus', () => {
  it('commits a major change after three consecutive agreeing estimates', () => {
    let state = updateContinuity(createContinuityState(), evidence(120));
    state = updateContinuity(state, evidence(90));
    expect(state.displayedBpm).toBe(120);
    state = updateContinuity(state, evidence(91));
    expect(state.displayedBpm).toBe(120); // still only 2 consecutive
    state = updateContinuity(state, evidence(90));
    expect(state.displayedBpm).toBeCloseTo(90, 0);
    expect(state.status).toBe('locked');
    expect(state.pendingCandidate).toBeNull();
  });

  it('handles a half-time flip (120 -> 60) after consensus', () => {
    let state = updateContinuity(createContinuityState(), evidence(120));
    state = feed(state, [evidence(60), evidence(60), evidence(60)]);
    expect(state.displayedBpm).toBeCloseTo(60, 0);
  });

  it('handles a double-time flip (90 -> 180) after consensus', () => {
    let state = updateContinuity(createContinuityState(), evidence(90));
    state = feed(state, [evidence(180), evidence(180), evidence(180)]);
    expect(state.displayedBpm).toBeCloseTo(180, 0);
  });
});

describe('continuity: candidate agreement window', () => {
  it('does not accumulate consensus across disagreeing candidates (>5% apart)', () => {
    let state = updateContinuity(createContinuityState(), evidence(120));
    state = updateContinuity(state, evidence(90)); // candidate A: count 1
    state = updateContinuity(state, evidence(100)); // >5% away from 90 -> resets to candidate B, count 1
    expect(state.pendingCandidate?.bpm).toBeCloseTo(100, 0);
    expect(state.pendingCandidate?.count).toBe(1);
    state = updateContinuity(state, evidence(101)); // within 5% of 100 -> count 2
    expect(state.pendingCandidate?.count).toBe(2);
    expect(state.displayedBpm).toBe(120);
  });

  it('accepts a run of estimates within the 5% agreement band', () => {
    let state = updateContinuity(createContinuityState(), evidence(100));
    state = feed(state, [evidence(140), evidence(142), evidence(138)]); // all within 5% of each other
    expect(state.displayedBpm).toBeGreaterThan(135);
    expect(state.displayedBpm).toBeLessThan(145);
  });
});

describe('continuity: low-confidence estimates', () => {
  it('treats a below-threshold confidence estimate as unusable and does not move displayed BPM', () => {
    let state = updateContinuity(createContinuityState(), evidence(120));
    state = updateContinuity(state, evidence(90, { confidence: 0.1 }));
    expect(state.displayedBpm).toBe(120);
    expect(state.pendingCandidate).toBeNull();
  });

  it('reports low-confidence status while displaying the last good tempo', () => {
    let state = updateContinuity(createContinuityState(), evidence(120));
    state = updateContinuity(state, evidence(90, { confidence: 0.1 }));
    expect(state.status).toBe('low-confidence');
    expect(state.displayedBpm).toBe(120);
  });
});

describe('continuity: insufficient onset evidence', () => {
  it('ignores an estimate with too few onsets even if confidence is high', () => {
    let state = updateContinuity(createContinuityState(), evidence(120));
    state = updateContinuity(state, evidence(90, { onsetCount: 1 }));
    expect(state.displayedBpm).toBe(120);
    expect(state.pendingCandidate).toBeNull();
  });
});

describe('continuity: evidence returning near the current tempo', () => {
  it('clears an in-progress pending candidate once evidence agrees with the current tempo again', () => {
    let state = updateContinuity(createContinuityState(), evidence(120));
    state = updateContinuity(state, evidence(90));
    state = updateContinuity(state, evidence(89));
    expect(state.pendingCandidate?.count).toBe(2);
    state = updateContinuity(state, evidence(119)); // back near current -> small-change branch
    expect(state.pendingCandidate).toBeNull();
    expect(state.displayedBpm).toBeCloseTo(120, 0);
  });
});

describe('continuity: missing estimates', () => {
  it('keeps the displayed tempo through a null (missing) estimate', () => {
    let state = updateContinuity(createContinuityState(), evidence(120));
    state = updateContinuity(state, null);
    expect(state.displayedBpm).toBe(120);
    expect(state.status).toBe('low-confidence');
  });

  it('clears a pending candidate on a missing estimate', () => {
    let state = updateContinuity(createContinuityState(), evidence(120));
    state = updateContinuity(state, evidence(90));
    expect(state.pendingCandidate).not.toBeNull();
    state = updateContinuity(state, null);
    expect(state.pendingCandidate).toBeNull();
    expect(state.displayedBpm).toBe(120);
  });

  it('does not acquire an initial tempo from a missing estimate', () => {
    const state = updateContinuity(createContinuityState(), null);
    expect(state.displayedBpm).toBeNull();
    expect(state.status).toBe('finding');
  });
});

describe('continuity: out-of-range values', () => {
  it('rejects an estimate below the minimum BPM', () => {
    let state = updateContinuity(createContinuityState(), evidence(120));
    state = updateContinuity(state, evidence(20));
    expect(state.displayedBpm).toBe(120);
  });

  it('rejects an estimate above the maximum BPM', () => {
    let state = updateContinuity(createContinuityState(), evidence(120));
    state = updateContinuity(state, evidence(300));
    expect(state.displayedBpm).toBe(120);
  });

  it('never lets the displayed BPM leave the 40-240 range even under custom config', () => {
    const state = updateContinuity(createContinuityState(), evidence(120), { minBpm: 40, maxBpm: 240 });
    expect(state.displayedBpm).toBeGreaterThanOrEqual(40);
    expect(state.displayedBpm).toBeLessThanOrEqual(240);
  });
});

describe('continuity: incoherent evidence', () => {
  it('ignores an estimate explicitly flagged as incoherent', () => {
    let state = updateContinuity(createContinuityState(), evidence(120));
    state = updateContinuity(state, evidence(90, { coherent: false }));
    expect(state.displayedBpm).toBe(120);
    expect(state.pendingCandidate).toBeNull();
  });
});

describe('continuity: state reset', () => {
  it('createContinuityState always returns a fresh, empty state', () => {
    const state = createContinuityState();
    expect(state).toEqual({
      displayedBpm: null,
      confidence: 0,
      status: 'finding',
      pendingCandidate: null,
      stableTicks: 0,
    });
  });

  it('a reset after activity produces the same fresh state as a brand-new one', () => {
    let state = updateContinuity(createContinuityState(), evidence(120));
    state = updateContinuity(state, evidence(90));
    const resetState = createContinuityState();
    expect(resetState.displayedBpm).toBeNull();
    expect(resetState.pendingCandidate).toBeNull();
    expect(resetState.status).toBe('finding');
  });
});

describe('continuity: lock stability grows resistance to further change', () => {
  it('a freshly-acquired lock still commits a major change after the base 3 consecutive estimates', () => {
    // Matches pre-existing behavior: no stability bonus yet right after acquisition.
    let state = updateContinuity(createContinuityState(), evidence(120));
    state = updateContinuity(state, evidence(90));
    state = updateContinuity(state, evidence(90));
    state = updateContinuity(state, evidence(90));
    expect(state.displayedBpm).toBeCloseTo(90, 0);
  });

  it('an established lock demands more than 3 consecutive estimates once it has held for a while', () => {
    let state = updateContinuity(createContinuityState(), evidence(120));
    // Hold the lock steady for well past one stability-bonus step (8 ticks).
    for (let i = 0; i < 12; i++) {
      state = updateContinuity(state, evidence(120));
    }
    expect(state.stableTicks).toBeGreaterThanOrEqual(8);

    // A challenge that would have succeeded after 3 consecutive estimates on
    // a fresh lock should NOT succeed yet on this long-held one.
    state = updateContinuity(state, evidence(90));
    state = updateContinuity(state, evidence(90));
    state = updateContinuity(state, evidence(90));
    expect(state.displayedBpm).toBeCloseTo(120, 0);
    expect(state.pendingCandidate?.count).toBe(3);
  });

  it('a genuine, sustained challenge can still eventually override a long-held lock', () => {
    let state = updateContinuity(createContinuityState(), evidence(120));
    for (let i = 0; i < 12; i++) {
      state = updateContinuity(state, evidence(120));
    }
    // Keep feeding agreeing estimates well past 3 -- a real, sustained
    // tempo change should still get through, just not instantly.
    for (let i = 0; i < 6; i++) {
      state = updateContinuity(state, evidence(90));
      if (state.displayedBpm && Math.abs(state.displayedBpm - 90) < 1) break;
    }
    expect(state.displayedBpm).toBeCloseTo(90, 0);
  });

  it('the stability bonus is capped, so an extremely long-held lock does not become permanently unchangeable', () => {
    let state = updateContinuity(createContinuityState(), evidence(120));
    for (let i = 0; i < 100; i++) {
      state = updateContinuity(state, evidence(120));
    }
    // Even after a huge number of stable ticks, the required count is capped
    // (base 3 + max bonus 3 = 6), not ever-growing.
    for (let i = 0; i < 6; i++) {
      state = updateContinuity(state, evidence(90));
    }
    expect(state.displayedBpm).toBeCloseTo(90, 0);
  });

  it('a newly-committed change resets stability, so it is immediately vulnerable to a fresh challenge again', () => {
    let state = updateContinuity(createContinuityState(), evidence(120));
    for (let i = 0; i < 12; i++) {
      state = updateContinuity(state, evidence(120));
    }
    // Force through a genuine change to 90 (matches the "eventually overrides" test above).
    for (let i = 0; i < 6; i++) {
      state = updateContinuity(state, evidence(90));
      if (state.displayedBpm && Math.abs(state.displayedBpm - 90) < 1) break;
    }
    expect(state.stableTicks).toBe(0);

    // Immediately after, only 3 consecutive estimates should be needed again.
    state = updateContinuity(state, evidence(140));
    state = updateContinuity(state, evidence(140));
    state = updateContinuity(state, evidence(140));
    expect(state.displayedBpm).toBeCloseTo(140, 0);
  });

  it('weak/missing evidence still counts toward stability (the lock has not actually changed)', () => {
    let state = updateContinuity(createContinuityState(), evidence(120));
    for (let i = 0; i < 12; i++) {
      state = updateContinuity(state, null);
    }
    expect(state.stableTicks).toBeGreaterThanOrEqual(8);
    expect(state.displayedBpm).toBe(120);
  });
});
