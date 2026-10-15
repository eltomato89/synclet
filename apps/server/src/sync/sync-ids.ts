import type { ItemType } from '@prisma/client';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const ROOT_ID = 'root';

export type ParsedSyncId = { kind: 'root' } | { kind: 'folder' | 'file'; uuid: string };

export function parseSyncId(raw: string | undefined | null): ParsedSyncId | null {
  const id = (raw ?? '').trim();
  if (id === ROOT_ID) return { kind: 'root' };
  const prefix = id.slice(0, 2);
  const uuid = id.slice(2);
  if (!UUID.test(uuid)) return null;
  if (prefix === 'd_') return { kind: 'folder', uuid };
  if (prefix === 'f_') return { kind: 'file', uuid };
  return null;
}

export function toSyncId(item: { id: string; type: ItemType }): string {
  return (item.type === 'folder' ? 'd_' : 'f_') + item.id;
}
