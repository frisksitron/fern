import { describe, expect, it } from 'vitest';
import { emptySelection, selectTrack, selectedInOrder } from '../../src/lib/music/track-selection';

const order = ['a', 'b', 'c', 'd', 'e'];

describe('selectTrack', () => {
  it('selects only the track clicked, and makes it the anchor', () => {
    expect(selectTrack({ ids: ['a', 'b'], anchor: 'a' }, order, 'c')).toEqual({ ids: ['c'], anchor: 'c' });
  });

  it('toggles one track with Ctrl/Cmd, keeping the rest', () => {
    const selected = selectTrack({ ids: ['a'], anchor: 'a' }, order, 'c', { toggle: true });
    expect(selected).toEqual({ ids: ['a', 'c'], anchor: 'c' });
    expect(selectTrack(selected, order, 'a', { toggle: true })).toEqual({ ids: ['c'], anchor: 'a' });
  });

  it('selects the range from the anchor with Shift, in either direction', () => {
    expect(selectTrack({ ids: ['b'], anchor: 'b' }, order, 'd', { range: true })).toEqual({
      ids: ['b', 'c', 'd'],
      anchor: 'b',
    });
    expect(selectTrack({ ids: ['d'], anchor: 'd' }, order, 'a', { range: true }).ids).toEqual(['a', 'b', 'c', 'd']);
  });

  it('treats Shift without an anchor in the list as a plain selection', () => {
    expect(selectTrack(emptySelection, order, 'c', { range: true })).toEqual({ ids: ['c'], anchor: 'c' });
    expect(selectTrack({ ids: ['x'], anchor: 'x' }, order, 'c', { range: true })).toEqual({ ids: ['c'], anchor: 'c' });
  });
});

describe('selectedInOrder', () => {
  it('lists the selected tracks in the list’s order, ignoring tracks it does not show', () => {
    expect(selectedInOrder({ ids: ['d', 'x', 'a'], anchor: 'a' }, order)).toEqual(['a', 'd']);
  });
});
