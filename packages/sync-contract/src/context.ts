import { inject } from 'vitest';
import { expectStatus, randomSuffix, SyncletClient } from './client.js';
import type { SyncItem } from '@synclet/shared';

export interface ContractContext {
  baseUrl: string;
  /** Device token of the suite's own device (`syd_…`). */
  token: string;
  deviceId: string;
  /** Web access token (JWT), when the suite signed in with a password or got one as SYNCLET_TOKEN. */
  webToken: string | null;
  /** Credentials for the password-based app login test, when known. */
  login: { login: string; password: string } | null;
  /** The suite's top-level folder `contract-<random>`. */
  folderId: string;
  folderName: string;
  /** Reason to skip the thumbnail tests, or null. */
  skipThumbnails: string | null;
  thumbnailTimeoutMs: number;
}

declare module 'vitest' {
  export interface ProvidedContext {
    contract: ContractContext;
  }
}

export function contract(): { ctx: ContractContext; api: SyncletClient } {
  const ctx = inject('contract');
  return { ctx, api: new SyncletClient(ctx.baseUrl, ctx.token) };
}

/** Creates a fresh folder `<prefix>-<random>` inside the suite folder (one per test file or test). */
export async function scratchFolder(api: SyncletClient, ctx: ContractContext, prefix: string): Promise<SyncItem> {
  return expectStatus(await api.mkdir(ctx.folderId, `${prefix}-${randomSuffix()}`), 201, `create ${prefix} folder`).json<SyncItem>();
}

/** Uploads a file and returns the item (throws unless 201). */
export async function uploadFile(api: SyncletClient, parentId: string, name: string, data: Uint8Array | string): Promise<SyncItem> {
  return expectStatus(await api.upload(parentId, name, data), 201, `upload ${name}`).json<SyncItem>();
}

/** Drains /changes from `cursor` (following hasMore) and returns all changes plus the final cursor. */
export async function drainChanges(api: SyncletClient, cursor: string, limit = 500) {
  const changes: ({ op: 'upsert'; item: SyncItem } | { op: 'delete'; id: string })[] = [];
  let c = cursor;
  for (let i = 0; i < 1000; i++) {
    const page = expectStatus(await api.get(`/sync/v1/changes?cursor=${c}&limit=${limit}`), 200, 'changes').json<{ changes: typeof changes; cursor: string; hasMore: boolean }>();
    changes.push(...page.changes);
    c = page.cursor;
    if (!page.hasMore) break;
  }
  return { changes, cursor: c };
}
