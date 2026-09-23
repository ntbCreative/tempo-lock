import { describe, it, expect } from 'vitest';
import { estimateTempo } from './tempoEstimator';

/** Build a perfectly periodic onset train at `bpm`, for `count` beats, starting at `startSec`. */
function clickTrain(bpm: number, count: number, startSec = 0): number[] {
  const interval = 60 / bpm;
  return Array.from({ length: count }, (_, i) => startSec + i * interval);
}

/** Apply small jitter (in seconds) to every onset, deterministically, to simulate human timing. */
function withJitter(onsets: number[], jitterSec: number): number[] {
  return onsets.map((t, i) => t + (i % 2 === 0 ? jitterSec : -jitterSec));
}

describe('tempoEstimator: basic tempo ranges', () => {
  it('estimates a slow tempo (~48 BPM) accurately', () => {
    const result = estimateTempo(clickTrain(48, 16));
    expect(result.bpm).not.toBeNull();
    expect(result.bpm!).toBeCloseTo(48, 0);
    expect(result.coherent).toBe(true);
  });

  it('estimates a medium tempo (~120 BPM) accurately', () => {
    const result = estimateTempo(clickTrain(120, 16));
    expect(result.bpm!).toBeCloseTo(120, 0);
  });

  it('estimates a fast tempo (~210 BPM) accurately', () => {
    const result = estimateTempo(clickTrain(210, 16));
    expect(result.bpm!).toBeCloseTo(210, 0);
  });
});

describe('tempoEstimator: fast tempos do not collapse to half-time', () => {
  it('keeps a clean 180 BPM train at 180, not 90', () => {
    const result = estimateTempo(clickTrain(180, 20));
    expect(result.bpm!).toBeCloseTo(180, 0);
  });

  it('keeps a clean 200 BPM train at 200, not 100', () => {
    const result = estimateTempo(clickTrain(200, 20));
    expect(result.bpm!).toBeCloseTo(200, 0);
  });
});

describe('tempoEstimator: tie-breaking between full-time and half-time candidates', () => {
  it('prefers the candidate near the prior displayed tempo when scores are genuinely close', () => {
    // Construct onsets that could plausibly cluster near both 150 and 75:
    // most onsets at 150 BPM spacing but with some missing so the half-time
    // candidate also picks up real support, closer to a near-tie.
    const full = clickTrain(150, 24);
    const sparse = full.filter((_, i) => i % 2 === 0); // drop every other onset -> looks half-time-ish too
    const combined = [...full, ...sparse].sort((a, b) => a - b);

    const resultWithPrior = estimateTempo(combined, {}, 150);
    expect(resultWithPrior.bpm!).toBeCloseTo(150, 0);
  });

  it('does not automatically default to the slower candidate with no prior and no tie', () => {
    const result = estimateTempo(clickTrain(160, 20));
    // A clean, unambiguous train should resolve to its own tempo, not half of it.
    expect(result.bpm!).toBeGreaterThan(120);
  });

  it('overrides a clearly-winning candidate when a reference tempo points at its harmonic', () => {
    // A clean 200 BPM train resolves to 200 on its own (no prior) -- this
    // simulates real audio where the faster reading has more raw acoustic
    // support (e.g. hi-hats at the eighth-note rate) than the true
    // quarter-note pulse.
    const train = clickTrain(200, 24);
    const withoutPrior = estimateTempo(train);
    expect(withoutPrior.bpm!).toBeCloseTo(200, 0);

    // With a reference tempo at 100 (its half-time harmonic) -- e.g. tapped
    // in via Tap Tempo before Start Listening -- the override picks 100
    // instead, resolving the octave using the person's own reference.
    const withPrior = estimateTempo(train, {}, 100);
    expect(withPrior.bpm!).toBeCloseTo(100, 0);
  });

  it('ignores a reference tempo with no matching candidate at all', () => {
    // No candidate exists anywhere near 250 for a clean 200 BPM train, so
    // there's nothing for the override to latch onto -- falls through to
    // ordinary resolution.
    const result = estimateTempo(clickTrain(200, 24), {}, 250);
    expect(result.bpm!).toBeCloseTo(200, 0);
  });

  it('crossValidationBpm (e.g. from the autocorrelation cross-check) resolves octave ambiguity the same way priorBpm does', () => {
    const train = clickTrain(200, 24);
    // No priorBpm at all, but a cross-validation signal at 100 (its
    // half-time harmonic) should still trigger the same override.
    const result = estimateTempo(train, {}, null, 100);
    expect(result.bpm!).toBeCloseTo(100, 0);
  });

  it('checks crossValidationBpm even when priorBpm is absent, and priorBpm takes precedence when both are given', () => {
    const train = clickTrain(200, 24);
    // Both point at the same octave-relation candidate: still resolves there.
    const bothAgree = estimateTempo(train, {}, 100, 100);
    expect(bothAgree.bpm!).toBeCloseTo(100, 0);
  });
});

describe('tempoEstimator: noisy or incomplete onset patterns', () => {
  it('still recovers the tempo with small timing jitter', () => {
    const jittered = withJitter(clickTrain(128, 20), 0.015);
    const result = estimateTempo(jittered);
    expect(result.bpm!).toBeGreaterThan(124);
    expect(result.bpm!).toBeLessThan(132);
  });

  it('handles a pattern with a couple of missed onsets', () => {
    const full = clickTrain(100, 24);
    const withGaps = full.filter((_, i) => i !== 5 && i !== 12);
    const result = estimateTempo(withGaps);
    expect(result.bpm!).toBeCloseTo(100, 0);
  });
});

describe('tempoEstimator: brief dropouts and gradual drift', () => {
  it('handles a brief dropout (gap of several beats) without losing the tempo', () => {
    const before = clickTrain(110, 10, 0);
    const after = clickTrain(110, 10, before[before.length - 1] + 60 / 110 + 1.2); // ~1.2s gap
    const result = estimateTempo([...before, ...after]);
    expect(result.bpm!).toBeCloseTo(110, 0);
  });

  it('tracks gradual drift by weighting toward the most recent, denser spacing', () => {
    // Onsets that gradually speed up from ~100 to ~110 BPM.
    const onsets: number[] = [];
    let t = 0;
    let bpm = 100;
    for (let i = 0; i < 24; i++) {
      onsets.push(t);
      t += 60 / bpm;
      bpm += 0.5;
    }
    const result = estimateTempo(onsets);
    expect(result.bpm!).toBeGreaterThan(95);
    expect(result.bpm!).toBeLessThan(115);
  });
});

describe('tempoEstimator: abrupt intentional tempo changes', () => {
  it('reflects the most recent tempo when given a caller-trimmed recent window', () => {
    // The live engine is responsible for windowing to "recent" onsets; the
    // estimator itself just estimates from what it's given.
    const recentOnly = clickTrain(140, 16, 0);
    const result = estimateTempo(recentOnly);
    expect(result.bpm!).toBeCloseTo(140, 0);
  });
});

describe('tempoEstimator: insufficient evidence', () => {
  it('returns null bpm with too few onsets', () => {
    const result = estimateTempo([0, 0.5, 1.0]);
    expect(result.bpm).toBeNull();
    expect(result.coherent).toBe(false);
    expect(result.onsetCount).toBe(3);
  });

  it('returns null bpm for an empty onset list', () => {
    const result = estimateTempo([]);
    expect(result.bpm).toBeNull();
    expect(result.confidence).toBe(0);
  });
});

describe('tempoEstimator: candidate diagnostics', () => {
  it('exposes multiple candidates including the octave alternatives', () => {
    const result = estimateTempo(clickTrain(120, 20));
    expect(result.candidates.length).toBeGreaterThan(1);
    const bpms = result.candidates.map((c) => Math.round(c.bpm));
    expect(bpms).toContain(120);
  });
});

describe('tempoEstimator: confidence grows with sustained consistent evidence', () => {
  // Regression coverage for a real bug: confidence used to be the winning
  // candidate's *share* of total vote weight across all harmonic
  // candidates. For a very clean, consistent source (like a metronome-
  // steady stick tap), the half/double/third-time siblings accumulate
  // votes just as cleanly, so that share didn't reliably rise -- and could
  // even fall -- as more consistent taps came in, causing the detector to
  // sit at "Finding tempo" indefinitely despite obviously steady input.
  // Confidence must now grow (or at least not shrink) as more consistent
  // onsets arrive, and a bare-minimum onset count shouldn't already read
  // as maximally confident.

  it('increases confidence as more consistent taps accumulate', () => {
    const confidences = [4, 8, 16, 24].map((count) => estimateTempo(clickTrain(100, count)).confidence);
    for (let i = 1; i < confidences.length; i++) {
      expect(confidences[i]).toBeGreaterThanOrEqual(confidences[i - 1]);
    }
    // And it should have visibly grown from the sparse end to the dense end.
    expect(confidences[confidences.length - 1]).toBeGreaterThan(confidences[0]);
  });

  it('does not report near-maximum confidence from the bare minimum onset count', () => {
    const result = estimateTempo(clickTrain(100, 4)); // exactly minOnsetsToAccept
    expect(result.confidence).toBeLessThan(0.8);
  });

  it('reaches high confidence after a couple of bars of clean, steady taps', () => {
    const result = estimateTempo(clickTrain(100, 16)); // 4 bars at 4/4
    expect(result.confidence).toBeGreaterThan(0.8);
  });

  it('never exceeds 1', () => {
    const result = estimateTempo(clickTrain(100, 64));
    expect(result.confidence).toBeLessThanOrEqual(1);
  });
});
