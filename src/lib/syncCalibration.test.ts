import { describe, it, expect } from 'vitest';
import { measureLoopbackLatency } from './syncCalibration';

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

const scheduled = Array.from({ length: 10 }, (_, k) => 10 + k * 0.8);

describe('syncCalibration: measureLoopbackLatency', () => {
  it('recovers a constant latency exactly', () => {
    const r = measureLoopbackLatency(scheduled, scheduled.map((s) => s + 0.137));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.latencySec).toBeCloseTo(0.137, 9);
      expect(r.matched).toBe(10);
    }
  });

  it('is accurate to a few ms with realistic per-click jitter', () => {
    const rand = mulberry32(3);
    const detected = scheduled.map((s) => s + 0.092 + (rand() * 2 - 1) * 0.004);
    const r = measureLoopbackLatency(scheduled, detected);
    expect(r.ok).toBe(true);
    if (r.ok) expect(Math.abs(r.latencySec - 0.092)).toBeLessThan(0.004);
  });

  it('handles large (Bluetooth-scale) latencies', () => {
    const r = measureLoopbackLatency(scheduled, scheduled.map((s) => s + 0.31));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.latencySec).toBeCloseTo(0.31, 9);
  });

  it('accepts a slightly negative lag (timestamp slop) rather than discarding it', () => {
    const r = measureLoopbackLatency(scheduled, scheduled.map((s) => s - 0.01));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.latencySec).toBeCloseTo(-0.01, 9);
  });

  it('survives a few missed detections', () => {
    const detected = scheduled.map((s) => s + 0.1).filter((_, i) => i !== 1 && i !== 4 && i !== 6);
    const r = measureLoopbackLatency(scheduled, detected);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.matched).toBe(7);
  });

  it('fails with too-few when too many clicks went unheard', () => {
    const detected = scheduled.map((s) => s + 0.1).slice(0, 6);
    const r = measureLoopbackLatency(scheduled, detected);
    expect(r).toMatchObject({ ok: false, reason: 'too-few' });
  });

  it('fails with too-few when nothing was detected at all', () => {
    expect(measureLoopbackLatency(scheduled, [])).toMatchObject({ ok: false, reason: 'too-few', matched: 0 });
  });

  it('fails with too-few when nothing was scheduled', () => {
    expect(measureLoopbackLatency([], [1, 2, 3])).toMatchObject({ ok: false, reason: 'too-few' });
  });

  it('ignores room noise that lands between (outside) the click windows', () => {
    const noise = [9.2, 10.65, 11.5, 13.95, 16.3, 18.9];
    const detected = [...scheduled.map((s) => s + 0.12), ...noise];
    const r = measureLoopbackLatency(scheduled, detected);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.latencySec).toBeCloseTo(0.12, 9);
  });

  it('drops individual outliers caused by noise inside a click window', () => {
    const detected = scheduled.map((s, i) => (i === 2 ? s + 0.02 : s + 0.15)); // one early noise hit
    const r = measureLoopbackLatency(scheduled, detected);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.latencySec).toBeCloseTo(0.15, 9);
      expect(r.matched).toBe(9);
    }
  });

  it('refuses to report a number when the lags split into two camps', () => {
    // e.g. some clicks heard directly, others only via a room reflection.
    const detected = scheduled.map((s, i) => s + (i % 2 ? 0.1 : 0.3));
    const r = measureLoopbackLatency(scheduled, detected);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('inconsistent');
  });

  it('almost never accepts a measurement built from pure random lags', () => {
    // Guards the tuning: a wrong calibration silently shifts every click, so
    // false accepts must be vanishingly rare. (Measured 0.000% over 20,000
    // trials; asserted here over 3,000 with headroom.)
    let accepted = 0;
    const trials = 3000;
    for (let seed = 1; seed <= trials; seed++) {
      const rand = mulberry32(seed * 7919);
      const detected = scheduled.map((s) => s + 0.05 + rand() * 0.4);
      if (measureLoopbackLatency(scheduled, detected).ok) accepted++;
    }
    expect(accepted / trials).toBeLessThan(0.002);
  });

  it('still accepts realistic conditions most of the time (jitter, a few misses)', () => {
    let accepted = 0;
    let errSum = 0;
    const trials = 500;
    for (let seed = 1; seed <= trials; seed++) {
      const rand = mulberry32(seed * 104729);
      const detected: number[] = [];
      for (const s of scheduled) {
        if (rand() < 0.1) continue; // 10% of clicks unheard
        detected.push(s + 0.14 + (rand() * 2 - 1) * 0.006);
      }
      const r = measureLoopbackLatency(scheduled, detected);
      if (r.ok) {
        accepted++;
        errSum += Math.abs(r.latencySec - 0.14);
      }
    }
    expect(accepted / trials).toBeGreaterThan(0.9);
    expect(errSum / accepted).toBeLessThan(0.004);
  });

  it('does not depend on detections being sorted', () => {
    const detected = scheduled.map((s) => s + 0.1).reverse();
    const r = measureLoopbackLatency(scheduled, detected);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.latencySec).toBeCloseTo(0.1, 9);
  });
});
