import type { PublicShareEntry } from '@synclet/shared';
import { Check, CircleAlert, Upload, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { DropZone } from '@/features/files/DropZone';
import { FileIcon } from '@/features/files/FileIcon';
import { formatBytes } from '@/lib/format';
import { cn } from '@/lib/utils';
import { PublicError, uploadToShare } from './api';

interface Task {
  id: number;
  file: File;
  folder: string | null;
  status: 'queued' | 'uploading' | 'done' | 'error';
  progress: number;
  result?: PublicShareEntry;
  error?: string;
}

/** i18n key of an upload failure. */
export function uploadErrorKey(e: unknown): string {
  if (!(e instanceof PublicError)) return 'publicShare.upload.errors.unknown';
  if (e.status === 413 || e.code === 'too_large') return 'publicShare.upload.errors.too_large';
  if (e.status === 429 || e.code === 'rate_limited' || e.code === 'busy') return 'publicShare.upload.errors.rate_limited';
  if (e.code === 'upload_not_allowed' || e.status === 403) return 'publicShare.upload.errors.not_allowed';
  if (e.code === 'invalid_name') return 'publicShare.upload.errors.invalid_name';
  if (e.code === 'network') return 'publicShare.upload.errors.network';
  return 'publicShare.upload.errors.unknown';
}

/** Errors that concern the whole link (gone, expired, locked again): handed to the page. */
const isShareError = (e: unknown) => e instanceof PublicError && (e.status === 404 || e.status === 410 || e.code === 'share_password_required');

let nextId = 1;

/**
 * Upload area of a folder share with `allowUpload`: a drop target for the whole window, a
 * button, one request per file (sequential) with progress, and a note when the server stored a
 * file under a new name because the original one was taken.
 */
export function PublicUploadZone({ token, folderId, folderName, onUploaded, onShareError }: {
  token: string;
  folderId: string | null;
  folderName: string;
  onUploaded(entry: PublicShareEntry, folder: string | null): void;
  onShareError(e: unknown): void;
}) {
  const { t, i18n } = useTranslation();
  const [tasks, setTasks] = useState<Task[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const aborts = useRef(new Map<number, AbortController>());
  const latest = useRef({ onUploaded, onShareError });
  latest.current = { onUploaded, onShareError };

  const patch = (id: number, p: Partial<Task>) => setTasks((ts) => ts.map((x) => (x.id === id ? { ...x, ...p } : x)));

  const enqueue = (files: File[]) => {
    if (!files.length) return;
    setTasks((ts) => [...ts, ...files.map((file): Task => ({ id: nextId++, file, folder: folderId, status: 'queued', progress: 0 }))]);
  };

  // One upload at a time: the server rate-limits uploads per client anyway.
  const running = tasks.some((x) => x.status === 'uploading');
  const next = running ? undefined : tasks.find((x) => x.status === 'queued');
  const started = useRef(new Set<number>());
  useEffect(() => {
    if (!next || started.current.has(next.id)) return; // StrictMode runs effects twice
    started.current.add(next.id);
    const ac = new AbortController();
    aborts.current.set(next.id, ac);
    patch(next.id, { status: 'uploading' });
    uploadToShare(token, next.folder, next.file, (progress) => patch(next.id, { progress }), ac.signal)
      .then((result) => {
        patch(next.id, { status: 'done', progress: 1, result });
        latest.current.onUploaded(result, next.folder);
      })
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        patch(next.id, { status: 'error', error: uploadErrorKey(e) });
        if (isShareError(e)) latest.current.onShareError(e);
      })
      .finally(() => aborts.current.delete(next.id));
    // Keyed by task id only: each queued task is started exactly once.
  }, [next?.id, token]);

  useEffect(() => () => { aborts.current.forEach((ac) => ac.abort()); }, []);

  const remove = (id: number) => {
    aborts.current.get(id)?.abort();
    setTasks((ts) => ts.filter((x) => x.id !== id));
  };

  const finished = tasks.length > 0 && tasks.every((x) => x.status === 'done' || x.status === 'error');

  return (
    <section aria-labelledby="share-upload-title" className="mt-6">
      <DropZone enabled folderName={folderName} onFiles={enqueue} />
      <div className="flex flex-col items-start gap-4 rounded-xl border border-dashed border-input bg-background/60 p-5 sm:flex-row sm:items-center sm:p-6">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent-soft text-primary">
          <Upload className="size-5" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <h2 id="share-upload-title" className="text-base font-semibold">{t('publicShare.upload.title', { folder: folderName })}</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">{t('publicShare.upload.hint')}</p>
        </div>
        <Button variant="outline" onClick={() => input.current?.click()}>
          {t('publicShare.upload.choose')}
        </Button>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          data-testid="share-upload-input"
          onChange={(e) => { enqueue(Array.from(e.target.files ?? [])); e.target.value = ''; }}
        />
      </div>

      {tasks.length > 0 && (
        <div className="mt-3 rounded-xl border bg-background">
          <ul aria-label={t('publicShare.upload.listLabel')} className="divide-y">
            {tasks.map((task) => {
              const renamed = task.status === 'done' && task.result && task.result.name !== task.file.name;
              let detail: string;
              if (task.status === 'queued') detail = t('publicShare.upload.queued');
              else if (task.status === 'uploading') {
                detail = t('publicShare.upload.progress', {
                  loaded: formatBytes(task.file.size * task.progress, i18n.language), total: formatBytes(task.file.size, i18n.language),
                });
              } else if (task.status === 'error') detail = t(task.error ?? 'publicShare.upload.errors.unknown');
              else if (renamed) detail = t('publicShare.upload.renamed', { name: task.result!.name });
              else detail = t('publicShare.upload.done');
              return (
                <li key={task.id} className="flex items-center gap-3 px-4 py-2.5">
                  <FileIcon item={{ type: 'file', name: task.file.name, mime: task.file.type || null }} className="size-5" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium" title={task.file.name}>{task.file.name}</div>
                    <div className={cn('text-xs tabular-nums', task.status === 'error' ? 'text-destructive' : renamed ? 'text-foreground' : 'text-muted-foreground')}>
                      {detail}
                    </div>
                    {task.status === 'uploading' && (
                      <div
                        className="mt-1.5 h-1 overflow-hidden rounded-full bg-border" role="progressbar" aria-label={task.file.name}
                        aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(task.progress * 100)}
                      >
                        <div className="h-full origin-left rounded-full bg-primary transition-transform duration-200" style={{ transform: `scaleX(${task.progress})` }} />
                      </div>
                    )}
                  </div>
                  {task.status === 'done' && <Check className="size-4 text-primary" aria-label={t('publicShare.upload.done')} />}
                  {task.status === 'error' && <CircleAlert className="size-4 text-destructive" aria-hidden />}
                  {(task.status === 'queued' || task.status === 'uploading') && (
                    <Button variant="ghost" size="icon-sm" className="text-muted-foreground" onClick={() => remove(task.id)} aria-label={t('publicShare.upload.cancel')}>
                      <X />
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
          {finished && (
            <div className="flex justify-end border-t px-2 py-1.5">
              <Button variant="ghost" size="sm" onClick={() => setTasks([])}>{t('publicShare.upload.clear')}</Button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
