import { apiSpaceId, spaceIdFromApi } from '../spaces/space-ids';
import { parseRootId, parseSyncId, spaceRootId, toSyncId } from './sync-ids';

const uuid = '3f2b8c1e-1d2a-4c3b-9a8b-0123456789ab';
it('parses and formats sync ids', () => {
  expect(parseSyncId('root')).toEqual({ kind: 'root' });
  expect(parseSyncId(`d_${uuid}`)).toEqual({ kind: 'folder', uuid });
  expect(parseSyncId(`f_${uuid}`)).toEqual({ kind: 'file', uuid });
  expect(parseSyncId('f_not-a-uuid')).toBeNull();
  expect(parseSyncId('personal')).toBeNull();
  expect(toSyncId({ id: uuid, type: 'folder' })).toBe(`d_${uuid}`);
});

it('formats and parses space root ids', () => {
  expect(spaceRootId(uuid)).toBe(`r_${uuid}`);
  expect(parseRootId(`r_${uuid}`)).toBe(uuid);
  expect(parseRootId('r_nope')).toBeNull();
  expect(parseRootId('root')).toBeNull();
  expect(parseSyncId(`r_${uuid}`)).toBeNull(); // item ids stay d_/f_/root
});

it('maps API space ids', () => {
  const user = { id: '11111111-1111-4111-8111-111111111111' };
  expect(apiSpaceId({ id: user.id }, user)).toBe('personal');
  expect(apiSpaceId({ id: uuid }, user)).toBe(uuid);
  expect(spaceIdFromApi(user, 'personal')).toBe(user.id);
  expect(spaceIdFromApi(user, uuid)).toBe(uuid);
  expect(spaceIdFromApi(user, 'nope')).toBeNull();
  expect(spaceIdFromApi(user, undefined)).toBeNull();
});
