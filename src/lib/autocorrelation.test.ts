import { describe, it, expect } from 'vitest';
import { buildImpulseEnvelope, estimateTempoByAutocorrelation } from './autocorrelation';

/** Build a perfectly periodic onset train at `bpm`, for `count` beats, starting at `startSec`. */
function clickTrain(bpm: number, count: number, startSec = 0): number[] {
  const interval = 60 / bpm;
  return Array.from({ length: count }, (_, i) => startSec + i * interval);
}

const HOP = 0.01; // 10ms, a typical onset-envelope hop size

describe('autocorrelation: buildImpulseEnvelope', () => {
  it('places a unit impulse at each onset\'s nearest sample', () => {
    const env = buildImpulseEnvelope([0.1, 0.3], 0, 0.5, HOP);
    expect(env[10]).toBe(1); // 0.1s / 0.01s hop = sample 10
    expect(env[30]).toBe(1); // 0.3s / 0.01s hop = sample 30
    expect(env.filter((v) => v === 1).length).toBe(2);
  });

  it('drops onsets outside the requested range', () => {
    const env = buildImpulseEnvelope([-1, 0.2, 10], 0, 0.5, HOP);
    expect(env.filter((v) => v === 1).length).toBe(1);
  });

  it('returns an empty envelope for an invalid range or hop', () => {
    expect(buildImpulseEnvelope([0.1], 0.5, 0.1, HOP).length).toBe(0);
    expect(buildImpulseEnvelope([0.1], 0, 1, 0).length).toBe(0);
  });
});

describe('autocorrelation: estimateTempoByAutocorrelation', () => {
  it('finds the correct tempo for a clean, long click train', () => {
    const onsets = clickTrain(120, 32); // 32 beats at 120 BPM = 16 seconds
    const env = buildImpulseEnvelope(onsets, 0, 16, HOP);
    const candidates = estimateTempoByAutocorrelation(env, HOP, 40, 240);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0].bpm).toBeCloseTo(120, 0);
  });

  it('works across a range of realistic tempos', () => {
    // A fixed hop-size lag grid has inherent quantization error that grows
    // at faster tempos (each 1-sample lag step is a bigger BPM jump when
    // the beat period itself is fewer samples) -- a couple of BPM off is
    // expected here, not a bug. A real pipeline would feed this a finer
    // hop or refine the peak afterward; this just confirms it lands in
    // the right neighborhood across the practical tempo range.
    for (const bpm of [70, 95, 140, 175]) {
      const onsets = clickTrain(bpm, 40);
      const durationSec = onsets[onsets.length - 1] + 60 / bpm;
      const env = buildImpulseEnvelope(onsets, 0, durationSec, HOP);
      const candidates = estimateTempoByAutocorrelation(env, HOP, 40, 240);
      expect(candidates.length).toBeGreaterThan(0);
      expect(Math.abs(candidates[0].bpm - bpm)).toBeLessThan(3);
    }
  });

  it('ranks the true tempo above its exact octave when both are present with equal raw strength', () => {
    // A perfectly periodic train at 100 BPM is, by construction, exactly
    // as self-similar at 100 BPM as it is at 50 BPM (every other beat) --
    // the perceptual weighting toward more common tempos is what should
    // separate them when raw strength alone can't.
    const onsets = clickTrain(100, 32);
    const env = buildImpulseEnvelope(onsets, 0, 20, HOP);
    const candidates = estimateTempoByAutocorrelation(env, HOP, 40, 240, 120);
    const near100 = candidates.find((c) => Math.abs(c.bpm - 100) < 3);
    const near50 = candidates.find((c) => Math.abs(c.bpm - 50) < 3);
    expect(near100).toBeDefined();
    expect(near50).toBeDefined();
    expect(near100!.strength).toBeGreaterThan(near50!.strength);
  });

  it('returns an empty array for silence (no onsets at all)', () => {
    const env = buildImpulseEnvelope([], 0, 10, HOP);
    expect(estimateTempoByAutocorrelation(env, HOP, 40, 240)).toEqual([]);
  });

  it('returns an empty array for a too-short envelope', () => {
    const env = buildImpulseEnvelope([0.1, 0.2], 0, 0.05, HOP);
    expect(estimateTempoByAutocorrelation(env, HOP, 40, 240)).toEqual([]);
  });

  it('returns an empty array for invalid bpm bounds', () => {
    const onsets = clickTrain(120, 16);
    const env = buildImpulseEnvelope(onsets, 0, 8, HOP);
    expect(estimateTempoByAutocorrelation(env, HOP, 0, 240)).toEqual([]);
    expect(estimateTempoByAutocorrelation(env, HOP, 200, 100)).toEqual([]);
  });

  it('candidates are sorted by descending strength', () => {
    const onsets = clickTrain(120, 32);
    const env = buildImpulseEnvelope(onsets, 0, 16, HOP);
    const candidates = estimateTempoByAutocorrelation(env, HOP, 40, 240);
    for (let i = 1; i < candidates.length; i++) {
      expect(candidates[i].strength).toBeLessThanOrEqual(candidates[i - 1].strength);
    }
  });
});
