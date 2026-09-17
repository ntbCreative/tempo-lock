import { describe, it, expect } from 'vitest';
import { parseStoredSettings, serializeSettings } from './settingsStorage';

const defaults = { theme: 'amber', volume: 50 };

describe('parseStoredSettings', () => {
  it('returns defaults when raw is null', () => {
    expect(parseStoredSettings(null, defaults)).toEqual(defaults);
  });

  it('returns defaults when raw is invalid JSON', () => {
    expect(parseStoredSettings('{not json', defaults)).toEqual(defaults);
  });

  it('returns defaults when raw parses to a non-object', () => {
    expect(parseStoredSettings('42', defaults)).toEqual(defaults);
    expect(parseStoredSettings('"a string"', defaults)).toEqual(defaults);
    expect(parseStoredSettings('null', defaults)).toEqual(defaults);
  });

  it('returns defaults when raw parses to an array', () => {
    expect(parseStoredSettings('[1,2,3]', defaults)).toEqual(defaults);
  });

  it('merges a valid partial object over the defaults', () => {
    expect(parseStoredSettings('{"theme":"cyan"}', defaults)).toEqual({ theme: 'cyan', volume: 50 });
  });

  it('merges a full valid object, overriding every default', () => {
    expect(parseStoredSettings('{"theme":"cyan","volume":80}', defaults)).toEqual({ theme: 'cyan', volume: 80 });
  });

  it('ignores unknown extra fields by keeping them (shallow merge is intentionally permissive) without dropping known defaults', () => {
    const result = parseStoredSettings('{"theme":"green","extra":"ignored-by-consumer"}', defaults);
    expect(result.theme).toBe('green');
    expect(result.volume).toBe(50);
  });
});

describe('serializeSettings', () => {
  it('round-trips through parseStoredSettings', () => {
    const value = { theme: 'purple', volume: 12 };
    const raw = serializeSettings(value);
    expect(parseStoredSettings(raw, defaults)).toEqual(value);
  });
});
