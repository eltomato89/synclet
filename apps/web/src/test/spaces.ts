import type { SyncItem, SyncSpace } from '@synclet/shared';

/** Fixture spaces as `/sync/v1/account` lists them (personal, team, external read-only). */
export const TEAM = '6f1c2b1e-1111-4a2b-8c3d-000000000001';
export const EXT = '6f1c2b1e-2222-4a2b-8c3d-000000000002';
export const SPACES: SyncSpace[] = [
  { id: 'personal', kind: 'personal', name: 'Meine Dateien', rootId: 'root', canWrite: true },
  { id: TEAM, kind: 'shared', name: 'Familie', rootId: `r_${TEAM}`, canWrite: true },
  { id: EXT, kind: 'external', name: 'NAS', rootId: `r_${EXT}`, canWrite: false },
];

const WRITE = { read: true, write: true, rename: true, move: true, delete: true, addChildren: true } as const;
const READ = { read: true, write: false, rename: false, move: false, delete: false, addChildren: false } as const;

/** A SyncItem with sensible defaults; `readOnly` gives it the capabilities of a `read` role. */
export function syncItem(p: Partial<SyncItem> & { id: string; name: string }, readOnly = false): SyncItem {
  return {
    parentId: 'root', type: 'file', kind: 'file', size: 1, mime: null, version: 1, sha256: null, etag: 'e', contentEtag: null,
    createdAt: '2026-10-15T10:00:00Z', modifiedAt: '2026-10-15T10:00:00Z', documentId: null,
    capabilities: { ...(readOnly ? READ : WRITE) },
    ...p,
  };
}
