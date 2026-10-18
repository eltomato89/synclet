import type { SyncOperation } from '@synclet/shared';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import * as apiMod from '@/lib/api';
import i18n from '@/lib/i18n';
import { testQueryClient } from '@/test/query';

const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
vi.mock('sonner', () => ({ toast }));
const { OperationsProvider, useOperations } = await import('./OperationsProvider');

const base: SyncOperation = {
  id: 'o1', kind: 'copy', status: 'queued', targetId: 'd_t', targetName: 'Tausch', itemCount: 3,
  totalItems: 3, doneItems: 0, totalBytes: 30, doneBytes: 0, conflict: null, results: [], error: null,
  createdAt: '2026-10-18T10:00:00Z', finishedAt: null,
};
const done = (p: Partial<SyncOperation> = {}): SyncOperation => ({
  ...base, status: 'done', doneItems: 3, doneBytes: 30, finishedAt: '2026-10-18T10:00:01Z',
  results: ['a', 'b', 'c'].map((n) => ({ sourceId: `f_${n}`, name: n, outcome: 'done' as const })), ...p,
});

let server: { active: SyncOperation[]; byId: Record<string, SyncOperation> };
beforeAll(async () => { await i18n.changeLanguage('en'); });
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  server = { active: [], byId: {} };
  toast.success.mockReset(); toast.error.mockReset();
  vi.spyOn(apiMod, 'api').mockImplementation(async (path: string, opts?: { method?: string; json?: unknown }) => {
    if (path === '/sync/v1/operations?active=1') return server.active;
    if (path === '/sync/v1/operations' && opts?.method === 'POST') { server.active = [base]; return base; }
    const m = /^\/sync\/v1\/operations\/([^/]+)$/.exec(path);
    if (m) { if (server.byId[m[1]]) return server.byId[m[1]]; throw new apiMod.ApiError(404, 'not_found', 'x'); }
    throw new apiMod.ApiError(404, 'not_found', 'x');
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

let ops!: ReturnType<typeof useOperations>;
function Probe() {
  ops = useOperations();
  return <ul>{ops.operations.map((o) => <li key={o.op.id}>{o.op.id}:{o.op.status}:{String(o.conflictOpen)}</li>)}</ul>;
}
function renderProvider() {
  const q = testQueryClient();
  render(<q.wrapper><OperationsProvider><Probe /></OperationsProvider></q.wrapper>);
  return q;
}
const tick = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

it('a fast operation shows only a toast and refreshes the folders', async () => {
  const q = renderProvider();
  await tick(0);
  await act(async () => { await ops.start({ kind: 'copy', itemIds: ['f_a', 'f_b', 'f_c'], targetId: 'd_t' }); });
  server.active = [];
  server.byId.o1 = done();
  await tick(450);
  expect(toast.success).toHaveBeenCalledWith('3 items copied', expect.anything());
  expect(screen.queryByText(/^o1:/)).toBeNull();
  expect(q.invalidated()).toEqual(expect.arrayContaining([['folder'], ['subfolders'], ['trash'], ['account']]));
});

it('a slow operation becomes visible after a second and stays with its final state', async () => {
  renderProvider();
  await tick(0);
  await act(async () => { await ops.start({ kind: 'copy', itemIds: ['f_a'], targetId: 'd_t' }); });
  server.active = [{ ...base, status: 'running' }];
  await tick(1100);
  expect(screen.getByText('o1:running:false')).toBeInTheDocument();
  server.active = [];
  server.byId.o1 = done({ results: [{ sourceId: 'f_a', name: 'a', outcome: 'failed', error: 'not_found' }] });
  await tick(1000);
  expect(screen.getByText('o1:done:false')).toBeInTheDocument();
  expect(toast.success).not.toHaveBeenCalled();
  act(() => ops.dismiss('o1'));
  expect(screen.queryByText(/^o1:/)).toBeNull();
});

it('opens the conflict dialog when an operation starts waiting; polling stops when nothing is active', async () => {
  renderProvider();
  await tick(0);
  await act(async () => { await ops.start({ kind: 'copy', itemIds: ['f_a'], targetId: 'd_t' }); });
  server.active = [{ ...base, status: 'waiting', conflict: { sourceId: 'f_a', name: 'a', canReplace: true, source: { type: 'file', size: 1, modifiedAt: base.createdAt }, existing: { id: 'f_x', type: 'file', size: 2, modifiedAt: base.createdAt } } }];
  await tick(450);
  expect(screen.getByText('o1:waiting:true')).toBeInTheDocument();
  const calls = () => vi.mocked(apiMod.api).mock.calls.filter(([p]) => p === '/sync/v1/operations?active=1').length;
  const before = calls();
  await tick(3000);
  expect(calls()).toBeGreaterThan(before); // still active (waiting): keeps polling
  server.active = [];
  server.byId.o1 = done({ status: 'cancelled' });
  await tick(1000);
  const after = calls();
  await tick(5000);
  expect(calls()).toBe(after);
});

it('an operation that ended and is gone (404) is dropped and polling stops', async () => {
  const q = renderProvider();
  await tick(0);
  await act(async () => { await ops.start({ kind: 'copy', itemIds: ['f_a'], targetId: 'd_t' }); });
  server.active = [{ ...base, status: 'running' }];
  await tick(1100);
  expect(screen.getByText('o1:running:false')).toBeInTheDocument();
  server.active = []; // ended, and its record is already gone (e.g. removed by maintenance)
  await tick(1000);
  expect(screen.queryByText(/^o1:/)).toBeNull();
  expect(q.invalidated()).toEqual(expect.arrayContaining([['folder'], ['trash']]));
  const calls = () => vi.mocked(apiMod.api).mock.calls.filter(([p]) => p === '/sync/v1/operations?active=1').length;
  const after = calls();
  await tick(5000);
  expect(calls()).toBe(after);
});

it('shows operations that were active before a reload', async () => {
  server.active = [{ ...base, status: 'running' }];
  renderProvider();
  await tick(0);
  expect(screen.getByText('o1:running:false')).toBeInTheDocument();
});

it('a failed create shows a translated toast and returns null', async () => {
  vi.mocked(apiMod.api).mockImplementationOnce(async () => []).mockImplementationOnce(async () => { throw new apiMod.ApiError(400, 'invalid_target', 'x'); });
  renderProvider();
  await tick(0);
  let res: unknown = 'x';
  await act(async () => { res = await ops.start({ kind: 'move', itemIds: ['d_a'], targetId: 'd_a' }); });
  expect(res).toBeNull();
  expect(toast.error).toHaveBeenCalledWith('A folder can’t be copied or moved into itself.', expect.anything());
});
