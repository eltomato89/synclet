import type { SyncItem } from '@synclet/shared';
import { useSyncExternalStore } from 'react';
import * as tus from 'tus-js-client';
import { getAccessToken, refreshSession } from '@/lib/api';

export type UploadStatus = 'queued' | 'uploading' | 'done' | 'error' | 'conflict';
export interface UploadTask {
  id: number;
  file: File;
  parentId: string;
  status: UploadStatus;
  progress: number;
  /** Sync API error code (`too_large`, `name_conflict`, …), `network` or `unauthorized`. */
  error?: string;
  result?: SyncItem;
}

const MAX_PARALLEL = 3;
const STATUS_CODES: Record<number, string> = { 401: 'unauthorized', 403: 'forbidden', 404: 'not_found', 409: 'name_conflict', 410: 'upload_expired', 412: 'conflict', 413: 'too_large' };

export const TUS_ENDPOINT = '/api/sync/v1/uploads';
export const TUS_CHUNK_SIZE = 16 * 1024 * 1024;
export const TUS_RETRY_DELAYS = [0, 1000, 3000, 5000, 10000];
/** Attempts of the empty "publish again" PATCH (see `UploadQueue.publish`). */
const PUBLISH_ATTEMPTS = 3;

/** The part of `tus.Upload` the queue uses (tests pass a fake). */
export interface TusUpload {
  url: string | null;
  start(): void;
  abort(shouldTerminate?: boolean): Promise<void>;
  findPreviousUploads(): Promise<tus.PreviousUpload[]>;
  resumeFromPreviousUpload(previous: tus.PreviousUpload): void;
}
export interface UploadTransport {
  /** tus `Upload` constructor. */
  Upload: new (file: File, options: tus.UploadOptions) => TusUpload;
  /** `tus.isSupported`; false falls back to one raw POST per file. */
  supported: boolean;
  /** Pause before asking again when the "publish again" PATCH answered 423/5xx (ms). */
  publishRetryMs?: number;
}
const defaultTransport: UploadTransport = { Upload: tus.Upload, supported: tus.isSupported, publishRetryMs: 1500 };

const statusCode = (status: number) => STATUS_CODES[status] ?? (status >= 500 ? 'server_error' : 'unknown');

/** `code` of a Sync API error body, if the body is one. */
function bodyCode(body: string | undefined): string | undefined {
  if (!body) return undefined;
  try {
    const code = (JSON.parse(body) as { code?: unknown } | null)?.code;
    return typeof code === 'string' ? code : undefined;
  } catch { return undefined; }
}

type ResponseLike = Pick<tus.HttpResponse, 'getStatus' | 'getHeader' | 'getBody'>;

/**
 * The published item, when this response finished the upload: the final PATCH (200) or a
 * completing POST (201) carry `X-Synclet-Item` and the SyncItem as body. A HEAD that merely
 * reports offset == length (publishing failed earlier) has neither.
 */
export function itemFromResponse(res: ResponseLike | null | undefined): SyncItem | null {
  if (!res) return null;
  const status = res.getStatus();
  const id = res.getHeader('X-Synclet-Item');
  if ((status !== 200 && status !== 201) || !id) return null;
  try {
    const item = JSON.parse(res.getBody()) as SyncItem | null;
    return item && item.id === id ? item : null;
  } catch { return null; }
}

/** Refresh the access token before a request when it expires within this window. */
export const TOKEN_REFRESH_MARGIN_MS = 30_000;

/** `exp` of a JWT in ms (payload decoded, not verified); null when unreadable. */
export function tokenExpiry(token: string | null): number | null {
  const part = token?.split('.')[1];
  if (!part) return null;
  try {
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '='));
    const exp = (JSON.parse(json) as { exp?: unknown }).exp;
    return typeof exp === 'number' ? exp * 1000 : null;
  } catch { return null; }
}

/**
 * Forgets every stored tus upload (fingerprint → upload URL, file name). Called on logout: on a
 * shared machine the next user must not see the previous user's file names in localStorage.
 */
export function clearUploadFingerprints(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith('tus::')) keys.push(k);
    }
    keys.forEach((k) => localStorage.removeItem(k));
  } catch { /* storage unavailable */ }
}

const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });

/**
 * Upload queue with at most three parallel uploads. Every file goes through tus (resumable,
 * 16 MiB chunks, automatic retries); after a page reload, uploading the same file into the same
 * folder again resumes from the server's offset (tus fingerprints in localStorage). Browsers
 * without tus support fall back to one raw POST per file. A 401 refreshes the session and
 * retries; if that does not help the task fails with `unauthorized`.
 */
export class UploadQueue {
  private tasks: UploadTask[] = [];
  private seq = 0;
  private listeners = new Set<() => void>();
  private snap: UploadTask[] = [];
  /** Aborts the in-flight transfer of a task (tus: also terminates the server-side upload). */
  private aborts = new Map<number, () => void>();
  private maxBytes = 0;

  constructor(
    private readonly token: () => string | null,
    private readonly onDone: (parentId: string) => void,
    private readonly refresh?: () => Promise<boolean>,
    private readonly transport: UploadTransport = defaultTransport,
  ) {}

  /** Server upload limit from the account; 0 = unknown. Larger files fail with `too_large` without being sent. */
  setMaxUploadBytes(n: number) { this.maxBytes = n; }

  enqueue(files: File[], parentId: string) {
    for (const file of files) this.tasks.push({ id: ++this.seq, file, parentId, status: 'queued', progress: 0 });
    this.pump();
  }

  retry(id: number) {
    const t = this.tasks.find((x) => x.id === id);
    if (t && (t.status === 'error' || t.status === 'conflict')) { t.status = 'queued'; t.progress = 0; t.error = undefined; this.pump(); }
  }

  /** Removes a task; an upload in flight is aborted and the server discards its partial data. */
  cancel(id: number) {
    this.aborts.get(id)?.();
    this.aborts.delete(id);
    this.tasks = this.tasks.filter((t) => t.id !== id);
    this.pump();
  }

  clearFinished() { this.tasks = this.tasks.filter((t) => t.status !== 'done'); this.emit(); }

  /** Removes everything that is not queued or uploading. */
  clearInactive() { this.tasks = this.tasks.filter((t) => t.status === 'queued' || t.status === 'uploading'); this.emit(); }

  snapshot(): UploadTask[] { return this.snap; }
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };

  private emit() { this.snap = this.tasks.map((t) => ({ ...t })); this.listeners.forEach((l) => l()); }

  private pump() {
    let active = this.tasks.filter((t) => t.status === 'uploading').length;
    for (const t of this.tasks) {
      if (active >= MAX_PARALLEL) break;
      if (t.status !== 'queued') continue;
      this.start(t);
      if ((t.status as UploadStatus) === 'uploading') active++; // start() may fail synchronously (too_large)
    }
    this.emit();
  }

  private fail(t: UploadTask, code: string) {
    t.status = code === 'name_conflict' || code === 'conflict' ? 'conflict' : 'error';
    t.error = code;
  }

  private succeed(t: UploadTask, item: SyncItem) {
    t.result = item;
    t.status = 'done'; t.progress = 1;
    this.onDone(t.parentId);
  }

  /**
   * The access token for the next request, refreshed first when it expires within
   * {@link TOKEN_REFRESH_MARGIN_MS}. A tus HEAD answered 401 makes tus-js-client drop the stored
   * upload and start over from byte 0, so an expired token must never reach the server.
   * `refreshSession` is single-flight; a failed refresh sends the old token (the 401 path decides).
   */
  private async freshToken(): Promise<string | null> {
    const tok = this.token();
    const exp = tokenExpiry(tok);
    if (this.refresh && exp !== null && exp - Date.now() < TOKEN_REFRESH_MARGIN_MS) {
      await this.refresh().catch(() => false);
      return this.token();
    }
    return tok;
  }

  /** False once the task was cancelled (removed from the queue). */
  private alive(t: UploadTask) { return this.tasks.includes(t); }

  private start(t: UploadTask) {
    if (this.maxBytes > 0 && t.file.size > this.maxBytes) { this.fail(t, 'too_large'); return; }
    t.status = 'uploading';
    if (this.transport.supported) this.startTus(t);
    else this.startRaw(t);
  }

  // ---- tus ------------------------------------------------------------------------------------

  private startTus(t: UploadTask) {
    /** Outcome of the session refresh started by the last 401; requests wait for it. */
    let refreshing: Promise<'ok' | 'gone' | 'network'> | null = null;
    /** A second 401 right after a refresh is final: never refresh in a loop. */
    let refreshedSinceLast401 = false;
    let finished = false;

    const upload = new this.transport.Upload(t.file, {
      // Absolute: tus-js-client resolves the (relative) Location header against it.
      endpoint: new URL(TUS_ENDPOINT, window.location.href).href,
      chunkSize: TUS_CHUNK_SIZE,
      retryDelays: TUS_RETRY_DELAYS,
      removeFingerprintOnSuccess: true,
      metadata: {
        name: t.file.name,
        parentId: t.parentId,
        onConflict: 'rename',
        modifiedAt: new Date(t.file.lastModified).toISOString(),
      },
      // The target folder is part of the identity: the same file dropped into another folder is a
      // new upload, never the resume of one whose metadata points elsewhere.
      fingerprint: (file: File) => Promise.resolve(['synclet', t.parentId, file.name, file.type, file.size, file.lastModified].join('|')),
      // Read the token per request, so a long upload picks up refreshed tokens.
      onBeforeRequest: async (req) => {
        if (refreshing) await refreshing;
        const tok = await this.freshToken();
        if (tok) req.setHeader('Authorization', `Bearer ${tok}`);
      },
      onAfterResponse: (_req, res) => { if (res.getStatus() !== 401) refreshedSinceLast401 = false; },
      onShouldRetry: (err) => {
        const res = err.originalResponse;
        const status = res?.getStatus() ?? 0;
        if (status === 401) {
          if (!this.refresh || refreshedSinceLast401) return false;
          refreshedSinceLast401 = true;
          refreshing = this.refresh().then((ok) => (ok ? 'ok' : 'gone'), () => 'network');
          return true;
        }
        // A Sync API error (invalid name, parent gone, quota, …) is final: retrying cannot help.
        if (bodyCode(res?.getBody())) return false;
        const retriable = status === 0 || status < 400 || status >= 500 || status === 409 || status === 423;
        return retriable && (typeof navigator === 'undefined' || navigator.onLine !== false);
      },
      onProgress: (sent, total) => {
        if (!this.alive(t) || finished) return;
        t.progress = total ? sent / total : 0;
        this.emit();
      },
      onSuccess: ({ lastResponse }) => {
        finished = true;
        void this.completeTus(t, upload, lastResponse);
      },
      onError: (err) => {
        this.aborts.delete(t.id);
        if (!this.alive(t)) return;
        const res = (err as tus.DetailedError).originalResponse ?? null;
        const status = res?.getStatus() ?? 0;
        const code = status === 0 ? 'network' : bodyCode(res?.getBody()) ?? statusCode(status);
        void (refreshing ?? Promise.resolve(null)).then((r) => {
          if (!this.alive(t)) return;
          // A 401 after a refresh that failed for network reasons is a network problem.
          this.fail(t, status === 401 ? (r === 'network' ? 'network' : 'unauthorized') : code);
          this.pump();
        });
      },
    });
    this.aborts.set(t.id, () => { void upload.abort(true).catch(() => { /* already gone */ }); });

    void upload.findPreviousUploads().then(
      (previous) => {
        if (!this.alive(t)) return;
        const latest = [...previous].sort((a, b) => b.creationTime.localeCompare(a.creationTime))[0];
        if (latest) upload.resumeFromPreviousUpload(latest);
        upload.start();
      },
      () => { if (this.alive(t)) upload.start(); }, // unreadable storage: upload from scratch
    );
  }

  private async completeTus(t: UploadTask, upload: TusUpload, last: tus.HttpResponse) {
    const outcome = itemFromResponse(last) ?? (upload.url ? await this.publish(t, upload.url) : 'server_error');
    this.aborts.delete(t.id);
    if (!this.alive(t)) return;
    if (typeof outcome === 'string') this.fail(t, outcome);
    else this.succeed(t, outcome);
    this.pump();
  }

  /**
   * The server holds every byte but has not published the file (publishing failed with a
   * transient error, or the tab went away in between) – tus-js-client then reports success
   * from a HEAD without an item. An empty PATCH at the final offset makes the server publish
   * again; 423 means a publish is running right now, so wait and ask again.
   * Resolves the item, or an error code after {@link PUBLISH_ATTEMPTS} attempts.
   */
  private async publish(t: UploadTask, url: string): Promise<SyncItem | string> {
    let lastCode = 'server_error';
    let refreshed = false;
    for (let attempt = 1; attempt <= PUBLISH_ATTEMPTS; attempt++) {
      if (!this.alive(t)) return 'cancelled';
      let res: Response;
      try {
        const tok = await this.freshToken();
        res = await fetch(url, {
          method: 'PATCH',
          credentials: 'include',
          headers: {
            'Tus-Resumable': '1.0.0',
            'Upload-Offset': String(t.file.size),
            'Content-Type': 'application/offset+octet-stream',
            ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
          },
        });
      } catch {
        lastCode = 'network';
        if (attempt < PUBLISH_ATTEMPTS) await sleep(this.transport.publishRetryMs ?? 0);
        continue;
      }
      const body = await res.text().catch(() => '');
      const item = itemFromResponse({ getStatus: () => res.status, getHeader: (h) => res.headers.get(h) ?? undefined, getBody: () => body });
      if (item) return item;
      if (res.status === 401 && this.refresh && !refreshed) {
        refreshed = true;
        if (await this.refresh().catch(() => false)) continue;
        return 'unauthorized';
      }
      if (res.status !== 423 && res.status < 500) return bodyCode(body) ?? statusCode(res.status);
      lastCode = bodyCode(body) ?? 'server_error';
      if (attempt < PUBLISH_ATTEMPTS) await sleep(this.transport.publishRetryMs ?? 0);
    }
    return lastCode;
  }

  // ---- raw POST fallback ----------------------------------------------------------------------

  private startRaw(t: UploadTask, refreshed = false) {
    t.status = 'uploading';
    const xhr = new XMLHttpRequest();
    this.aborts.set(t.id, () => xhr.abort());
    const qs = `parentId=${encodeURIComponent(t.parentId)}&name=${encodeURIComponent(t.file.name)}&onConflict=rename`;
    xhr.open('POST', `/api/sync/v1/items/upload?${qs}`);
    const tok = this.token();
    if (tok) xhr.setRequestHeader('Authorization', `Bearer ${tok}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-Synclet-Modified-At', new Date(t.file.lastModified).toISOString());
    xhr.upload.onprogress = (e) => { t.progress = e.total ? e.loaded / e.total : 0; this.emit(); };
    xhr.onload = () => {
      this.aborts.delete(t.id);
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          this.succeed(t, JSON.parse(xhr.responseText) as SyncItem);
        } catch {
          this.fail(t, 'server_error'); // 2xx with an unexpected body (proxy page, truncated response)
        }
      } else if (xhr.status === 401 && !refreshed && this.refresh) {
        t.progress = 0;
        void this.refresh().then((ok) => {
          if (!this.alive(t)) return; // cancelled meanwhile
          if (ok) this.startRaw(t, true); else this.fail(t, 'unauthorized');
          this.pump();
        }, () => {
          // Transient refresh failure (network/5xx): fail the task instead of leaving it stuck in `uploading`.
          if (!this.alive(t)) return;
          this.fail(t, 'network');
          this.pump();
        });
        return;
      } else {
        this.fail(t, bodyCode(xhr.responseText) ?? STATUS_CODES[xhr.status] ?? 'unknown');
      }
      this.pump();
    };
    xhr.onerror = () => { this.aborts.delete(t.id); this.fail(t, 'network'); this.pump(); };
    xhr.send(t.file);
  }
}

let queue: UploadQueue | null = null;
export function getUploadQueue(onDone: (parentId: string) => void): UploadQueue {
  queue ??= new UploadQueue(getAccessToken, onDone, refreshSession);
  return queue;
}

export function useUploads(q: UploadQueue) {
  return useSyncExternalStore(q.subscribe, () => q.snapshot());
}
