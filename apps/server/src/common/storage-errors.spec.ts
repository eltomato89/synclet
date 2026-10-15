import { InsufficientStorageError, rethrowStorageError } from './storage-errors';
import { SyncError } from './sync-error';

describe('rethrowStorageError', () => {
  it.each(['ENOSPC', 'EDQUOT'])('maps %s to a 507 insufficient_storage', (code) => {
    let caught: unknown;
    try { rethrowStorageError(Object.assign(new Error(code), { code })); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(InsufficientStorageError);
    expect(caught).toBeInstanceOf(SyncError);
    expect(caught).toMatchObject({ status: 507, code: 'insufficient_storage' });
  });
  it('rethrows everything else unchanged', () => {
    const eio = Object.assign(new Error('io'), { code: 'EIO' });
    expect(() => rethrowStorageError(eio)).toThrow(eio);
    const plain = new Error('x');
    expect(() => rethrowStorageError(plain)).toThrow(plain);
    expect(() => rethrowStorageError('str')).toThrow('str');
  });
});
