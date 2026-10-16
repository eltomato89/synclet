import { Inject, Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Item } from '@prisma/client';
import type { OfficeEditorConfig, OfficeNewFormat } from '@synclet/shared';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { splitExt } from '../common/names';
import { SyncError } from '../common/sync-error';
import type { AuthUser, IndexSpace } from '../common/types';
import { APP_CONFIG, AppConfig } from '../config';
import { FilesService } from '../files/files.service';
import { PrismaService } from '../prisma/prisma.service';
import { SpacesRepo } from '../spaces/spaces.repo';
import { toSyncId, UUID } from '../sync/sync-ids';

// Euro-Office (ONLYOFFICE-compatible Document Server) integration, ported from Buro:
// a signed editor config for the browser, plus file download and save callback for the
// Document Server. The latter two have no user login; they carry short-lived file tokens signed
// with OFFICE_JWT_SECRET, and the callback body must additionally be signed by the Document Server.

type DocumentType = 'word' | 'cell' | 'slide' | 'pdf';

const TYPES: Record<string, DocumentType> = {
  doc: 'word', docx: 'word', docm: 'word', dot: 'word', dotx: 'word', odt: 'word', ott: 'word', rtf: 'word', txt: 'word',
  xls: 'cell', xlsx: 'cell', xlsm: 'cell', xltx: 'cell', ods: 'cell', ots: 'cell', csv: 'cell',
  ppt: 'slide', pptx: 'slide', pptm: 'slide', potx: 'slide', odp: 'slide', otp: 'slide',
  pdf: 'pdf',
};

/** Editable in place; the other TYPES open view-only. */
const EDITABLE = new Set([
  'docx', 'docm', 'dotx', 'odt', 'ott', 'rtf', 'txt',
  'xlsx', 'xlsm', 'xltx', 'ods', 'ots', 'csv',
  'pptx', 'pptm', 'potx', 'odp', 'otp',
]);

export const NEW_FORMATS: readonly OfficeNewFormat[] = ['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'txt', 'csv'];

/** Empty templates `new.<format>` (from dist/office and src/office alike). */
export const TEMPLATE_DIR = path.join(__dirname, '../../assets/office-templates');

/** Callback statuses that carry a document to save: 2 = all editors closed, 6 = forcesave. */
const SAVE_STATUSES = new Set([2, 6]);

const CONTENT_TOKEN_TTL = '1d';
/** The final callback only arrives after the last editor closed, possibly much later. */
const CALLBACK_TOKEN_TTL = '7d';

export type FileTokenPurpose = 'content' | 'callback';
/** `u`: the item's space id (= the owner's user id for a personal space). */
interface FileToken { i: string; u: string; p: FileTokenPurpose }

export function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/**
 * "Offer.docx" -> "Offer (Konflikt Office 2026-10-04 09-30).docx" (server local time, TZ).
 * The base is shortened so the name stays within 255 bytes (with room for a " (2)" suffix).
 */
export function conflictName(name: string, at: Date): string {
  const { base, ext } = splitExt(name);
  const p2 = (n: number) => String(n).padStart(2, '0');
  const stamp = `${at.getFullYear()}-${p2(at.getMonth() + 1)}-${p2(at.getDate())} ${p2(at.getHours())}-${p2(at.getMinutes())}`;
  const tail = ` (Konflikt Office ${stamp})${ext}`;
  let b = base;
  while (b.length > 1 && Buffer.byteLength(b + tail, 'utf8') > 240) b = Array.from(b).slice(0, -1).join('');
  return `${b}${tail}`;
}

const trimSlash = (url: string) => url.replace(/\/+$/, '');

export type CallbackResult = { error: 0 | 1 };

@Injectable()
export class OfficeService {
  private readonly log = new Logger(OfficeService.name);
  private readonly jwt = new JwtService({});
  /** Upper bound for downloading a saved document from the Document Server (tests shorten it). */
  static downloadTimeoutMs = 120_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly spaces: SpacesRepo,
    private readonly files: FilesService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Office editing is available iff the Document Server URL and the shared secret are set. */
  static enabled(config: AppConfig): boolean {
    return !!(config.officeUrl && config.officeJwtSecret);
  }

  get enabled(): boolean { return OfficeService.enabled(this.config); }

  private secret(): string {
    if (!this.enabled) throw new SyncError('office_disabled', 'office editing is not configured');
    return this.config.officeJwtSecret as string;
  }

  /** Throws 503 office_disabled when office editing is not configured. */
  assertEnabled(): void { this.secret(); }

  private sign(payload: object, expiresIn?: string): string {
    return this.jwt.sign(payload, { secret: this.secret(), algorithm: 'HS256', ...(expiresIn ? { expiresIn: expiresIn as never } : {}) });
  }

  /** Verifies an HS256 JWT signed with the shared secret; null when invalid or expired. */
  private verify<T extends object>(token: string, opts: { ignoreExpiration?: boolean } = {}): T | null {
    try {
      return this.jwt.verify<T>(token, { secret: this.secret(), algorithms: ['HS256'], ignoreExpiration: opts.ignoreExpiration === true });
    } catch {
      return null;
    }
  }

  fileToken(item: Item, p: FileTokenPurpose): string {
    return this.sign({ i: item.id, u: item.spaceId, p } satisfies FileToken, p === 'callback' ? CALLBACK_TOKEN_TTL : CONTENT_TOKEN_TTL);
  }

  /**
   * Checks a file token for item `syncId` and purpose `p`; 403 otherwise. `allowExpired` still
   * requires a valid signature, purpose and item binding and reports whether the token expired.
   */
  verifyFileToken(token: string | undefined, syncId: string, p: FileTokenPurpose, opts: { allowExpired?: boolean } = {}): FileToken & { expired: boolean } {
    this.assertEnabled();
    const claims = token ? this.verify<FileToken & { exp?: number }>(token, { ignoreExpiration: opts.allowExpired }) : null;
    if (!claims || claims.p !== p || typeof claims.i !== 'string' || typeof claims.u !== 'string' || syncId !== `f_${claims.i}`) {
      throw new SyncError('forbidden', 'invalid file token');
    }
    const expired = typeof claims.exp === 'number' && claims.exp * 1000 <= Date.now();
    return { i: claims.i, u: claims.u, p: claims.p, expired };
  }

  /* ------------------------------------------------------------------ editor config */

  async editorConfig(user: AuthUser, item: Item, langRaw: string | undefined): Promise<OfficeEditorConfig> {
    this.assertEnabled();
    const ext = extOf(item.name);
    const documentType = TYPES[ext];
    if (!documentType) throw new SyncError('invalid_request', 'this file type cannot be opened in the office editor', undefined, 415);
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { displayName: true, username: true } });
    const apiUrl = trimSlash(this.config.officeApiUrl);
    const syncId = toSyncId(item);
    // Synclet has no shared folders yet: the requesting user is the owner and may write.
    const edit = EDITABLE.has(ext);
    const config = {
      documentType,
      document: {
        fileType: ext,
        // A new key per version: after a save a new editing session starts.
        key: `${item.id}-${item.version}`,
        title: item.name,
        url: `${apiUrl}/office/files/${syncId}/content?t=${this.fileToken(item, 'content')}`,
        permissions: { edit, download: true, print: true, comment: edit },
      },
      editorConfig: {
        mode: edit ? 'edit' : 'view',
        lang: langRaw === 'de' ? 'de' : 'en',
        callbackUrl: `${apiUrl}/office/files/${syncId}/callback?t=${this.fileToken(item, 'callback')}`,
        user: { id: user.id, name: u.displayName || u.username },
        customization: { forcesave: true },
      },
    };
    return {
      documentServerUrl: trimSlash(this.config.officeUrl as string),
      editable: edit,
      config: { ...config, token: this.sign(config) },
    };
  }

  /* ------------------------------------------------------------------ for the Document Server */

  /** Space of the owner (enabled account) and live file row a content token points at; 404 otherwise. */
  async contentTarget(syncId: string, token: string | undefined): Promise<{ space: IndexSpace; itemId: string }> {
    const t = this.verifyFileToken(token, syncId, 'content');
    const owner = await this.prisma.user.findUnique({ where: { id: t.u }, select: { id: true, disabledAt: true } });
    if (!owner || owner.disabledAt) throw new SyncError('not_found');
    return { space: await this.spaces.personalFor(owner.id), itemId: t.i };
  }

  /**
   * Save callback. `{error: 0}` = handled (also: nothing to do, or the file is gone); `{error: 1}`
   * makes the Document Server keep the document and retry. A forged request (bad file token or
   * unsigned / wrongly signed body) is rejected with 403 before anything is fetched or written.
   */
  async callback(syncId: string, token: string | undefined, body: unknown, authHeader: string | undefined): Promise<CallbackResult> {
    // An editor session may stay open beyond the callback token's lifetime. An expired callback
    // token is still accepted (signature, purpose and item binding checked) because the body must
    // additionally be signed by the Document Server and its key must belong to this file;
    // refusing it would silently lose the final save.
    const t = this.verifyFileToken(token, syncId, 'callback', { allowExpired: true });
    // Only trust what the Document Server signed: the body's `token`, or the Authorization header
    // (which wraps the body in `payload`).
    const bodyToken = typeof (body as { token?: unknown })?.token === 'string' ? (body as { token: string }).token : undefined;
    const bearer = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    const signed = bodyToken ?? bearer;
    const verified = signed ? this.verify<Record<string, unknown>>(signed) : null;
    if (!verified) throw new SyncError('forbidden', 'callback not signed by the document server');
    const data = (verified.payload && typeof verified.payload === 'object' ? verified.payload : verified) as Record<string, unknown>;
    const status = Number(data.status);
    if (!SAVE_STATUSES.has(status)) return { error: 0 };

    // The session key is "<itemId>-<version it started on>"; anything else is not this file's session.
    const key = String(data.key ?? '');
    const m = /^(.+)-(\d+)$/.exec(key);
    if (!m || m[1] !== t.i) throw new SyncError('forbidden', 'callback key does not belong to this file');
    const baseVersion = Number(m[2]);
    if (t.expired) this.log.warn(`office callback for ${syncId} with an expired callback token accepted (signed by the document server)`);

    // The personal space is deleted together with its owner.
    const space = await this.spaces.byId(t.u);
    if (!space) {
      // Only a vanished owner drops the save (otherwise the Document Server retries forever). A
      // trashed or deleted file still gets the edits, as a conflict copy (see saveOfficeContent).
      this.log.warn(`office save for ${syncId} discarded: owner gone`);
      return { error: 0 };
    }

    const url = this.downloadUrl(data.url);
    if (!url) {
      this.log.warn(`office save for ${syncId}: download URL not on the document server, ignored`);
      return { error: 1 };
    }
    const users = Array.isArray(data.users) ? data.users : [];
    const editor = typeof users[0] === 'string' && UUID.test(users[0]) ? users[0] : undefined;
    try {
      const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(OfficeService.downloadTimeoutMs) });
      if (!res.ok || !res.body) {
        this.log.error(`office save for ${syncId}: download failed with ${res.status}`);
        return { error: 1 };
      }
      const length = Number(res.headers.get('content-length') ?? NaN);
      if (length > this.config.maxUploadBytes) {
        await res.body.cancel().catch(() => {});
        throw new SyncError('too_large');
      }
      const stream = Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>);
      const ext = typeof data.filetype === 'string' && /^[a-z0-9]{1,8}$/i.test(data.filetype) ? `.${data.filetype.toLowerCase()}` : '';
      const result = await this.files.saveOfficeContent(space, t.i, stream, {
        key, baseVersion, by: editor, conflictName: (name) => conflictName(name, new Date()), fallbackName: `Office${ext}`,
      });
      if (result.outcome === 'retry') {
        this.log.warn(`office save for ${syncId}: file missing on disk right now, asking the document server to retry`);
        return { error: 1 };
      }
      if (result.outcome === 'conflict') this.log.warn(`office conflict on ${syncId} (session v${baseVersion}): saved as copy ${result.item.id}`);
      if (result.outcome === 'orphaned') this.log.warn(`office save for ${syncId}: file was deleted while editing, saved as copy ${result.item.id}`);
      return { error: 0 };
    } catch (e) {
      this.log.error(`office save for ${syncId} failed: ${(e as Error).message}`);
      return { error: 1 };
    }
  }

  /**
   * The download URL from a callback, only on the configured Document Server (public or internal
   * origin; no SSRF to anything else), rewritten to the internal URL (keeping its path prefix).
   * null when not allowed.
   */
  private downloadUrl(raw: unknown): string | null {
    let url: URL;
    let pub: URL;
    let internal: URL;
    try {
      url = new URL(String(raw ?? ''));
      pub = new URL(this.config.officeUrl as string);
      internal = new URL(this.config.officeInternalUrl);
    } catch {
      return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    if (url.origin !== pub.origin && url.origin !== internal.origin) return null;
    // A path starting with "//" (a backslash variant is normalized to it) would be scheme-relative
    // if it were ever resolved as a reference: refuse it outright.
    if (url.pathname.startsWith('//')) return null;
    // Built on a copy of the internal URL, so host and port can only come from the configuration.
    const target = new URL(internal.href);
    const prefix = internal.pathname.replace(/\/+$/, '');
    const rel = url.origin === internal.origin && prefix && (url.pathname === prefix || url.pathname.startsWith(`${prefix}/`))
      ? url.pathname.slice(prefix.length) : url.pathname;
    target.pathname = `${prefix}${rel}`;
    target.search = url.search;
    target.hash = '';
    if (target.origin !== internal.origin) return null;
    return target.toString();
  }

  /* ------------------------------------------------------------------ new documents */

  templatePath(format: OfficeNewFormat): string {
    if (!NEW_FORMATS.includes(format)) throw new SyncError('invalid_request', 'unknown format');
    return path.join(TEMPLATE_DIR, `new.${format}`);
  }

  /** "Report" / "Report.docx" -> "Report.docx". */
  static newFileName(rawName: string, format: OfficeNewFormat): string {
    const base = (rawName ?? '').trim().replace(new RegExp(`\\.${format}$`, 'i'), '').trim();
    if (!base) throw new SyncError('invalid_name', 'name missing');
    return `${base}.${format}`;
  }
}
