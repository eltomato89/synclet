import { expect, it } from 'vitest';
import { safeNext } from './next';

it('accepts same-origin paths only', () => {
  expect(safeNext('/files/d_1?x=1')).toBe('/files/d_1?x=1');
  expect(safeNext(null)).toBe('/files');
  expect(safeNext('https://evil.example')).toBe('/files');
  expect(safeNext('//evil.example')).toBe('/files');
  expect(safeNext('/\\evil.example')).toBe('/files');
  expect(safeNext('/login?next=/x')).toBe('/files');
});
