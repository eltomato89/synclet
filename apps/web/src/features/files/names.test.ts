import { expect, it } from 'vitest';
import { baseNameLength, validateName } from './names';

it('mirrors the server name rules', () => {
  expect(validateName('Rechnung 2024.pdf')).toBeNull();
  expect(validateName('')).toBe('empty');
  expect(validateName('a/b')).toBe('forbidden_char');
  expect(validateName('a:b')).toBe('forbidden_char');
  expect(validateName('notes.')).toBe('trailing');
  expect(validateName('CON.txt')).toBe('reserved');
  expect(validateName('ä'.repeat(128))).toBe('too_long');
  expect(validateName('.DS_Store')).toBe('ignored');
});

it('finds the base name length for preselection', () => {
  expect(baseNameLength('report.final.pdf', false)).toBe(12);
  expect(baseNameLength('.env', false)).toBe(4);
  expect(baseNameLength('v1.2', true)).toBe(4);
});
