export const APP_CONFIG = Symbol('APP_CONFIG');

export interface AppConfig {
  dataRoot: string;
  metaRoot: string;
  port: number;
  background: boolean;
  watch: boolean;
  scanIntervalSec: number;
  tombstoneWindowSec: number;
  journalRetentionDays: number;
  /** Refuse to empty a user root holding more live root items than this (0 = no limit). */
  massDeleteThreshold: number;
  maxUploadBytes: number;
  publicUrl: string | null;
  secureCookies: boolean;
  /** Trust X-Forwarded-For (client IP for rate limiting). Only behind a reverse proxy that sets it. */
  trustProxy: boolean;
  /** Days a trashed item is kept before purge (0 = never). */
  trashRetentionDays: number;
  /** Postgres text search configuration for full-text search ('simple' = no stemming). */
  searchLanguage: string;
  workerConcurrency: number;
  /** Files above this size get no derivative (thumbnail / extracted text). */
  previewMaxBytes: number;
  /** Keep superseded file contents as versions (off by default). */
  versions: boolean;
  /** Per-user cap for stored version bytes (0 = unlimited). */
  versionsMaxBytes: number;
  /** Browser-facing Document Server URL, e.g. https://office.example.com (null = office disabled). */
  officeUrl: string | null;
  officeJwtSecret: string | null;
  /** This server as seen by the Document Server. */
  officeApiUrl: string;
  /** Document Server as seen by this server. */
  officeInternalUrl: string;
  /** Ignore OIDC/forward-auth and allow password login for everyone (`1`, `true`, `on`, `yes`, ...). */
  ssoEmergency: boolean;
  /**
   * Accept an `http://` OIDC issuer whose host is loopback/private (test and lab setups only).
   * Without it, issuers must use https.
   */
  ssoAllowHttpIssuer: boolean;
  /** Interval of the `: ping` comment on SSE event streams; the token is re-checked before each ping. */
  eventsPingSeconds: number;
  /** Process role; set by the entrypoint, not by the environment. */
  role: 'server' | 'worker';
}

// Empty values (compose passes `${VAR:-}`) mean "use the default".
const bool = (v: string | undefined, dflt: boolean) => (v === undefined || v === '' ? dflt : !['0', 'false', 'off', 'no'].includes(v.toLowerCase()));
const int = (v: string | undefined, dflt: number) => (v === undefined || v === '' ? dflt : Number.parseInt(v, 10));
/**
 * A plain byte count (digits only). The bundled Caddy uses the same variable as a number in its
 * config and cannot parse anything else, so suffixes such as `50G` are refused here as well
 * instead of being read as 50 bytes.
 */
const byteCount = (name: string, v: string | undefined, dflt: number) => {
  if (v === undefined || v === '') return dflt;
  if (!/^\d+$/.test(v)) throw new Error(`${name} must be a plain number of bytes (digits only, e.g. 53687091200), got "${v}"`);
  return Number(v);
};

/** At least 1 s (0 and negative values mean 1 s); unparsable values fall back to 25 s. */
const pingSeconds = (v: number) => (Number.isFinite(v) ? Math.max(1, v) : 25);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const publicUrl = env.SYNCLET_PUBLIC_URL || null;
  return {
    dataRoot: env.SYNCLET_DATA_ROOT ?? '/data',
    metaRoot: env.SYNCLET_META_ROOT ?? '/meta',
    port: int(env.PORT, 3000),
    background: bool(env.SYNCLET_BACKGROUND, true),
    watch: bool(env.SYNCLET_WATCH, true),
    scanIntervalSec: int(env.SYNCLET_SCAN_INTERVAL, bool(env.SYNCLET_WATCH, true) ? 900 : 120),
    tombstoneWindowSec: int(env.SYNCLET_TOMBSTONE_WINDOW, 3600),
    journalRetentionDays: int(env.SYNCLET_JOURNAL_RETENTION_DAYS, 30),
    massDeleteThreshold: int(env.SYNCLET_MASS_DELETE_THRESHOLD, 25),
    maxUploadBytes: byteCount('SYNCLET_MAX_UPLOAD_BYTES', env.SYNCLET_MAX_UPLOAD_BYTES, 50 * 1024 ** 3),
    publicUrl,
    secureCookies: bool(env.SYNCLET_SECURE_COOKIES, publicUrl?.startsWith('https://') ?? false),
    trustProxy: bool(env.SYNCLET_TRUST_PROXY, false),
    trashRetentionDays: int(env.SYNCLET_TRASH_RETENTION_DAYS, 30),
    searchLanguage: env.SYNCLET_SEARCH_LANGUAGE || 'simple',
    workerConcurrency: int(env.SYNCLET_WORKER_CONCURRENCY, 2),
    previewMaxBytes: int(env.SYNCLET_PREVIEW_MAX_BYTES, 2 * 1024 ** 3),
    versions: bool(env.SYNCLET_VERSIONS, false),
    versionsMaxBytes: int(env.SYNCLET_VERSIONS_MAX_BYTES, 0),
    officeUrl: env.OFFICE_URL || null,
    officeJwtSecret: env.OFFICE_JWT_SECRET || null,
    officeApiUrl: env.OFFICE_API_URL || 'http://server:3000/api',
    officeInternalUrl: env.OFFICE_INTERNAL_URL || 'http://office',
    ssoEmergency: bool(env.SYNCLET_SSO_EMERGENCY, false),
    ssoAllowHttpIssuer: env.SYNCLET_SSO_ALLOW_HTTP_ISSUER === '1',
    eventsPingSeconds: pingSeconds(int(env.SYNCLET_EVENTS_PING_SECONDS, 25)),
    role: 'server',
  };
}
