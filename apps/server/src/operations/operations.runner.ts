import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { type Item, type Operation, Prisma } from '@prisma/client';
import type { ConflictAction, OperationConflict, OperationResult } from '@synclet/shared';
import { APP_CONFIG, AppConfig } from '../config';
import { freeName, nameKey } from '../common/names';
import { SyncError } from '../common/sync-error';
import type { IndexSpace } from '../common/types';
import { FilesService } from '../files/files.service';
import { ItemStore } from '../journal/item-store';
import { PrismaService } from '../prisma/prisma.service';
import { ItemResolver, type Resolved } from '../sync/item-resolver';
import { toSyncId } from '../sync/sync-ids';
import { type StoredConflict, subtreeSize } from './operation-types';

export const MAX_PARALLEL_OPERATIONS = 2;
const PROGRESS_EVERY_MS = 500;
const POLL_MS = 5_000;

type Step =
  | { kind: 'result'; result: OperationResult }
  | { kind: 'waiting'; conflict: OperationConflict }
  | { kind: 'abort'; error: string }
  | { kind: 'cancelled' };
interface ItemRun { step: Step; items: number; bytes: bigint }

const isAbort = (e: unknown) => (e as Error | null)?.name === 'AbortError';
const json = (v: unknown) => v as Prisma.InputJsonValue;

/**
 * Executes operations in the server process (the worker mounts the data read-only). Claims queued
 * operations with SKIP LOCKED – at most one running per user, MAX_PARALLEL_OPERATIONS in total –
 * and works through `sourceIds` from `nextIndex`, one top-level item at a time (each item all or
 * nothing). Rights are checked again per item. A name conflict without a decision parks the
 * operation as `waiting`; `cancelled` (set by the API) stops it between two items or files.
 */
@Injectable()
export class OperationsRunner implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(OperationsRunner.name);
  private readonly active = new Map<string, AbortController>();
  private readonly jobs = new Set<Promise<void>>();
  private ticking: Promise<void> | null = null;
  private timer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
    private readonly resolver: ItemResolver,
    private readonly store: ItemStore,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onApplicationBootstrap() {
    if (!this.config.background) return;
    const n = await this.recover();
    if (n) this.log.log(`resuming ${n} interrupted operation(s)`);
    this.timer = setInterval(() => this.kick(), POLL_MS);
    this.kick();
  }

  async onModuleDestroy() {
    this.stopped = true;
    clearInterval(this.timer);
    for (const c of this.active.values()) c.abort();
    await Promise.allSettled([...this.jobs]);
  }

  /** After a crash or restart: operations that were running continue at their nextIndex. */
  async recover(): Promise<number> {
    return (await this.prisma.operation.updateMany({ where: { status: 'running' }, data: { status: 'queued' } })).count;
  }

  kick(): void {
    if (this.stopped || this.ticking) return;
    this.ticking = this.tick().catch((e) => this.log.error(`operations tick failed: ${(e as Error).message}`)).finally(() => { this.ticking = null; });
  }

  cancelRunning(id: string): void {
    this.active.get(id)?.abort();
  }

  async idle(): Promise<void> {
    for (;;) {
      await this.ticking;
      if (this.jobs.size === 0) {
        this.kick();
        await this.ticking;
        if (this.jobs.size === 0) return;
      }
      await Promise.allSettled([...this.jobs]);
    }
  }

  private async tick(): Promise<void> {
    while (!this.stopped && this.active.size < MAX_PARALLEL_OPERATIONS) {
      const id = await this.claim();
      if (!id) return;
      const ctl = new AbortController();
      this.active.set(id, ctl);
      const job: Promise<void> = this.execute(id, ctl.signal)
        .catch(async (e) => {
          this.log.error(`operation ${id} failed: ${(e as Error).stack ?? String(e)}`);
          await this.finish(id, 'failed', { error: 'internal' }).catch(() => {});
        })
        .finally(() => {
          this.active.delete(id);
          this.jobs.delete(job);
          this.kick();
        });
      this.jobs.add(job);
    }
  }

  /** Oldest queued operation of a user with nothing running, marked running (null = none). */
  private async claim(): Promise<string | null> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      UPDATE "Operation" SET status = 'running', "updatedAt" = now()
      WHERE id = (
        SELECT o.id FROM "Operation" o
        WHERE o.status = 'queued'
          AND NOT EXISTS (SELECT 1 FROM "Operation" r WHERE r."userId" = o."userId" AND r.status = 'running')
        ORDER BY o."createdAt", o.id
        LIMIT 1
        FOR UPDATE SKIP LOCKED)
      RETURNING id`;
    return rows[0]?.id ?? null;
  }

  /** Writes progress while still running; false = the operation was cancelled meanwhile. */
  private async save(id: string, data: Prisma.OperationUpdateManyMutationInput): Promise<boolean> {
    return (await this.prisma.operation.updateMany({ where: { id, status: 'running' }, data })).count > 0;
  }

  /** Progress after a finished item, also for a cancelled operation; false = stop (no longer running). */
  private async saveItemDone(id: string, data: Prisma.OperationUpdateManyMutationInput): Promise<boolean> {
    await this.prisma.operation.updateMany({ where: { id, status: { in: ['running', 'cancelled'] } }, data });
    return (await this.prisma.operation.findUnique({ where: { id }, select: { status: true } }))?.status === 'running';
  }

  private async finish(id: string, status: 'done' | 'failed', data: Prisma.OperationUpdateManyMutationInput): Promise<void> {
    await this.save(id, { ...data, status, finishedAt: new Date() });
  }

  private async execute(id: string, signal: AbortSignal): Promise<void> {
    const op = await this.prisma.operation.findUnique({ where: { id } });
    if (!op || op.status !== 'running') return;
    const results = [...((op.results ?? []) as unknown as OperationResult[])];
    let doneItems = op.doneItems;
    let doneBytes = op.doneBytes;
    const answered = op.conflict as StoredConflict | null;
    let lastWrite = 0;
    for (let i = op.nextIndex; i < op.sourceIds.length; i++) {
      if (signal.aborted) return;
      const sourceId = op.sourceIds[i];
      const decision = answered?.decision && answered.sourceId === sourceId ? answered.decision : (op.policy as ConflictAction | null);
      let copied = 0n;
      const base = doneBytes;
      const onBytes = (n: number) => {
        copied += BigInt(n);
        if (Date.now() - lastWrite < PROGRESS_EVERY_MS) return;
        lastWrite = Date.now();
        void this.save(id, { doneBytes: base + copied }).catch(() => {});
      };
      const run = await this.runItem(op, sourceId, decision, signal, onBytes);
      const step = run.step;
      if (step.kind === 'cancelled') return;
      if (step.kind === 'waiting') {
        await this.save(id, { status: 'waiting', conflict: json(step.conflict), nextIndex: i, doneItems, doneBytes, results: json(results) });
        return;
      }
      if (step.kind === 'abort') {
        await this.finish(id, 'failed', { error: step.error, nextIndex: i, doneItems, doneBytes, results: json(results) });
        return;
      }
      results.push(step.result);
      doneItems += run.items;
      doneBytes = base + run.bytes;
      // Recorded even when the operation was cancelled during this item: it is done on disk.
      if (!(await this.saveItemDone(id, { nextIndex: i + 1, doneItems, doneBytes, results: json(results), conflict: Prisma.DbNull }))) return;
    }
    await this.finish(id, 'done', {});
  }

  private async runItem(op: Operation, sourceId: string, decision: ConflictAction | null, signal: AbortSignal, onBytes: (n: number) => void): Promise<ItemRun> {
    const user = { id: op.userId };
    let src: Resolved & { item: Item };
    try {
      const r = await this.resolver.resolve(user, sourceId, op.kind === 'copy' ? 'read' : 'write');
      if (!r.item) throw new SyncError('invalid_request');
      src = r as Resolved & { item: Item };
    } catch (e) {
      return { step: { kind: 'result', result: { sourceId, name: '', outcome: 'failed', error: e instanceof SyncError ? e.code : 'read_error' } }, items: 1, bytes: 0n };
    }
    const name = src.item.name;
    const { items, bytes } = await subtreeSize(this.prisma, this.store, src.space.id, src.item);
    const result = (outcome: OperationResult['outcome'], extra: Partial<OperationResult> = {}): ItemRun =>
      ({ step: { kind: 'result', result: { sourceId, name, outcome, ...extra } }, items, bytes });
    const abort = (error: string): ItemRun => ({ step: { kind: 'abort', error }, items, bytes });
    const onError = async (e: unknown): Promise<ItemRun> => {
      if (isAbort(e)) return { step: { kind: 'cancelled' }, items, bytes };
      if (e instanceof SyncError && e.code === 'insufficient_storage') return abort('storage_full');
      if (e instanceof SyncError && e.code === 'space_unavailable') return abort('space_unavailable');
      if (op.kind !== 'delete' && e instanceof SyncError && e.code === 'not_found' && !(await this.targetAlive(op))) return abort('target_missing');
      if (!(e instanceof SyncError)) this.log.warn(`operation ${op.id}: ${name}: ${(e as Error).message}`);
      return result('failed', { error: e instanceof SyncError ? e.code : 'read_error' });
    };

    if (op.kind === 'delete') {
      try {
        await this.files.remove(src.space, src.item.id, op.userId);
        return result('done');
      } catch (e) {
        return onError(e);
      }
    }

    let dst: Resolved;
    try {
      dst = await this.resolver.resolve(user, op.targetId ?? '', 'write');
      if (dst.item && dst.item.type !== 'folder') throw new SyncError('not_found');
    } catch (e) {
      const code = e instanceof SyncError ? e.code : '';
      return abort(code === 'forbidden' ? 'target_forbidden' : code === 'space_unavailable' ? 'space_unavailable' : 'target_missing');
    }
    const parentId = dst.item?.id ?? null;
    const sameFolder = src.space.id === dst.space.id && src.item.parentId === parentId;
    if (op.kind === 'move' && sameFolder) return result('done', { resultId: sourceId });
    const action: ConflictAction | null = sameFolder ? 'keepBoth' : decision;

    for (let attempt = 0; attempt < 3; attempt++) {
      const existing = await this.prisma.item.findFirst({
        where: { spaceId: dst.space.id, parentId, nameKey: nameKey(name), deletedAt: null, NOT: { id: src.item.id } },
      });
      if (existing) {
        const canReplace = this.canReplace(op, existing, dst);
        if (!action || (action === 'replace' && !canReplace)) {
          return { step: { kind: 'waiting', conflict: await this.conflictOf(src.item, existing, sourceId, bytes, canReplace) }, items, bytes };
        }
        if (action === 'skip') return result('skipped');
        if (action === 'replace') {
          try {
            await this.files.remove(dst.space, existing.id, op.userId);
          } catch (e) {
            return onError(e);
          }
        }
      }
      try {
        const out = op.kind === 'copy'
          ? await this.files.copy(src.space, dst.space, src.item.id, parentId, { onConflict: action === 'keepBoth' ? 'rename' : 'fail', onProgress: onBytes, signal })
          : await this.files.update(src.space, src.item.id, {
            parentId, targetSpace: dst.space,
            ...(existing && action === 'keepBoth' ? { name: await this.freeNameIn(dst.space, parentId, name, src.item.type === 'folder') } : {}),
          });
        return result('done', { resultId: toSyncId(out) });
      } catch (e) {
        // Taken meanwhile (someone created the name in parallel): look again and decide.
        if (e instanceof SyncError && e.code === 'name_conflict' && attempt < 2) continue;
        return onError(e);
      }
    }
    return result('failed', { error: 'name_conflict' });
  }

  /** "Replace" never trashes one of the operation's own sources or a folder containing the target. */
  private canReplace(op: Operation, existing: Item, dst: Resolved): boolean {
    if (op.sourceIds.some((id) => id.slice(2) === existing.id)) return false;
    const t = dst.item;
    if (existing.type === 'folder' && t && existing.spaceId === dst.space.id && (t.path === existing.path || t.path.startsWith(`${existing.path}/`))) return false;
    return true;
  }

  private async conflictOf(source: Item, existing: Item, sourceId: string, sourceBytes: bigint, canReplace: boolean): Promise<OperationConflict> {
    const ex = await subtreeSize(this.prisma, this.store, existing.spaceId, existing);
    return {
      sourceId, name: source.name, canReplace,
      source: { type: source.type, size: Number(sourceBytes), modifiedAt: source.mtime.toISOString() },
      existing: { id: toSyncId(existing), type: existing.type, size: Number(ex.bytes), modifiedAt: existing.mtime.toISOString() },
    };
  }

  private async freeNameIn(space: IndexSpace, parentId: string | null, name: string, isFolder: boolean): Promise<string> {
    const sibs = await this.store.liveChildren(this.prisma, space.id, parentId);
    return freeName(name, new Set(sibs.map((s) => s.nameKey)), isFolder);
  }

  private async targetAlive(op: Operation): Promise<boolean> {
    try {
      const t = await this.resolver.resolve({ id: op.userId }, op.targetId ?? '', 'write');
      return !t.item || t.item.type === 'folder';
    } catch {
      return false;
    }
  }
}
