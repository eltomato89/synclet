import { describe, expect, it, vi } from 'vitest';
import { type UploadTransport, UploadQueue } from './uploads';

class FakeXHR {
  static instances: FakeXHR[] = [];
  upload = { onprogress: null as null | ((e: { loaded: number; total: number }) => void) };
  onload: null | (() => void) = null; onerror: null | (() => void) = null;
  status = 0; responseText = '';
  open() {} setRequestHeader() {}
  send() { FakeXHR.instances.push(this); }
  abort() {}
}
const RAW: UploadTransport = { Upload: class {} as unknown as UploadTransport['Upload'], supported: false };
const file = (name: string) => new File(['x'], name, { lastModified: 0 });

function setup() {
  FakeXHR.instances = [];
  vi.stubGlobal('XMLHttpRequest', FakeXHR as unknown as typeof XMLHttpRequest);
  return new UploadQueue(() => 'tok', () => {}, undefined, RAW);
}
const finish = (x: FakeXHR) => { x.status = 201; x.responseText = JSON.stringify({ id: 'f_x' }); x.onload?.(); };

describe('UploadQueue folder groups', () => {
  it('tracks a folder upload from folder creation to its files', () => {
    const q = setup();
    const g = q.addGroup('Urlaub');
    expect(q.groupSnapshot()).toEqual([{ id: g, name: 'Urlaub', state: 'creating', errors: [] }]);
    q.updateGroup(g, { name: 'Urlaub (2)' });
    q.enqueue([file('a.jpg'), file('b.jpg')], 'd_1', g);
    q.updateGroup(g, { state: 'ready', errors: [{ path: 'Urlaub/X', code: 'invalid_name', files: 1 }] });
    expect(q.snapshot().map((t) => t.groupId)).toEqual([g, g]);
    expect(q.groupSnapshot()[0]).toMatchObject({ name: 'Urlaub (2)', state: 'ready', errors: [{ path: 'Urlaub/X' }] });
    expect(q.hasGroup(g)).toBe(true);
  });

  it('clearFinished drops finished groups only, clearInactive also those with errors', () => {
    const q = setup();
    const done = q.addGroup('A');
    const creating = q.addGroup('B');
    const withErr = q.addGroup('C');
    q.enqueue([file('a.jpg')], 'd_1', done);
    q.updateGroup(done, { state: 'ready' });
    q.updateGroup(withErr, { state: 'ready', errors: [{ path: 'C', code: 'forbidden', files: 2 }] });
    finish(FakeXHR.instances[0]);
    q.clearFinished();
    expect(q.groupSnapshot().map((x) => x.name)).toEqual(['B', 'C']);
    q.clearInactive();
    expect(q.groupSnapshot().map((x) => x.name)).toEqual(['B']);
    expect(q.hasGroup(creating)).toBe(true);
  });

  it('cancelGroup removes the group and all its tasks', () => {
    const q = setup();
    const g = q.addGroup('A');
    q.enqueue([file('a'), file('b'), file('c'), file('d')], 'd_1', g);
    q.enqueue([file('lose')], 'root');
    q.cancelGroup(g);
    expect(q.hasGroup(g)).toBe(false);
    expect(q.snapshot().map((t) => t.file.name)).toEqual(['lose']);
  });
});
