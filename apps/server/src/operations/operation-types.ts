import type { Item, Operation } from '@prisma/client';
import type { ConflictAction, OperationConflict, OperationKind, OperationResult, OperationStatus, SyncOperation } from '@synclet/shared';
import type { ItemStore } from '../journal/item-store';
import type { Tx } from '../journal/journal.service';

export const ACTIVE_STATUSES: OperationStatus[] = ['queued', 'running', 'waiting'];

/** `conflict` as stored: the open conflict, plus the answer once given without applyToAll. */
export type StoredConflict = OperationConflict & { decision?: ConflictAction };

export function serializeOperation(op: Operation): SyncOperation {
  const stored = op.conflict as StoredConflict | null;
  let conflict: OperationConflict | null = null;
  if (stored && op.status === 'waiting') {
    const { decision: _answered, ...open } = stored;
    conflict = open;
  }
  return {
    id: op.id, kind: op.kind as OperationKind, status: op.status as OperationStatus,
    targetId: op.targetId, targetName: op.targetName, itemCount: op.sourceIds.length,
    totalItems: op.totalItems, doneItems: op.doneItems, totalBytes: Number(op.totalBytes), doneBytes: Number(op.doneBytes),
    conflict, results: (op.results ?? []) as unknown as OperationResult[], error: op.error,
    createdAt: op.createdAt.toISOString(), finishedAt: op.finishedAt?.toISOString() ?? null,
  };
}

/** Number of rows (the item + descendants) and bytes of files in an item's subtree. */
export async function subtreeSize(db: Tx, store: ItemStore, spaceId: string, item: Item): Promise<{ items: number; bytes: bigint }> {
  if (item.type === 'file') return { items: 1, bytes: item.size };
  const rows = await store.liveDescendants(db, spaceId, item.path);
  return { items: 1 + rows.length, bytes: rows.reduce((s, r) => s + (r.type === 'file' ? BigInt(r.size) : 0n), 0n) };
}
