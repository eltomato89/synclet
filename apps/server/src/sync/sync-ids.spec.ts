import { parseSyncId, toSyncId } from './sync-ids';

const uuid = '3f2b8c1e-1d2a-4c3b-9a8b-0123456789ab';
it('parses and formats sync ids', () => {
  expect(parseSyncId('root')).toEqual({ kind: 'root' });
  expect(parseSyncId(`d_${uuid}`)).toEqual({ kind: 'folder', uuid });
  expect(parseSyncId(`f_${uuid}`)).toEqual({ kind: 'file', uuid });
  expect(parseSyncId('f_not-a-uuid')).toBeNull();
  expect(parseSyncId('personal')).toBeNull();
  expect(toSyncId({ id: uuid, type: 'folder' })).toBe(`d_${uuid}`);
});
