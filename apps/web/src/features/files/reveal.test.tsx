import type { SyncItem } from '@synclet/shared';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { revealUrl, useRevealParam } from './reveal';

afterEach(cleanup);

const file = (id: string) => ({ id, type: 'file', parentId: 'd_p', name: id }) as SyncItem;

describe('revealUrl', () => {
  it('opens folders themselves and files in their parent with ?preview', () => {
    expect(revealUrl({ id: 'd_1', type: 'folder', parentId: 'root' })).toBe('/files/d_1');
    expect(revealUrl({ id: 'f_1', type: 'file', parentId: 'root' })).toBe('/files?preview=f_1');
    expect(revealUrl({ id: 'f_2', type: 'file', parentId: 'd_9' })).toBe('/files/d_9?preview=f_2');
  });
});

function Probe({ items, settled, onReveal }: { items?: SyncItem[]; settled: boolean; onReveal(i: SyncItem): void }) {
  useRevealParam(items, settled, onReveal);
  const loc = useLocation();
  return <output data-testid="loc">{loc.pathname + loc.search}</output>;
}
const mount = (items: SyncItem[] | undefined, settled: boolean, onReveal = vi.fn()) => {
  const r = render(<MemoryRouter initialEntries={['/files/d_p?preview=f_2']}><Probe items={items} settled={settled} onReveal={onReveal} /></MemoryRouter>);
  return { ...r, onReveal };
};

describe('useRevealParam', () => {
  it('reveals the item once it is loaded and drops the parameter', () => {
    const { onReveal, rerender } = mount(undefined, false);
    expect(onReveal).not.toHaveBeenCalled();
    rerender(<MemoryRouter initialEntries={['/files/d_p?preview=f_2']}><Probe items={[file('f_1'), file('f_2')]} settled onReveal={onReveal} /></MemoryRouter>);
    expect(onReveal).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'f_2' }));
    expect(screen.getByTestId('loc')).toHaveTextContent(/^\/files\/d_p$/);
  });

  it('waits for a settled listing before giving up on a missing item', () => {
    const { onReveal } = mount([file('f_1')], false);
    expect(screen.getByTestId('loc')).toHaveTextContent('?preview=f_2');
    expect(onReveal).not.toHaveBeenCalled();
  });

  it('drops the parameter when the settled listing lacks the item', () => {
    const { onReveal } = mount([file('f_1')], true);
    expect(screen.getByTestId('loc')).toHaveTextContent(/^\/files\/d_p$/);
    expect(onReveal).not.toHaveBeenCalled();
  });
});
