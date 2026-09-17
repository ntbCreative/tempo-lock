import { describe, it, expect } from 'vitest';
import { resolveClickSound, beatIndexInBar, parseCustomAccentBeats, clapVoiceForKit } from './clickPattern';

describe('clickPattern: accent modes', () => {
  it('"all" plays every beat as a plain click with no accent', () => {
    for (let i = 0; i < 4; i++) {
      expect(resolveClickSound(i, { accentMode: 'all', beatsPerBar: 4 })).toBe('normal');
    }
  });

  it('"first" accents only the downbeat', () => {
    expect(resolveClickSound(0, { accentMode: 'first', beatsPerBar: 4 })).toBe('accent');
    expect(resolveClickSound(1, { accentMode: 'first', beatsPerBar: 4 })).toBe('normal');
    expect(resolveClickSound(2, { accentMode: 'first', beatsPerBar: 4 })).toBe('normal');
    expect(resolveClickSound(3, { accentMode: 'first', beatsPerBar: 4 })).toBe('normal');
  });

  it('"backbeat" claps on 2 and 4, mutes 1 and 3, in 4/4', () => {
    const sounds = [0, 1, 2, 3].map((i) => resolveClickSound(i, { accentMode: 'backbeat', beatsPerBar: 4 }));
    expect(sounds).toEqual(['mute', 'clap', 'mute', 'clap']);
  });

  it('"custom" accents exactly the listed beats and plays normal on the rest', () => {
    const cfg = { accentMode: 'custom' as const, beatsPerBar: 4, customAccentBeats: [0, 2] };
    expect(resolveClickSound(0, cfg)).toBe('accent');
    expect(resolveClickSound(1, cfg)).toBe('normal');
    expect(resolveClickSound(2, cfg)).toBe('accent');
    expect(resolveClickSound(3, cfg)).toBe('normal');
  });

  it('defaults to "first" accent behavior when no config is given', () => {
    expect(resolveClickSound(0)).toBe('accent');
    expect(resolveClickSound(1)).toBe('normal');
  });
});

describe('clickPattern: beatIndexInBar', () => {
  it('wraps click index into the bar for a 4-beat signature', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((i) => beatIndexInBar(i, 4))).toEqual([0, 1, 2, 3, 0, 1, 2, 3]);
  });

  it('wraps correctly for a 3-beat signature (3/4 time)', () => {
    expect([0, 1, 2, 3, 4, 5].map((i) => beatIndexInBar(i, 3))).toEqual([0, 1, 2, 0, 1, 2]);
  });

  it('handles a 6-beat signature (6/8 time)', () => {
    expect(beatIndexInBar(7, 6)).toBe(1);
  });
});

describe('clickPattern: parseCustomAccentBeats', () => {
  it('parses a simple comma list into zero-indexed beats', () => {
    expect(parseCustomAccentBeats('1,3', 4)).toEqual([0, 2]);
  });

  it('tolerates spaces around numbers', () => {
    expect(parseCustomAccentBeats(' 1 , 3 ', 4)).toEqual([0, 2]);
  });

  it('drops out-of-range beats', () => {
    expect(parseCustomAccentBeats('1,5,0,-1', 4)).toEqual([0]);
  });

  it('drops non-numeric junk', () => {
    expect(parseCustomAccentBeats('1,x,3', 4)).toEqual([0, 2]);
  });

  it('de-duplicates and sorts', () => {
    expect(parseCustomAccentBeats('3,1,3,1', 4)).toEqual([0, 2]);
  });

  it('returns an empty array for empty input', () => {
    expect(parseCustomAccentBeats('', 4)).toEqual([]);
  });
});

describe('clickPattern: clapVoiceForKit', () => {
  it('keeps the dedicated clap sound for the digital kit', () => {
    expect(clapVoiceForKit('digital')).toBe('digital-clap');
  });

  it('falls back to the kit\'s own accent voice for every other kit', () => {
    expect(clapVoiceForKit('woodblock')).toBe('kit-accent');
    expect(clapVoiceForKit('rimshot')).toBe('kit-accent');
    expect(clapVoiceForKit('cowbell')).toBe('kit-accent');
    expect(clapVoiceForKit('hihat')).toBe('kit-accent');
    expect(clapVoiceForKit('clave')).toBe('kit-accent');
  });
});
