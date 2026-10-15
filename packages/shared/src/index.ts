// Wire types of the Synclet Sync API v1 (compatible with Buro SYNC_API v1).
// Types only – consumers use `import type`.

export type SyncErrorCode =
  | 'unauthorized' | 'device_revoked' | 'forbidden' | 'not_found' | 'name_conflict'
  | 'invalid_move' | 'invalid_name' | 'invalid_request' | 'cursor_expired' | 'conflict'
  | 'precondition_required' | 'too_large' | 'range_not_satisfiable' | 'setup_done';

export interface SyncCapabilities {
  read: true; write: boolean; rename: boolean; move: boolean; delete: boolean; addChildren: boolean;
}

export interface SyncItem {
  id: string;
  parentId: string | null;
  type: 'folder' | 'file';
  kind: 'root' | 'folder' | 'file';
  name: string;
  size: number;
  mime: string | null;
  version: number | null;
  sha256: string | null;
  etag: string;
  contentEtag: string | null;
  createdAt: string;
  modifiedAt: string;
  documentId: string | null;
  capabilities: SyncCapabilities;
}

export interface SyncAccount {
  userId: string; email: string | null; displayName: string;
  organizationId: string; organizationName: string; slug: string;
  canWrite: boolean;
  areas: { personal: true; shared: boolean; customers: boolean; projects: boolean };
  quotaBytes: number; usedBytes: number; maxUploadBytes: number;
  cursor: string;
}

export interface SyncDevice {
  id: string; name: string; platform: 'ios' | 'android' | 'macos' | 'windows' | 'linux' | 'web';
  appVersion: string; createdAt: string; lastSeenAt: string | null; current?: boolean;
}

export type SyncChange = { op: 'upsert'; item: SyncItem } | { op: 'delete'; id: string };
export interface SyncChangesPage { changes: SyncChange[]; cursor: string; hasMore: boolean }
export interface SyncChildrenPage { items: SyncItem[]; nextPageToken: string | null; cursor: string }
export interface SyncErrorBody { statusCode: number; message: string; code: SyncErrorCode; item?: SyncItem }

export interface PublicUser {
  id: string; username: string; displayName: string; email: string | null; role: 'admin' | 'user';
}
export interface AuthResponse { accessToken: string; user: PublicUser }
export interface SetupStatus { needsSetup: boolean }
export interface ServerStatus {
  watch: 'active' | 'scan-only' | 'off';
  lastFullScanAt: string | null;
  users: number;
}
