import { parseRange } from './range';

it.each([
  [undefined, 100, null],
  ['bytes=0-9', 100, { start: 0, end: 9 }],
  ['bytes=90-', 100, { start: 90, end: 99 }],
  ['bytes=-10', 100, { start: 90, end: 99 }],
  ['bytes=50-500', 100, { start: 50, end: 99 }],
  ['bytes=100-', 100, 'invalid'],
  ['bytes=5-1', 100, 'invalid'],
  ['bytes=0-1,5-6', 100, null],
  ['items=0-1', 100, null],
  ['bytes=0-0', 0, 'invalid'],
])('parseRange(%j, %d)', (h, size, expected) => {
  expect(parseRange(h as string | undefined, size)).toEqual(expected);
});
