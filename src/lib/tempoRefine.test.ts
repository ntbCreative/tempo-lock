import { describe, it, expect } from 'vitest';
import { refineTempoByRegression } from './tempoRefine';

/** Small deterministic PRNG so jittered fixtures are reproducible. */
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

function beatTrain(bpm: number, count: number, opts: { jitterSec?: number; seed?: number; start?: number } = {}): number[] {
  const rand = mulberry32(opts.seed ?? 1);
  const period = 60 / bpm;
  const start = opts.start ?? 0;
  const jitter = opts.jitterSec ?? 0;
  return Array.from({ length: count }, (_, i) => start + i * period + (rand() * 2 - 1) * jitter);
}

describe('tempoRefine: refineTempoByRegression', () => {
  it('recovers an exact tempo from a perfect grid', () => {
    const result = refineTempoByRegression(beatTrain(120, 20), 120);
    expect(result).not.toBeNull();
    expect(result!.bpm).toBeCloseTo(120, 3);
    expect(result!.beats).toBe(20);
  });

  it('is far more precise than single-gap error when onsets are jittery', () => {
    // +/-12ms jitter on a ~485ms beat: any single gap is off by ~5 BPM at worst,
    // but a 24-beat regression should land within a fraction of a BPM.
    const truth = 123.7;
    const result = refineTempoByRegression(beatTrain(truth, 24, { jitterSec: 0.012, seed: 7 }), truth + 1.5);
    expect(result).not.toBeNull();
    expect(Math.abs(result!.bpm - truth)).toBeLessThan(0.25);
  });

  it('locks onto the true tempo even when the coarse tempo is a few percent off', () => {
    const truth = 120;
    const result = refineTempoByRegression(beatTrain(truth, 20, { jitterSec: 0.006, seed: 3 }), 116);
    expect(result).not.toBeNull();
    expect(Math.abs(result!.bpm - truth)).toBeLessThan(0.3);
  });

  it('tolerates missing beats (dropped hits)', () => {
    const truth = 100;
    const train = beatTrain(truth, 30, { jitterSec: 0.008, seed: 11 }).filter((_, i) => i % 4 !== 3);
    const result = refineTempoByRegression(train, truth);
    expect(result).not.toBeNull();
    expect(Math.abs(result!.bpm - truth)).toBeLessThan(0.3);
  });

  it('rejects off-beat ghost notes rather than letting them corrupt the fit', () => {
    const truth = 120;
    const period = 60 / truth;
    const onBeats = beatTrain(truth, 20, { jitterSec: 0.006, seed: 5 });
    const ghosts = onBeats.map((t) => t + period / 2); // eighth-note offbeats
    const result = refineTempoByRegression([...onBeats, ...ghosts], truth);
    expect(result).not.toBeNull();
    expect(Math.abs(result!.bpm - truth)).toBeLessThan(0.3);
    expect(result!.beats).toBeLessThanOrEqual(20);
  });

  it('is not fooled by a stray onset before the real grid starts', () => {
    const truth = 110;
    const grid = beatTrain(truth, 20, { jitterSec: 0.006, seed: 9, start: 1.0 });
    const result = refineTempoByRegression([0.13, ...grid], truth);
    expect(result).not.toBeNull();
    expect(Math.abs(result!.bpm - truth)).toBeLessThan(0.3);
  });

  it('returns null with too few onsets to trust a fit', () => {
    expect(refineTempoByRegression(beatTrain(120, 4), 120)).toBeNull();
  });

  it('rejects a coincidental sparse grid when the coarse tempo does not match the signal', () => {
    // Coarse says 90, truth is 120: a 90 BPM grid coincides with only every 4th
    // true beat, so few grid slots are occupied -- weak evidence, however tight the fit.
    const result = refineTempoByRegression(beatTrain(120, 24, { jitterSec: 0.004, seed: 2 }), 90);
    expect(result).toBeNull();
  });

  it('returns null for a non-positive coarse tempo', () => {
    expect(refineTempoByRegression(beatTrain(120, 20), 0)).toBeNull();
    expect(refineTempoByRegression(beatTrain(120, 20), -5)).toBeNull();
  });

  it('reports how tightly onsets sit on the fitted grid', () => {
    const tight = refineTempoByRegression(beatTrain(120, 20, { jitterSec: 0.002, seed: 4 }), 120);
    const loose = refineTempoByRegression(beatTrain(120, 20, { jitterSec: 0.02, seed: 4 }), 120);
    expect(tight).not.toBeNull();
    expect(loose).not.toBeNull();
    expect(tight!.rmsSec).toBeLessThan(loose!.rmsSec);
  });

  it('treats a half-time coarse tempo as its own grid rather than mis-fitting', () => {
    // A true 120 BPM train evaluated at a coarse 60 BPM sees only every other
    // onset on-grid. The fit should either report ~60 or decline -- never
    // some number unrelated to either octave.
    const result = refineTempoByRegression(beatTrain(120, 24, { jitterSec: 0.004, seed: 6 }), 60);
    if (result !== null) {
      expect(Math.abs(result.bpm - 60)).toBeLessThan(0.5);
    }
  });

  it('does not depend on the input being pre-sorted', () => {
    const train = beatTrain(130, 20, { jitterSec: 0.005, seed: 8 });
    const shuffled = [...train].reverse();
    const a = refineTempoByRegression(train, 130);
    const b = refineTempoByRegression(shuffled, 130);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(b!.bpm).toBeCloseTo(a!.bpm, 9);
  });
});
