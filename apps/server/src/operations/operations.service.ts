import { Injectable } from '@nestjs/common';
import { Prisma, type Item } from '@prisma/client';
import type { CreateOperationRequest, ResolveOperationRequest, SyncOperation } from '@synclet/shared';
import { lstat, statfs } from 'node:fs/promises';
import { z } from 'zod';
import { UUID } from '../common/ids';
import { InsufficientStorageError } from '../common/storage-errors';
import { SyncError } from '../common/sync-error';
import type { AuthUser, IndexSpace } from '../common/types';
import { ItemStore } from '../journal/item-store';
import { PrismaService } from '../prisma/prisma.service';
import { ItemResolver, type Resolved } from '../sync/item-resolver';
import { ROOT_ID, spaceRootId, toSyncId } from '../sync/sync-ids';
import { ACTIVE_STATUSES, serializeOperation, type StoredConflict, subtreeSize } from './operation-types';
import { OperationsRunner } from './operations.runner';

export const MAX_OPERATION_ITEMS = 10_000;
export const CreateOperationBody = z.object({
  kind: z.enum(['copy', 'move', 'delete']),
  itemIds: z.array(z.string()).min(1).max(MAX_OPERATION_ITEMS),
  targetId: z.string().optional(),
});
export const ResolveOperationBody = z.object({ action: z.enum(['replace', 'keepBoth', 'skip']), applyToAll: z.boolean() });

type Source = Resolved & { item: Item };

@Injectable()
export class OperationsService {
  /** Free bytes on the file system of `dir` (replaced in tests). */
  freeBytes = async (dir: string): Promise<bigint> => {
    const s = await statfs(dir, { bigint: true });
    return s.bavail * s.bsize;
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: ItemResolver,
    private readonly store: ItemStore,
    private readonly runner: OperationsRunner,
  ) {}

  /** Synchronous checks (SPEC §2.4), then a queued operation; nothing is changed on disk here. */
  async create(user: AuthUser, body: CreateOperationRequest): Promise<SyncOperation> {
    if (new Set(body.itemIds).size !== body.itemIds.length) throw new SyncError('invalid_request', 'duplicate item ids');
    if ((body.kind === 'delete') !== (body.targetId === undefined)) throw new SyncError('invalid_request', 'targetId is required for copy and move, and not allowed for delete');
    const need = body.kind === 'copy' ? 'read' : 'write';
    const sources: Source[] = [];
    for (const id of body.itemIds) {
      const r = await this.resolver.resolve(user, id, need);
      if (!r.item) throw new SyncError('invalid_request', 'a space root cannot be copied, moved or deleted');
      sources.push(r as Source);
    }
    let target: Resolved | null = null;
    if (body.targetId !== undefined) {
      target = await this.resolver.resolve(user, body.targetId, 'write');
      if (target.item && target.item.type !== 'folder') throw new SyncError('invalid_request', 'target is not a folder');
      const t = target.item;
      for (const s of sources) {
        if (!t || s.item.type !== 'folder' || s.space.id !== target.space.id) continue;
        if (t.path === s.item.path || t.path.startsWith(`${s.item.path}/`)) throw new SyncError('invalid_target', 'a folder cannot be copied or moved into itself');
      }
    }
    let totalItems = 0;
    let totalBytes = 0n;
    let crossBytes = 0n;
    const devs = new Map<string, bigint>();
    const devOf = async (sp: IndexSpace) => {
      if (!devs.has(sp.id)) devs.set(sp.id, (await lstat(sp.rootPath, { bigint: true })).dev);
      return devs.get(sp.id)!;
    };
    for (const s of sources) {
      const { items, bytes } = await subtreeSize(this.prisma, this.store, s.space.id, s.item);
      totalItems += items;
      totalBytes += bytes;
      if (target && body.kind === 'move' && s.space.id !== target.space.id && (await devOf(s.space)) !== (await devOf(target.space))) crossBytes += bytes;
    }
    const needed = body.kind === 'copy' ? totalBytes : crossBytes;
    if (target && needed > 0n && needed > (await this.freeBytes(target.space.rootPath))) {
      throw new InsufficientStorageError('not enough free space at the target');
    }
    const op = await this.prisma.operation.create({
      data: {
        userId: user.id, kind: body.kind, status: 'queued',
        sourceIds: sources.map((s) => toSyncId(s.item)),
        targetId: target ? this.targetSyncId(target) : null,
        targetName: target ? await this.targetName(target) : null,
        totalItems, totalBytes,
      },
    });
    this.runner.kick();
    return serializeOperation(op);
  }

  private targetSyncId(t: Resolved): string {
    if (t.item) return toSyncId(t.item);
    return t.space.kind === 'personal' ? ROOT_ID : spaceRootId(t.space.id);
  }

  private async targetName(t: Resolved): Promise<string | null> {
    if (t.item) return t.item.name;
    if (t.space.kind === 'personal') return null;
    return (await this.prisma.space.findUnique({ where: { id: t.space.id }, select: { name: true } }))?.name ?? null;
  }

  async list(user: AuthUser, activeOnly: boolean): Promise<SyncOperation[]> {
    const rows = await this.prisma.operation.findMany({
      where: { userId: user.id, ...(activeOnly ? { status: { in: ACTIVE_STATUSES } } : {}) },
      orderBy: { createdAt: 'desc' }, take: 50,
    });
    return rows.map(serializeOperation);
  }

  private async own(user: AuthUser, id: string) {
    const op = UUID.test(id) ? await this.prisma.operation.findFirst({ where: { id, userId: user.id } }) : null;
    if (!op) throw new SyncError('not_found');
    return op;
  }

  async get(user: AuthUser, id: string): Promise<SyncOperation> {
    return serializeOperation(await this.own(user, id));
  }

  /** Answers the open conflict of a waiting operation and queues it again. */
  async resolve(user: AuthUser, id: string, body: ResolveOperationRequest): Promise<SyncOperation> {
    const op = await this.own(user, id);
    const conflict = op.conflict as StoredConflict | null;
    if (op.status !== 'waiting' || !conflict) throw new SyncError('conflict', 'operation is not waiting for a decision', undefined, 409);
    if (body.action === 'replace' && !conflict.canReplace) throw new SyncError('invalid_request', 'this item cannot be replaced');
    const updated = await this.prisma.operation.updateMany({
      where: { id, status: 'waiting' },
      data: body.applyToAll
        ? { status: 'queued', policy: body.action, conflict: Prisma.DbNull }
        : { status: 'queued', conflict: { ...conflict, decision: body.action } as unknown as Prisma.InputJsonValue },
    });
    if (updated.count === 0) throw new SyncError('conflict', 'operation is not waiting for a decision', undefined, 409);
    this.runner.kick();
    return this.get(user, id);
  }

  /** Cancels a queued, waiting or running operation; finished ones stay as they are. */
  async cancel(user: AuthUser, id: string): Promise<SyncOperation> {
    await this.own(user, id);
    await this.prisma.operation.updateMany({
      where: { id, userId: user.id, status: { in: ACTIVE_STATUSES } },
      data: { status: 'cancelled', finishedAt: new Date() },
    });
    this.runner.cancelRunning(id);
    return this.get(user, id);
  }
}
