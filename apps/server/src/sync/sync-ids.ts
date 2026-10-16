import type { ItemType } from '@prisma/client';

import { UUID } from '../common/ids';

export { UUID };
export const ROOT_ID = 'root';
const SPACE_ROOT_PREFIX = 'r_';

/** Sync id of the virtual root folder of a (non-personal) space. */
export function spaceRootId(spaceId: string): string {
  return SPACE_ROOT_PREFIX + spaceId;
}

/** The space uuid of a space root id `r_<uuid>`, else null. */
export function parseRootId(raw: string | undefined | null): string | null {
  const id = (raw ?? '').trim();
  if (!id.startsWith(SPACE_ROOT_PREFIX)) return null;
  const uuid = id.slice(SPACE_ROOT_PREFIX.length);
  return UUID.test(uuid) ? uuid : null;
}

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
