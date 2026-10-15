import { expect, it } from 'vitest';
import { formatBytes } from './format';

it('formats bytes in binary units with locale separators', () => {
  expect(formatBytes(0, 'de')).toBe('0 B');
  expect(formatBytes(1536, 'de')).toBe('1,5 KB');
  expect(formatBytes(5 * 1024 ** 3, 'en')).toBe('5 GB');
});
