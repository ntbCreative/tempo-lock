import { describe, it, expect } from 'vitest';
import { moveItem } from './layoutOrder';

describe('moveItem', () => {
  it('moves an item forward in the array', () => {
    expect(moveItem(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
  });

  it('moves an item backward in the array', () => {
    expect(moveItem(['a', 'b', 'c', 'd'], 3, 1)).toEqual(['a', 'd', 'b', 'c']);
  });

  it('is a no-op when from and to are the same index', () => {
    const arr = ['a', 'b', 'c'];
    expect(moveItem(arr, 1, 1)).toEqual(arr);
  });

  it('is a no-op for an out-of-range fromIndex', () => {
    const arr = ['a', 'b', 'c'];
    expect(moveItem(arr, 5, 0)).toBe(arr);
    expect(moveItem(arr, -1, 0)).toBe(arr);
  });

  it('is a no-op for an out-of-range toIndex', () => {
    const arr = ['a', 'b', 'c'];
    expect(moveItem(arr, 0, 5)).toBe(arr);
    expect(moveItem(arr, 0, -1)).toBe(arr);
  });

  it('does not mutate the original array', () => {
    const arr = ['a', 'b', 'c'];
    moveItem(arr, 0, 2);
    expect(arr).toEqual(['a', 'b', 'c']);
  });

  it('handles moving the last item to the front', () => {
    expect(moveItem(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
  });
});
