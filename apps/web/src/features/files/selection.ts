import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * Multi-selection of a file list (Finder-like). Pure logic: ranges follow `order`, the list as
 * currently displayed (sorted). `anchor` is where a Shift range starts, `focus` the keyboard item.
 */
export interface SelectionState { selected: ReadonlySet<string>; anchor: string | null; focus: string | null }

export const EMPTY_SELECTION: SelectionState = { selected: new Set(), anchor: null, focus: null };

export type SelectionAction =
  | { type: 'click'; id: string; toggle?: boolean; range?: boolean }
  | { type: 'move'; to: string; extend?: boolean; focusOnly?: boolean }
  | { type: 'toggleFocus' }
  | { type: 'all' }
  | { type: 'clear' }
  | { type: 'only'; id: string }
  | { type: 'focus'; id: string };

/** Items from `a` to `b` (inclusive) in display order; just `b` when `a` is not listed. */
function span(order: readonly string[], a: string, b: string): string[] {
  const i = order.indexOf(a);
  const j = order.indexOf(b);
  if (i < 0 || j < 0) return [b];
  return order.slice(Math.min(i, j), Math.max(i, j) + 1);
}

function toggled(set: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(set);
  if (!next.delete(id)) next.add(id);
  return next;
}

export function reduceSelection(s: SelectionState, a: SelectionAction, order: readonly string[]): SelectionState {
  const listed = (id: string | null) => (id !== null && order.includes(id) ? id : null);
  switch (a.type) {
    case 'click': {
      const anchor = listed(s.anchor) ?? listed(s.focus);
      if (a.range && anchor) {
        const range = span(order, anchor, a.id);
        return { selected: a.toggle ? new Set([...s.selected, ...range]) : new Set(range), anchor, focus: a.id };
      }
      if (a.toggle) return { selected: toggled(s.selected, a.id), anchor: a.id, focus: a.id };
      return { selected: new Set([a.id]), anchor: a.id, focus: a.id };
    }
    case 'move': {
      if (a.focusOnly) return { ...s, focus: a.to };
      if (a.extend) {
        const anchor = listed(s.anchor) ?? listed(s.focus) ?? a.to;
        return { selected: new Set(span(order, anchor, a.to)), anchor, focus: a.to };
      }
      return { selected: new Set([a.to]), anchor: a.to, focus: a.to };
    }
    case 'toggleFocus':
      return s.focus ? { selected: toggled(s.selected, s.focus), anchor: s.focus, focus: s.focus } : s;
    case 'all':
      return { selected: new Set(order), anchor: s.anchor, focus: s.focus };
    case 'clear':
      return { selected: new Set(), anchor: null, focus: s.focus };
    case 'only':
      return { selected: new Set([a.id]), anchor: a.id, focus: a.id };
    case 'focus':
      return s.focus === a.id ? s : { ...s, focus: a.id };
  }
}

/** Removes items that are no longer listed (deleted, moved away); unchanged state is returned as is. */
export function pruneSelection(s: SelectionState, order: readonly string[]): SelectionState {
  const present = new Set(order);
  const keep = [...s.selected].filter((id) => present.has(id));
  const anchor = s.anchor !== null && present.has(s.anchor) ? s.anchor : null;
  const focus = s.focus !== null && present.has(s.focus) ? s.focus : null;
  if (keep.length === s.selected.size && anchor === s.anchor && focus === s.focus) return s;
  return { selected: new Set(keep), anchor, focus };
}

export function useSelection(order: readonly string[]) {
  const [state, setState] = useState<SelectionState>(EMPTY_SELECTION);
  const orderRef = useRef(order);
  orderRef.current = order;
  useEffect(() => { setState((s) => pruneSelection(s, order)); }, [order]);
  const dispatch = useCallback((a: SelectionAction) => {
    setState((s) => reduceSelection(pruneSelection(s, orderRef.current), a, orderRef.current));
  }, []);
  const selectedIds = useMemo(() => order.filter((id) => state.selected.has(id)), [order, state.selected]);
  const isSelected = useCallback((id: string) => state.selected.has(id), [state.selected]);
  return { state, dispatch, selectedIds, count: selectedIds.length, isSelected };
}
