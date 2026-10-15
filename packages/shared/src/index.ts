// Wire types of the Synclet Sync API v1 (compatible with Buro SYNC_API v1).
// Types only – consumers use `import type`.

export type SyncErrorCode =
  | 'unauthorized' | 'device_revoked' | 'forbidden' | 'not_found' | 'name_conflict'
  | 'invalid_move' | 'invalid_name' | 'invalid_request' | 'cursor_expired' | 'conflict'
  | 'precondition_required' | 'too_large' | 'range_not_satisfiable' | 'setup_done'
  | 'share_password_required' | 'share_expired' | 'rate_limited' | 'upload_not_allowed';

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
  /** Preview state derived from DerivativeJob; absent = unknown. */
  preview?: PreviewInfo;
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

export interface TrashEntryWire {
  id: string; itemId: string; type: 'folder' | 'file'; name: string;
  originalPath: string; size: number; deletedAt: string; expiresAt: string | null;
  itemCount: number;
}
export interface RestoreResult { item: SyncItem; restoredTo: string; renamed: boolean }

export interface ShareLinkWire {
  id: string; itemId: string; itemName: string; itemType: 'folder' | 'file';
  // Full link: absolute if SYNCLET_PUBLIC_URL is set, else "/s/<token>". Always present for the owner
  // (token stored encrypted, see Task 4 ruling 1b-3).
  url: string;
  hasPassword: boolean; expiresAt: string | null; allowDownload: boolean; allowUpload: boolean;
  createdAt: string; revokedAt: string | null; hits: number;
  /**
   * The shared item is in the trash: the link answers 404 until the item is restored, and
   * restoring re-activates it. Only revoking is possible meanwhile (itemName/itemType from the trash).
   */
  itemTrashed: boolean;
}
export interface CreateShareInput {
  itemId: string; password?: string | null; expiresAt?: string | null;
  allowDownload?: boolean; allowUpload?: boolean;
}
export interface PublicShareInfo {
  /** Sync id of the shared item (`f_…` / `d_…`): the `:itemId` of a file share's content/thumbnail. */
  id: string;
  name: string; type: 'folder' | 'file'; size: number; mime: string | null;
  ownerDisplayName: string; allowDownload: boolean; allowUpload: boolean; expiresAt: string | null;
}
export interface PublicShareEntry {
  id: string; name: string; type: 'folder' | 'file'; size: number; mime: string | null;
  modifiedAt: string; hasThumbnail: boolean;
}

export interface SearchHit { item: SyncItem; path: string; snippet: string | null; matched: 'name' | 'content' | 'both' }
export interface SearchResponse { hits: SearchHit[]; total: number }

export interface PreviewInfo {
  kind: 'image' | 'pdf' | 'text' | 'markdown' | 'code' | 'video' | 'audio' | 'none';
  thumbnail: boolean;     // a thumbnail exists now
  language?: string;      // highlight.js language for kind === 'code'
}
