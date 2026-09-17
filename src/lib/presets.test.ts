import { describe, it, expect } from 'vitest';
import { addPreset, updatePreset, deletePreset, findPreset, isNameTaken, type Preset } from './presets';

interface SongData {
  bpm: number;
}

describe('presets: addPreset', () => {
  it('appends a new preset with a generated id', () => {
    const result = addPreset<SongData>([], 'Song A', { bpm: 128 }, 1000);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Song A');
    expect(result[0].data).toEqual({ bpm: 128 });
    expect(result[0].updatedAt).toBe(1000);
    expect(result[0].id).toBeTruthy();
  });

  it('trims whitespace from the name', () => {
    const result = addPreset<SongData>([], '  Song B  ', { bpm: 90 }, 1000);
    expect(result[0].name).toBe('Song B');
  });

  it('generates distinct ids for successive presets', () => {
    let list = addPreset<SongData>([], 'A', { bpm: 100 }, 1);
    list = addPreset<SongData>(list, 'B', { bpm: 110 }, 2);
    expect(list[0].id).not.toBe(list[1].id);
  });

  it('does not mutate the original array', () => {
    const original: Preset<SongData>[] = [];
    addPreset<SongData>(original, 'A', { bpm: 100 }, 1);
    expect(original).toEqual([]);
  });
});

describe('presets: updatePreset', () => {
  it('updates the name, data, and timestamp of the matching preset', () => {
    const list = addPreset<SongData>([], 'Song A', { bpm: 128 }, 1000);
    const id = list[0].id;
    const updated = updatePreset(list, id, 'Song A (Live)', { bpm: 132 }, 2000);
    expect(updated[0].name).toBe('Song A (Live)');
    expect(updated[0].data).toEqual({ bpm: 132 });
    expect(updated[0].updatedAt).toBe(2000);
    expect(updated[0].id).toBe(id);
  });

  it('is a no-op if the id is not found', () => {
    const list = addPreset<SongData>([], 'Song A', { bpm: 128 }, 1000);
    const updated = updatePreset(list, 'missing-id', 'X', { bpm: 999 }, 2000);
    expect(updated).toEqual(list);
  });

  it('leaves other presets untouched', () => {
    let list = addPreset<SongData>([], 'A', { bpm: 100 }, 1);
    list = addPreset<SongData>(list, 'B', { bpm: 110 }, 2);
    const updated = updatePreset(list, list[0].id, 'A2', { bpm: 105 }, 3);
    expect(updated[1]).toEqual(list[1]);
  });
});

describe('presets: deletePreset', () => {
  it('removes the matching preset', () => {
    let list = addPreset<SongData>([], 'A', { bpm: 100 }, 1);
    list = addPreset<SongData>(list, 'B', { bpm: 110 }, 2);
    const afterDelete = deletePreset(list, list[0].id);
    expect(afterDelete).toHaveLength(1);
    expect(afterDelete[0].name).toBe('B');
  });

  it('is a no-op if the id is not found', () => {
    const list = addPreset<SongData>([], 'A', { bpm: 100 }, 1);
    expect(deletePreset(list, 'missing-id')).toEqual(list);
  });
});

describe('presets: findPreset', () => {
  it('finds a preset by id', () => {
    const list = addPreset<SongData>([], 'A', { bpm: 100 }, 1);
    expect(findPreset(list, list[0].id)?.name).toBe('A');
  });

  it('returns undefined for a missing id', () => {
    const list = addPreset<SongData>([], 'A', { bpm: 100 }, 1);
    expect(findPreset(list, 'nope')).toBeUndefined();
  });
});

describe('presets: isNameTaken', () => {
  it('detects an exact name match', () => {
    const list = addPreset<SongData>([], 'Song A', { bpm: 128 }, 1);
    expect(isNameTaken(list, 'Song A')).toBe(true);
  });

  it('is case-insensitive', () => {
    const list = addPreset<SongData>([], 'Song A', { bpm: 128 }, 1);
    expect(isNameTaken(list, 'song a')).toBe(true);
  });

  it('is false for a genuinely new name', () => {
    const list = addPreset<SongData>([], 'Song A', { bpm: 128 }, 1);
    expect(isNameTaken(list, 'Song B')).toBe(false);
  });

  it('excludes the given id, for renaming a preset to its own name', () => {
    const list = addPreset<SongData>([], 'Song A', { bpm: 128 }, 1);
    expect(isNameTaken(list, 'Song A', list[0].id)).toBe(false);
  });
});
