import { describe, it, expect } from 'vitest';
import { computeEnergyEnvelope, onsetEnvelopeFromEnergy, detectOnsets, estimateNoiseFloor, maskBelowNoiseFloor } from './onsetDetection';

function buildEnvelope(length: number, spikeFrames: number[], spikeValue = 1, floor = 0.01): Float32Array {
  const env = new Float32Array(length).fill(floor);
  for (const i of spikeFrames) {
    if (i >= 0 && i < length) env[i] = spikeValue;
  }
  return env;
}

describe('onsetDetection: computeEnergyEnvelope', () => {
  it('returns an empty envelope when samples are shorter than one frame', () => {
    expect(computeEnergyEnvelope(new Float32Array(10), 100, 50)).toHaveLength(0);
  });

  it('produces higher energy for louder samples', () => {
    const quiet = new Float32Array(200).fill(0.01);
    const loud = new Float32Array(200).fill(0.5);
    const quietEnv = computeEnergyEnvelope(quiet, 100, 50);
    const loudEnv = computeEnergyEnvelope(loud, 100, 50);
    expect(loudEnv[0]).toBeGreaterThan(quietEnv[0]);
  });
});

describe('onsetDetection: onsetEnvelopeFromEnergy', () => {
  it('is zero where energy is flat or falling', () => {
    const energy = new Float32Array([0.1, 0.1, 0.05, 0.02]);
    const onsetEnv = onsetEnvelopeFromEnergy(energy);
    expect(onsetEnv[1]).toBe(0);
    expect(onsetEnv[2]).toBe(0);
    expect(onsetEnv[3]).toBe(0);
  });

  it('is positive where energy rises', () => {
    const energy = new Float32Array([0.1, 0.5]);
    const onsetEnv = onsetEnvelopeFromEnergy(energy);
    expect(onsetEnv[1]).toBeCloseTo(0.4, 5);
  });
});

describe('onsetDetection: detectOnsets basic peak picking', () => {
  it('detects a single clear spike as one onset', () => {
    const env = buildEnvelope(50, [20]);
    const onsets = detectOnsets(env, { hopSeconds: 0.01 });
    expect(onsets).toHaveLength(1);
    expect(onsets[0]).toBeCloseTo(0.2, 5);
  });

  it('detects multiple well-separated spikes', () => {
    const env = buildEnvelope(100, [10, 40, 70]);
    const onsets = detectOnsets(env, { hopSeconds: 0.01 });
    expect(onsets).toHaveLength(3);
  });

  it('ignores low-level noise below the adaptive threshold', () => {
    const env = buildEnvelope(50, [], 0, 0.01);
    const onsets = detectOnsets(env, { hopSeconds: 0.01 });
    expect(onsets).toHaveLength(0);
  });
});

describe('onsetDetection: estimateNoiseFloor', () => {
  it('returns 0 for an empty sample set', () => {
    expect(estimateNoiseFloor([])).toBe(0);
  });

  it('returns the median of steady noise samples', () => {
    expect(estimateNoiseFloor([0.01, 0.012, 0.011, 0.013, 0.009])).toBeCloseTo(0.011, 5);
  });

  it('is not thrown off by a single early outlier (e.g. a button click)', () => {
    const samples = [0.01, 0.011, 0.009, 0.012, 0.01, 0.5]; // one loud outlier among quiet noise
    const floor = estimateNoiseFloor(samples);
    expect(floor).toBeLessThan(0.02); // median, not mean, ignores the outlier
  });
});

describe('onsetDetection: maskBelowNoiseFloor', () => {
  it('zeroes onset values whose frame energy is below the required margin', () => {
    const onsetEnv = new Float32Array([0.5, 0.5, 0.5]);
    const energy = new Float32Array([0.01, 0.05, 0.01]); // only the middle frame is loud
    const masked = maskBelowNoiseFloor(onsetEnv, energy, 0.01, 2); // requires energy >= 0.02
    expect(Array.from(masked)).toEqual([0, 0.5, 0]);
  });

  it('passes everything through when the whole signal is well above the floor', () => {
    const onsetEnv = new Float32Array([0.3, 0.4]);
    const energy = new Float32Array([0.5, 0.6]);
    const masked = maskBelowNoiseFloor(onsetEnv, energy, 0.01, 2);
    expect(masked[0]).toBeCloseTo(0.3, 5);
    expect(masked[1]).toBeCloseTo(0.4, 5);
  });

  it('masks everything when the whole signal never clears the floor (pure ambient noise)', () => {
    const onsetEnv = new Float32Array([0.02, 0.015, 0.018]);
    const energy = new Float32Array([0.012, 0.011, 0.013]); // steady low-level noise
    const masked = maskBelowNoiseFloor(onsetEnv, energy, 0.011, 2.5); // requires energy >= 0.0275
    expect(Array.from(masked)).toEqual([0, 0, 0]);
  });
});

describe('onsetDetection: noise-floor gate integrated with detectOnsets', () => {
  it('prevents steady ambient noise from producing any detected onsets', () => {
    // Simulate steady low-level room noise: energy hovers near a constant
    // with tiny random-ish fluctuation, never a real hit.
    const energy = new Float32Array([
      0.01, 0.012, 0.009, 0.011, 0.013, 0.01, 0.009, 0.012, 0.011, 0.01, 0.013, 0.009, 0.012, 0.01,
    ]);
    const onsetEnv = onsetEnvelopeFromEnergy(energy);
    const floor = estimateNoiseFloor(Array.from(energy));
    const masked = maskBelowNoiseFloor(onsetEnv, energy, floor, 2.5);
    const onsets = detectOnsets(masked, { hopSeconds: 0.01 });
    expect(onsets).toHaveLength(0);
  });

  it('still detects a real hit well above the noise floor', () => {
    const energy = new Float32Array([0.01, 0.011, 0.01, 0.012, 0.6, 0.15, 0.05, 0.01, 0.011, 0.01]);
    const onsetEnv = onsetEnvelopeFromEnergy(energy);
    const floor = estimateNoiseFloor([0.01, 0.011, 0.01, 0.012]); // calibrated from the quiet lead-in
    const masked = maskBelowNoiseFloor(onsetEnv, energy, floor, 2.5);
    const onsets = detectOnsets(masked, { hopSeconds: 0.01 });
    expect(onsets.length).toBeGreaterThanOrEqual(1);
  });
});

describe('onsetDetection: debounce prevents same-hit double-triggering', () => {
  // Regression coverage: a hard hit on a resonant surface can ring/bounce
  // shortly after the initial transient. A too-short debounce reads that
  // bounce as a second onset, which halves the apparent beat interval and
  // roughly doubles the measured tempo from a single hit.

  it('collapses two spikes within the debounce window into one onset', () => {
    const env = buildEnvelope(50, [20, 25]); // 50ms apart
    const onsets = detectOnsets(env, { hopSeconds: 0.01, minIntervalSeconds: 0.15 });
    expect(onsets).toHaveLength(1);
  });

  it('still accepts two spikes spaced beyond the debounce window as separate onsets', () => {
    const env = buildEnvelope(50, [10, 30]); // 200ms apart
    const onsets = detectOnsets(env, { hopSeconds: 0.01, minIntervalSeconds: 0.15 });
    expect(onsets).toHaveLength(2);
  });

  it('uses the default 150ms debounce when not overridden', () => {
    const env = buildEnvelope(50, [20, 24]); // 40ms apart
    const onsets = detectOnsets(env, { hopSeconds: 0.01 });
    expect(onsets).toHaveLength(1);
  });

  it('still permits a genuine fast tempo (240 BPM = 250ms/beat) through the default debounce', () => {
    const env = buildEnvelope(200, [10, 35, 60, 85]); // 250ms apart
    const onsets = detectOnsets(env, { hopSeconds: 0.01 });
    expect(onsets).toHaveLength(4);
  });
});
