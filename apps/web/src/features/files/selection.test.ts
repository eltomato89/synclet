import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EMPTY_SELECTION, pruneSelection, reduceSelection, type SelectionAction, type SelectionState, useSelection } from './selection';

const order = ['a', 'b', 'c', 'd', 'e'];
const run = (actions: SelectionAction[], o: readonly string[] = order, from: SelectionState = EMPTY_SELECTION) =>
  actions.reduce((s, a) => reduceSelection(s, a, o), from);
const sel = (s: SelectionState) => [...s.selected].sort();

describe('reduceSelection', () => {
  it('click selects only the item and sets anchor and focus', () => {
    const s = run([{ type: 'click', id: 'b' }, { type: 'click', id: 'd' }]);
    expect(sel(s)).toEqual(['d']);
    expect([s.anchor, s.focus]).toEqual(['d', 'd']);
  });

  it('⌘-click toggles and moves the anchor', () => {
    const s = run([{ type: 'click', id: 'b' }, { type: 'click', id: 'd', toggle: true }, { type: 'click', id: 'b', toggle: true }]);
    expect(sel(s)).toEqual(['d']);
    expect(s.anchor).toBe('b');
  });

  it('shift-click selects the range from the anchor in both directions and keeps the anchor', () => {
    expect(sel(run([{ type: 'click', id: 'b' }, { type: 'click', id: 'd', range: true }]))).toEqual(['b', 'c', 'd']);
    const s = run([{ type: 'click', id: 'd' }, { type: 'click', id: 'b', range: true }, { type: 'click', id: 'e', range: true }]);
    expect(sel(s)).toEqual(['d', 'e']);
    expect(s.anchor).toBe('d');
  });

  it('⌘-shift-click adds the range to the selection', () => {
    const s = run([{ type: 'click', id: 'a' }, { type: 'click', id: 'c', toggle: true }, { type: 'click', id: 'e', toggle: true, range: true }]);
    expect(sel(s)).toEqual(['a', 'c', 'd', 'e']);
  });

  it('shift-click without an anchor selects just the item', () => {
    expect(sel(run([{ type: 'click', id: 'c', range: true }]))).toEqual(['c']);
  });

  it('keyboard: move selects, extend selects a range, focusOnly + toggleFocus adds single items', () => {
    let s = run([{ type: 'move', to: 'b' }, { type: 'move', to: 'd', extend: true }]);
    expect(sel(s)).toEqual(['b', 'c', 'd']);
    s = run([{ type: 'move', to: 'a' }, { type: 'move', to: 'c', focusOnly: true }, { type: 'toggleFocus' }]);
    expect(sel(s)).toEqual(['a', 'c']);
    expect(s.focus).toBe('c');
  });

  it('all, clear, only, focus', () => {
    const all = run([{ type: 'move', to: 'b' }, { type: 'all' }]);
    expect(sel(all)).toEqual(order);
    expect(all.focus).toBe('b');
    const cleared = reduceSelection(all, { type: 'clear' }, order);
    expect(sel(cleared)).toEqual([]);
    expect(cleared.focus).toBe('b');
    expect(sel(reduceSelection(all, { type: 'only', id: 'e' }, order))).toEqual(['e']);
    const focused = reduceSelection(all, { type: 'focus', id: 'e' }, order);
    expect(sel(focused)).toEqual(order);
    expect(focused.focus).toBe('e');
  });

  it('ranges follow the current display order (after a sort change)', () => {
    const s = run([{ type: 'click', id: 'b' }]);
    expect(sel(reduceSelection(s, { type: 'click', id: 'e', range: true }, ['e', 'a', 'b', 'c', 'd']))).toEqual(['a', 'b', 'e']);
  });
});

describe('pruneSelection', () => {
  it('drops items that left the list; a vanished anchor falls back to the focus', () => {
    const s = run([{ type: 'click', id: 'b' }, { type: 'click', id: 'd', toggle: true }, { type: 'move', to: 'c', focusOnly: true }]);
    const shown = ['a', 'c', 'd', 'e'];
    const p = pruneSelection(s, shown);
    expect(sel(p)).toEqual(['d']);
    expect([p.anchor, p.focus]).toEqual(['d', 'c']);
    const q = pruneSelection(run([{ type: 'click', id: 'b' }, { type: 'move', to: 'c', focusOnly: true }]), shown);
    expect(q.anchor).toBeNull();
    expect(sel(reduceSelection(q, { type: 'click', id: 'e', range: true }, shown))).toEqual(['c', 'd', 'e']);
  });

  it('returns the same object when nothing changed', () => {
    const s = run([{ type: 'click', id: 'b' }]);
    expect(pruneSelection(s, order)).toBe(s);
  });
});

describe('useSelection', () => {
  it('keeps ids in display order and prunes when the order changes', () => {
    const { result, rerender } = renderHook(({ o }) => useSelection(o), { initialProps: { o: order } });
    act(() => result.current.dispatch({ type: 'click', id: 'd' }));
    act(() => result.current.dispatch({ type: 'click', id: 'a', toggle: true }));
    expect(result.current.selectedIds).toEqual(['a', 'd']);
    expect(result.current.count).toBe(2);
    expect(result.current.isSelected('d')).toBe(true);
    rerender({ o: ['b', 'c', 'd'] });
    expect(result.current.selectedIds).toEqual(['d']);
  });
});
