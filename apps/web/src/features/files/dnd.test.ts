import { describe, expect, it } from 'vitest';
import { canDrop, isCopyDrop } from './dnd';

const folder = (id: string, addChildren = true) => ({ id, capabilities: { addChildren } });

describe('drop rules', () => {
  const drag = { ids: ['d_a', 'f_b'], movable: true };
  it('a writable folder that is not dragged and not the current folder takes the drop', () => {
    expect(canDrop(folder('d_x'), drag, 'root')).toBe(true);
    expect(canDrop(folder('d_a'), drag, 'root')).toBe(false); // the dragged folder itself
    expect(canDrop(folder('root'), drag, 'root')).toBe(false); // the current folder (breadcrumb end)
    expect(canDrop(folder('d_x', false), drag, 'root')).toBe(false); // read-only
    expect(canDrop(folder('d_x'), null, 'root')).toBe(false); // no internal drag (e.g. files from the OS)
  });
  it('⌥ or Ctrl copies; items that cannot move are always copied', () => {
    expect(isCopyDrop({ altKey: false, ctrlKey: false }, drag)).toBe(false);
    expect(isCopyDrop({ altKey: true, ctrlKey: false }, drag)).toBe(true);
    expect(isCopyDrop({ altKey: false, ctrlKey: true }, drag)).toBe(true);
    expect(isCopyDrop({ altKey: false, ctrlKey: false }, { ...drag, movable: false })).toBe(true);
  });
});
