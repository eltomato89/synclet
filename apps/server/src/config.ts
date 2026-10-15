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
  maxUploadBytes: number;
  publicUrl: string | null;
  secureCookies: boolean;
}

const bool = (v: string | undefined, dflt: boolean) => (v === undefined ? dflt : !['0', 'false', 'off', 'no'].includes(v.toLowerCase()));
const int = (v: string | undefined, dflt: number) => (v === undefined || v === '' ? dflt : Number.parseInt(v, 10));

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
    maxUploadBytes: int(env.SYNCLET_MAX_UPLOAD_BYTES, 50 * 1024 ** 3),
    publicUrl,
    secureCookies: bool(env.SYNCLET_SECURE_COOKIES, publicUrl?.startsWith('https://') ?? false),
  };
}
