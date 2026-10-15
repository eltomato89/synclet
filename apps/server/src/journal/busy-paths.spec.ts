import { BusyPaths } from './busy-paths';

it('covers a path and its descendants until released', () => {
  const b = new BusyPaths();
  const release = b.add('u1', 'a/b');
  expect(b.covers('u1', 'a/b')).toBe(true);
  expect(b.covers('u1', 'a/b/c.txt')).toBe(true);
  expect(b.covers('u1', 'a/bc')).toBe(false);
  expect(b.covers('u2', 'a/b')).toBe(false);
  release();
  expect(b.covers('u1', 'a/b')).toBe(false);
});
