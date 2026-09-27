/**
 * Selecting tracks in a list, the same way in every list: a click selects one track, Ctrl/Cmd-click
 * toggles one, and Shift-click (or Shift with the arrow keys) selects the range from the anchor, the
 * track clicked last without Shift.
 */
export type Selection = { readonly ids: readonly string[]; readonly anchor: string | null };

export const emptySelection: Selection = { ids: [], anchor: null };

export type SelectGesture = { readonly toggle?: boolean; readonly range?: boolean };

/** The selection after choosing `id` in a list whose tracks are in `order`. */
export function selectTrack(
  selection: Selection,
  order: readonly string[],
  id: string,
  gesture: SelectGesture = {},
): Selection {
  const anchor = selection.anchor && order.includes(selection.anchor) ? selection.anchor : null;
  if (gesture.range && anchor) {
    const [from, to] = [order.indexOf(anchor), order.indexOf(id)].sort((a, b) => a - b);
    return { ids: order.slice(from, to + 1), anchor };
  }
  if (gesture.toggle) {
    const ids = selection.ids.includes(id) ? selection.ids.filter((other) => other !== id) : [...selection.ids, id];
    return { ids, anchor: id };
  }
  return { ids: [id], anchor: id };
}

/** The selected tracks that are in the list, in list order. */
export function selectedInOrder(selection: Selection, order: readonly string[]) {
  const selected = new Set(selection.ids);
  return order.filter((id) => selected.has(id));
}
