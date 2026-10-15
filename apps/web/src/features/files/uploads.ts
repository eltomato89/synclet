import type { SyncItem } from '@synclet/shared';
import { useSyncExternalStore } from 'react';
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
const STATUS_CODES: Record<number, string> = { 401: 'unauthorized', 403: 'forbidden', 404: 'not_found', 409: 'name_conflict', 412: 'conflict', 413: 'too_large' };

/**
 * Upload queue with at most three parallel uploads. Each file is sent as a raw body via
 * XMLHttpRequest (fetch has no upload progress). A 401 refreshes the session once and
 * retries; afterwards the task fails with `unauthorized`.
 */
export class UploadQueue {
  private tasks: UploadTask[] = [];
  private seq = 0;
  private listeners = new Set<() => void>();
  private snap: UploadTask[] = [];
  private xhrs = new Map<number, XMLHttpRequest>();
  private maxBytes = 0;

  constructor(
    private readonly token: () => string | null,
    private readonly onDone: (parentId: string) => void,
    private readonly refresh?: () => Promise<boolean>,
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

  /** Removes a task; an upload in flight is aborted (the server discards partial uploads). */
  cancel(id: number) {
    this.xhrs.get(id)?.abort();
    this.xhrs.delete(id);
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

  private start(t: UploadTask, refreshed = false) {
    if (this.maxBytes > 0 && t.file.size > this.maxBytes) { this.fail(t, 'too_large'); return; }
    t.status = 'uploading';
    const xhr = new XMLHttpRequest();
    this.xhrs.set(t.id, xhr);
    const qs = `parentId=${encodeURIComponent(t.parentId)}&name=${encodeURIComponent(t.file.name)}&onConflict=rename`;
    xhr.open('POST', `/api/sync/v1/items/upload?${qs}`);
    const tok = this.token();
    if (tok) xhr.setRequestHeader('Authorization', `Bearer ${tok}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-Synclet-Modified-At', new Date(t.file.lastModified).toISOString());
    xhr.upload.onprogress = (e) => { t.progress = e.total ? e.loaded / e.total : 0; this.emit(); };
    xhr.onload = () => {
      this.xhrs.delete(t.id);
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          t.result = JSON.parse(xhr.responseText) as SyncItem;
          t.status = 'done'; t.progress = 1;
          this.onDone(t.parentId);
        } catch {
          this.fail(t, 'server_error'); // 2xx with an unexpected body (proxy page, truncated response)
        }
      } else if (xhr.status === 401 && !refreshed && this.refresh) {
        t.progress = 0;
        void this.refresh().then((ok) => {
          if (!this.tasks.includes(t)) return; // cancelled meanwhile
          if (ok) this.start(t, true); else this.fail(t, 'unauthorized');
          this.pump();
        }, () => {
          // Transient refresh failure (network/5xx): fail the task instead of leaving it stuck in `uploading`.
          if (!this.tasks.includes(t)) return;
          this.fail(t, 'network');
          this.pump();
        });
        return;
      } else {
        let code: string | undefined;
        try { code = (JSON.parse(xhr.responseText) as { code?: string }).code; } catch { /* proxy error page */ }
        this.fail(t, code ?? STATUS_CODES[xhr.status] ?? 'unknown');
      }
      this.pump();
    };
    xhr.onerror = () => { this.xhrs.delete(t.id); this.fail(t, 'network'); this.pump(); };
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
