/**
 * Pure "move an item within an array" helper, used by the Settings screen's
 * drag-to-reorder list. Kept separate from any drag/drop event handling so
 * the actual reordering logic is trivially testable.
 */
export function moveItem<T>(items: T[], fromIndex: number, toIndex: number): T[] {
  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= items.length ||
    toIndex >= items.length
  ) {
    return items;
  }
  const copy = [...items];
  const [moved] = copy.splice(fromIndex, 1);
  copy.splice(toIndex, 0, moved);
  return copy;
}
