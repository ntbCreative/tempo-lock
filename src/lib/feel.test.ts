import { describe, it, expect } from 'vitest';
import { effectiveTicksPerBeat, stepHalfTimeParity } from './feel';

describe('feel: effectiveTicksPerBeat', () => {
  it('leaves ticks-per-beat unchanged at normal feel', () => {
    expect(effectiveTicksPerBeat(1, 1)).toBe(1);
    expect(effectiveTicksPerBeat(2, 1)).toBe(2);
  });

  it('doubles ticks-per-beat at double-time feel', () => {
    expect(effectiveTicksPerBeat(1, 2)).toBe(2);
    expect(effectiveTicksPerBeat(3, 2)).toBe(6);
  });

  it('leaves ticks-per-beat unchanged at half-time feel (half-time mutes beats, not sub-ticks)', () => {
    expect(effectiveTicksPerBeat(1, 0.5)).toBe(1);
    expect(effectiveTicksPerBeat(2, 0.5)).toBe(2);
  });

  it('treats a zero or negative base as 1', () => {
    expect(effectiveTicksPerBeat(0, 1)).toBe(1);
    expect(effectiveTicksPerBeat(-1, 2)).toBe(2);
  });
});

describe('feel: stepHalfTimeParity', () => {
  it('never mutes at normal feel, and leaves parity untouched', () => {
    expect(stepHalfTimeParity(0, 1)).toEqual({ mute: false, nextParity: 0 });
    expect(stepHalfTimeParity(1, 1)).toEqual({ mute: false, nextParity: 1 });
  });

  it('never mutes at double-time feel, and leaves parity untouched', () => {
    expect(stepHalfTimeParity(0, 2)).toEqual({ mute: false, nextParity: 0 });
    expect(stepHalfTimeParity(1, 2)).toEqual({ mute: false, nextParity: 1 });
  });

  it('alternates mute/play at half-time feel, starting unmuted from parity 0', () => {
    let parity: 0 | 1 = 0;
    let result = stepHalfTimeParity(parity, 0.5);
    expect(result).toEqual({ mute: false, nextParity: 1 });
    parity = result.nextParity;
    result = stepHalfTimeParity(parity, 0.5);
    expect(result).toEqual({ mute: true, nextParity: 0 });
    parity = result.nextParity;
    result = stepHalfTimeParity(parity, 0.5);
    expect(result).toEqual({ mute: false, nextParity: 1 });
  });

  it('produces exactly one mute per two beats over a longer run', () => {
    let parity: 0 | 1 = 0;
    let muted = 0;
    for (let i = 0; i < 20; i++) {
      const result = stepHalfTimeParity(parity, 0.5);
      if (result.mute) muted++;
      parity = result.nextParity;
    }
    expect(muted).toBe(10);
  });
});
