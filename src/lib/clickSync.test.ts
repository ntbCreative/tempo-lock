import { describe, it, expect } from 'vitest';
import { syncDownbeatToTap, eventTimeToPerfSec, type ClickPhase } from './clickSync';

function phase(overrides: Partial<ClickPhase> = {}): ClickPhase {
  // 120 BPM, 4/4, no subdivision. The next tick is a main beat at t=10.0, index 8 (a downbeat).
  return { nextTickTimeSec: 10.0, nextSubTick: 0, ticksPerBeat: 1, nextClickIndex: 8, bpm: 120, beatsPerBar: 4, ...overrides };
}
const OPTS = { nowSec: 9.9, lastTickTimeSec: 9.5, minLeadSec: 0.02 };

/** Walk the scheduler's ticks forward from a phase, as the engine would. */
function ticksFrom(p: ClickPhase, count: number): { time: number; sub: number; index: number }[] {
  const tickSec = 60 / p.bpm / p.ticksPerBeat;
  const out = [];
  let time = p.nextTickTimeSec, sub = p.nextSubTick, index = p.nextClickIndex;
  for (let i = 0; i < count; i++) {
    out.push({ time, sub, index });
    time += tickSec;
    sub += 1;
    if (sub >= p.ticksPerBeat) { sub = 0; index += 1; }
  }
  return out;
}

/** True if some future main beat that is a downbeat lands (within 1e-9) on the tap, modulo whole bars. */
function downbeatLandsOnTap(p: ClickPhase, tap: number): boolean {
  const barSec = (60 / p.bpm) * p.beatsPerBar;
  return ticksFrom(p, 200).some(
    (t) => t.sub === 0 && t.index % p.beatsPerBar === 0 && Math.abs(((t.time - tap) / barSec) - Math.round((t.time - tap) / barSec)) * barSec < 1e-9
  );
}

describe('clickSync: syncDownbeatToTap', () => {
  it('leaves a click that is already on the tap untouched', () => {
    const r = syncDownbeatToTap(phase(), 10.0, OPTS);
    expect(r.shiftSec).toBeCloseTo(0, 9);
    expect(r.phase.nextTickTimeSec).toBeCloseTo(10.0, 9);
    expect(r.phase.nextClickIndex).toBe(8);
    expect(r.skippedTicks).toBe(0);
  });

  it('moves a click that is late (tap earlier than the beat) earlier', () => {
    // The click's beat at 10.0 is 40ms after the tap at 9.96 -> slide 40ms earlier.
    const r = syncDownbeatToTap(phase(), 9.96, { ...OPTS, nowSec: 9.9 });
    expect(r.shiftSec).toBeCloseTo(-0.04, 9);
  });

  it('moves a click that is early (tap later than the beat) later', () => {
    const r = syncDownbeatToTap(phase(), 10.05, { ...OPTS, nowSec: 9.9 });
    expect(r.shiftSec).toBeCloseTo(0.05, 9);
    expect(r.phase.nextTickTimeSec).toBeCloseTo(10.05, 9);
  });

  it('never shifts more than half a beat', () => {
    for (let tap = 9.0; tap < 12.0; tap += 0.0137) {
      const r = syncDownbeatToTap(phase(), tap, { nowSec: 8.9, lastTickTimeSec: 9.5, minLeadSec: 0.02 });
      expect(Math.abs(r.shiftSec)).toBeLessThanOrEqual(0.25 + 1e-9);
    }
  });

  it('makes the tap a downbeat, even when the nearest click beat was a different beat of the bar', () => {
    // Tap near the beat at 10.5, which is index 9 (beat 2 of the bar): after syncing it must be beat 1.
    const r = syncDownbeatToTap(phase(), 10.52, { ...OPTS, nowSec: 10.4 });
    expect(downbeatLandsOnTap(r.phase, 10.52)).toBe(true);
  });

  it('lands a downbeat exactly on the tap for any tap position, tempo, meter and subdivision', () => {
    for (const bpm of [70, 120, 173]) {
      for (const beatsPerBar of [3, 4, 7]) {
        for (const ticksPerBeat of [1, 2, 4]) {
          for (let subTick = 0; subTick < ticksPerBeat; subTick++) {
            for (let tap = 10.0; tap < 13.0; tap += 0.111) {
              const tickSec = 60 / bpm / ticksPerBeat;
              const p = phase({ bpm, beatsPerBar, ticksPerBeat, nextSubTick: subTick, nextClickIndex: 11 + subTick, nextTickTimeSec: 10 + subTick * 0.013 });
              const r = syncDownbeatToTap(p, tap, { nowSec: 9.95, lastTickTimeSec: p.nextTickTimeSec - tickSec, minLeadSec: 0.02 });
              expect(downbeatLandsOnTap(r.phase, tap)).toBe(true);
            }
          }
        }
      }
    }
  });

  it('never schedules the next tick in the past or too soon', () => {
    for (let tap = 9.6; tap < 11.0; tap += 0.0173) {
      const now = 9.9;
      const r = syncDownbeatToTap(phase(), tap, { nowSec: now, lastTickTimeSec: 9.5, minLeadSec: 0.02 });
      expect(r.phase.nextTickTimeSec).toBeGreaterThanOrEqual(now + 0.02 - 1e-9);
    }
  });

  it('never lands a tick on top of one already queued (no doubled click)', () => {
    // Last queued tick at 10.0 (the very next one, at 10.5, is due). A big earlier
    // slide would put the next tick ~0.26 -> must keep clear of the queued one.
    for (let tap = 10.0; tap < 10.6; tap += 0.0091) {
      const r = syncDownbeatToTap(phase({ nextTickTimeSec: 10.5, nextClickIndex: 9 }), tap, { nowSec: 10.01, lastTickTimeSec: 10.0, minLeadSec: 0.02 });
      expect(r.phase.nextTickTimeSec).toBeGreaterThanOrEqual(10.0 + 0.5 * 0.5 - 1e-9);
    }
  });

  it('keeps every subsequent tick exactly on the new grid after any skipping', () => {
    const p = phase({ ticksPerBeat: 2, nextClickIndex: 8 });
    const r = syncDownbeatToTap(p, 9.93, { nowSec: 9.9, lastTickTimeSec: 9.75, minLeadSec: 0.02 });
    const ticks = ticksFrom(r.phase, 40);
    for (let i = 1; i < ticks.length; i++) expect(ticks[i].time - ticks[i - 1].time).toBeCloseTo(0.25, 9);
    expect(downbeatLandsOnTap(r.phase, 9.93)).toBe(true);
  });

  it('does not change the tempo', () => {
    const r = syncDownbeatToTap(phase(), 10.13, OPTS);
    expect(r.phase.bpm).toBe(120);
    expect(r.phase.ticksPerBeat).toBe(1);
  });

  it('never produces a negative beat index', () => {
    const r = syncDownbeatToTap(phase({ nextClickIndex: 0, nextTickTimeSec: 1.0 }), 1.55, { nowSec: 0.5, lastTickTimeSec: null, minLeadSec: 0.02 });
    expect(r.phase.nextClickIndex).toBeGreaterThanOrEqual(0);
  });

  it('treats an invalid beatsPerBar as one beat per bar rather than breaking', () => {
    const r = syncDownbeatToTap(phase({ beatsPerBar: 0 }), 10.07, OPTS);
    expect(Number.isFinite(r.phase.nextTickTimeSec)).toBe(true);
    expect(Number.isFinite(r.shiftSec)).toBe(true);
  });
});

describe('clickSync: eventTimeToPerfSec', () => {
  it('uses the event timestamp when it is in the performance.now() timebase', () => {
    expect(eventTimeToPerfSec(50_000, 50_060)).toBeCloseTo(50.0, 9);
  });

  it('falls back to now for an epoch-style timestamp', () => {
    expect(eventTimeToPerfSec(1_760_000_000_000, 50_060)).toBeCloseTo(50.06, 9);
  });

  it('falls back to now for a stale or non-finite timestamp', () => {
    expect(eventTimeToPerfSec(40_000, 50_060)).toBeCloseTo(50.06, 9);
    expect(eventTimeToPerfSec(Number.NaN, 50_060)).toBeCloseTo(50.06, 9);
  });
});
