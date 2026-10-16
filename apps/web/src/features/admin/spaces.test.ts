import { expect, it } from 'vitest';
import { addMember, type MemberRow, removeMember, setMemberRole, validateSpaceName } from './forms';

const g: MemberRow = { kind: 'group', id: 'g1', name: 'Team', role: 'read' };
const u: MemberRow = { kind: 'user', id: 'u1', name: 'Anna', role: 'write' };

it('adds a member once, removes it and changes its role', () => {
  let rows = addMember([], g);
  rows = addMember(rows, u);
  expect(addMember(rows, { ...g, role: 'write' })).toEqual(rows);
  // Same id but another kind is a different member.
  expect(addMember(rows, { ...g, kind: 'user' })).toHaveLength(3);
  expect(setMemberRole(rows, 'group:g1', 'write')[0].role).toBe('write');
  expect(removeMember(rows, 'user:u1')).toEqual([g]);
});

it('applies the file name rules to group and space names', () => {
  expect(validateSpaceName('  ')).toBe('required');
  expect(validateSpaceName('')).toBe('required');
  expect(validateSpaceName('a/b')).toBe('invalid');
  expect(validateSpaceName('Projekte.')).toBe('invalid');
  expect(validateSpaceName('Projekte')).toBeNull();
});
