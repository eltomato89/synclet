// Wire types of the Synclet Sync API v1 (compatible with Buro SYNC_API v1).
// Types only – consumers use `import type`.

export type SyncErrorCode =
  | 'unauthorized' | 'device_revoked' | 'forbidden' | 'not_found' | 'name_conflict'
  | 'invalid_move' | 'invalid_name' | 'invalid_request' | 'cursor_expired' | 'conflict'
  | 'precondition_required' | 'too_large' | 'range_not_satisfiable' | 'setup_done'
  | 'share_password_required' | 'share_expired' | 'rate_limited' | 'upload_not_allowed'
  | 'office_disabled' | 'sso_not_allowed' | 'password_login_disabled' | 'insufficient_storage'
  | 'space_unavailable';

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
  /** API id of the item's space (`personal` or the space uuid); absent from older servers = personal. */
  spaceId?: string;
}

export type SyncSpaceKind = 'personal' | 'shared' | 'external';
/** A top-level space of the account; each has its own root folder. Clients store sync state per space. */
export interface SyncSpace {
  id: string; kind: SyncSpaceKind; name: string; rootId: string; canWrite: boolean;
  /** `missing`: the storage is unreachable (content answers 503); absent from older servers = available. */
  status?: 'available' | 'missing';
}

export interface SyncAccount {
  userId: string; email: string | null; displayName: string;
  organizationId: string; organizationName: string; slug: string;
  canWrite: boolean;
  spaces: SyncSpace[];
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
  /** API id of the entry's space; absent from older servers = personal. */
  spaceId?: string;
  /** User id of whoever deleted it (null when unknown, e.g. deleted on disk). */
  deletedBy?: string | null;
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

// ---- Phase 1c: versions, office, SSO, admin

export interface ServerCapabilities { versions: boolean; office: { enabled: boolean; url: string | null } }
export interface VersionWire {
  id: string; version: number; size: number; sha256: string;
  /** Content mtime while current. */
  modifiedAt: string;
  /** Superseded at. */
  createdAt: string;
  source: 'api' | 'office' | 'restore'; createdBy: { id: string; displayName: string } | null;
}
export interface OfficeEditorConfig { documentServerUrl: string; editable: boolean; config: Record<string, unknown> }
export type OfficeNewFormat = 'docx' | 'xlsx' | 'pptx' | 'odt' | 'ods' | 'odp' | 'txt' | 'csv';

export interface LoginMethods {
  /** Shown for everyone (admins can always use /login?local=1). */
  password: boolean;
  oidc: { enabled: boolean; label: string };
  forwardAuth: boolean;
  emergency: boolean;
}
export interface SsoSettingsWire {
  passwordLoginForUsers: boolean;
  oidc: {
    enabled: boolean; issuer: string | null; clientId: string | null; hasClientSecret: boolean; scopes: string;
    buttonLabel: string; usernameClaim: string; groupsClaim: string; allowedGroups: string[]; adminGroups: string[];
    linkByEmail: boolean; redirectUri: string;
  };
  forwardAuth: {
    enabled: boolean; userHeader: string; emailHeader: string; nameHeader: string; groupsHeader: string;
    trustedProxies: string[]; allowedGroups: string[]; adminGroups: string[];
  };
  emergency: boolean;
}
export type SsoSettingsInput = Partial<Omit<SsoSettingsWire, 'emergency' | 'oidc' | 'forwardAuth'>> & {
  oidc?: Partial<Omit<SsoSettingsWire['oidc'], 'hasClientSecret' | 'redirectUri'>> & { clientSecret?: string | null };
  forwardAuth?: Partial<SsoSettingsWire['forwardAuth']>;
};

export interface AdminUserWire extends PublicUser {
  disabled: boolean; createdAt: string; lastLoginAt: string | null;
  identities: { provider: string; subject: string }[]; usedBytes: number; devices: number;
}
export interface AdminSessionWire { id: string; userAgent: string | null; createdAt: string; expiresAt: string }
export interface AdminDeviceWire extends SyncDevice { userId: string }
export interface AdminShareWire extends ShareLinkWire { owner: { id: string; username: string } }
export interface DiskUsage { totalBytes: number; freeBytes: number }
export interface AdminStatusWire {
  version: string; uptimeSec: number;
  watch: 'active' | 'scan-only' | 'off'; lastFullScanAt: string | null;
  users: { total: number; disabled: number };
  disk: { data: DiskUsage; meta: DiskUsage };
  meta: { derivedBytes: number; trashBytes: number; versionsBytes: number; uploadsBytes: number };
  jobs: Record<'thumb' | 'text', Record<'pending' | 'running' | 'done' | 'failed' | 'unsupported', number>>;
  office: { enabled: boolean; reachable: boolean | null };
  versions: boolean;
}
export interface UnassignedFolder { name: string }
export interface AppTokenResponse extends AuthResponse { refreshToken: string }
