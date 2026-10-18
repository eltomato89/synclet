import type { CreateOperationRequest, ResolveOperationRequest, SyncOperation } from '@synclet/shared';
import { useQueryClient } from '@tanstack/react-query';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { errorKey } from '@/features/files/errors';
import { ApiError } from '@/lib/api';
import { cancelOperation, createOperation, getOperation, isActive, listActiveOperations, resolveOperation } from './api';

export const FIRST_POLL_MS = 400;
export const POLL_MS = 1000;
/** An operation finished within this time after its start gets a toast instead of a panel row. */
export const FAST_MS = 1000;
const MAX_BACKOFF_MS = 10_000;

export interface TrackedOperation { op: SyncOperation; visible: boolean; conflictOpen: boolean }
interface Entry extends TrackedOperation { startedAt: number }

export interface OperationsApi {
  operations: TrackedOperation[];
  offline: boolean;
  /** null: create failed and a toast was shown; with throwOnError the error is thrown instead (dialogs show it inline). */
  start(req: CreateOperationRequest, opts?: { throwOnError?: boolean }): Promise<SyncOperation | null>;
  resolve(id: string, body: ResolveOperationRequest): Promise<void>;
  cancel(id: string): Promise<void>;
  dismiss(id: string): void;
  setConflictOpen(id: string, open: boolean): void;
}

const INERT: OperationsApi = {
  operations: [], offline: false,
  start: async () => null, resolve: async () => {}, cancel: async () => {}, dismiss: () => {}, setConflictOpen: () => {},
};
const Ctx = createContext<OperationsApi>(INERT);
export const useOperations = () => useContext(Ctx);

/** Everything an operation may have changed (folders, trash, storage, shares, recent, search). */
const REFRESH = [['folder'], ['subfolders'], ['ancestors'], ['trash'], ['account'], ['shares'], ['recent'], ['search']];

/**
 * Tracks bulk operations of this tab: polls `?active=1` every second while one is active (also
 * those found active at load, e.g. after a reload), refreshes the affected queries when one ends,
 * and decides between a toast (finished within FAST_MS, no failures) and a panel row.
 */
export function OperationsProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [offline, setOffline] = useState(false);
  const ref = useRef(entries);
  ref.current = entries;

  const apply = useCallback((next: Entry[]) => { ref.current = next; setEntries(next); }, []);
  const patch = useCallback((id: string, fn: (e: Entry) => Entry | null) => {
    apply(ref.current.flatMap((e) => (e.op.id === id ? [fn(e)].filter((x): x is Entry => x !== null) : [e])));
  }, [apply]);

  /**
   * Applies fresh server states; side effects for operations that just finished. `gone`: ended
   * operations the server no longer knows (404) – finished, without a final state to show.
   */
  const absorb = useCallback((fresh: SyncOperation[], gone: ReadonlySet<string> = new Set()) => {
    const byId = new Map(fresh.map((o) => [o.id, o]));
    const next: Entry[] = [];
    let ended = false;
    for (const e of ref.current) {
      if (gone.has(e.op.id)) { ended = true; continue; }
      const now = byId.get(e.op.id);
      if (!now) { next.push(e); continue; }
      const wasActive = isActive(e.op);
      const waitingNow = now.status === 'waiting' && e.op.status !== 'waiting';
      let entry: Entry = { ...e, op: now, conflictOpen: waitingNow ? true : now.status === 'waiting' && e.conflictOpen, visible: e.visible || now.status === 'waiting' };
      if (wasActive && !isActive(now)) {
        ended = true;
        const clean = now.status === 'done' && now.results.every((r) => r.outcome !== 'failed');
        if (!entry.visible && clean) {
          const count = now.results.filter((r) => r.outcome === 'done').length;
          toast.success(t(`operations.toast.${now.kind}`, { count }), { position: 'bottom-center' });
          continue; // never shown: no row
        }
        entry = { ...entry, visible: true, conflictOpen: false };
      }
      next.push(entry);
    }
    apply(next);
    if (ended) for (const queryKey of REFRESH) void qc.invalidateQueries({ queryKey });
  }, [apply, qc, t]);

  // Once at load: operations still active from before a reload are shown right away.
  useEffect(() => {
    listActiveOperations().then((list) => {
      const known = new Set(ref.current.map((e) => e.op.id));
      apply([...ref.current, ...list.filter((o) => !known.has(o.id)).map((op) => ({ op, visible: true, conflictOpen: op.status === 'waiting', startedAt: 0 }))]);
    }).catch(() => {});
  }, [apply]);

  const anyActive = entries.some((e) => isActive(e.op));
  useEffect(() => {
    if (!anyActive) return;
    let stopped = false;
    let timer: number | undefined;
    let delay = POLL_MS;
    const poll = async () => {
      try {
        const active = await listActiveOperations();
        const ids = new Set(active.map((o) => o.id));
        const ended = ref.current.filter((e) => isActive(e.op) && !ids.has(e.op.id));
        const gone = new Set<string>();
        const finals = (await Promise.all(ended.map((e) => getOperation(e.op.id).catch((err: unknown) => {
          if (err instanceof ApiError && err.status === 404) gone.add(e.op.id);
          return null;
        })))).filter((o): o is SyncOperation => !!o);
        if (stopped) return;
        setOffline(false);
        delay = POLL_MS;
        absorb([...active, ...finals], gone);
      } catch {
        if (stopped) return;
        setOffline(true);
        delay = Math.min(delay * 2, MAX_BACKOFF_MS);
      }
      if (!stopped) timer = window.setTimeout(() => void poll(), delay);
    };
    timer = window.setTimeout(() => void poll(), FIRST_POLL_MS);
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [anyActive, absorb]);

  const start = useCallback(async (req: CreateOperationRequest, opts: { throwOnError?: boolean } = {}) => {
    try {
      const op = await createOperation(req);
      apply([...ref.current, { op, visible: false, conflictOpen: false, startedAt: Date.now() }]);
      window.setTimeout(() => patch(op.id, (e) => (isActive(e.op) ? { ...e, visible: true } : e)), FAST_MS);
      return op;
    } catch (err) {
      if (opts.throwOnError) throw err;
      toast.error(t(errorKey(err)), { position: 'bottom-center' });
      return null;
    }
  }, [apply, patch, t]);

  const resolve = useCallback(async (id: string, body: ResolveOperationRequest) => {
    const op = await resolveOperation(id, body);
    patch(id, (e) => ({ ...e, op, conflictOpen: false }));
  }, [patch]);

  const cancel = useCallback(async (id: string) => {
    const op = await cancelOperation(id);
    absorb([op]);
  }, [absorb]);

  const value = useMemo<OperationsApi>(() => ({
    operations: entries.filter((e) => e.visible),
    offline,
    start, resolve, cancel,
    dismiss: (id) => patch(id, (e) => (isActive(e.op) ? e : null)),
    setConflictOpen: (id, open) => patch(id, (e) => ({ ...e, conflictOpen: open })),
  }), [entries, offline, start, resolve, cancel, patch]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
