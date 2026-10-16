import { Check, ChevronDown, CircleAlert, RotateCw, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { refreshSession } from '@/lib/api';
import { formatBytes } from '@/lib/format';
import { cn } from '@/lib/utils';
import { errorKey } from './errors';
import { FileIcon } from './FileIcon';
import { type UploadGroup, type UploadQueue, type UploadTask, useUploadGroups, useUploads } from './uploads';

const AUTO_HIDE_MS = 5_000;
/** Errors where trying the same upload again cannot help. */
const FINAL_ERRORS = new Set(['too_large', 'invalid_name', 'forbidden', 'not_found']);

/** Circular overall progress; at 100 % it turns into a check. */
function ProgressRing({ value, state }: { value: number; state: 'active' | 'done' | 'failed' }) {
  const r = 8;
  const c = 2 * Math.PI * r;
  if (state === 'done') {
    return <span className="flex size-6 items-center justify-center rounded-full bg-primary text-primary-foreground"><Check className="size-3.5" strokeWidth={3} /></span>;
  }
  if (state === 'failed') return <CircleAlert className="size-6 text-destructive" />;
  return (
    <svg viewBox="0 0 20 20" className="size-6 -rotate-90" aria-hidden>
      <circle cx="10" cy="10" r={r} fill="none" strokeWidth="2.5" className="stroke-border" />
      <circle
        cx="10" cy="10" r={r} fill="none" strokeWidth="2.5" strokeLinecap="round"
        className="stroke-primary transition-[stroke-dashoffset] duration-200"
        strokeDasharray={c} strokeDashoffset={c * (1 - value)}
      />
    </svg>
  );
}

function TaskRow({ task, queue }: { task: UploadTask; queue: UploadQueue }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const failed = task.status === 'error' || task.status === 'conflict';
  const renamed = task.status === 'done' && task.result && task.result.name !== task.file.name;

  let detail: string;
  if (task.status === 'queued') detail = t('files.uploads.queued');
  else if (task.status === 'uploading') {
    detail = t('files.uploads.progress', { loaded: formatBytes(task.file.size * task.progress, locale), total: formatBytes(task.file.size, locale) });
  } else if (failed) detail = t(errorKey(task.error));
  else if (renamed) detail = t('files.uploads.renamed', { name: task.result!.name });
  else detail = formatBytes(task.file.size, locale);

  async function retry() {
    if (task.error === 'unauthorized') await refreshSession();
    queue.retry(task.id);
  }

  return (
    <li className="flex items-center gap-3 px-4 py-2">
      <FileIcon item={{ type: 'file', name: task.file.name, mime: task.file.type || null }} className="size-5" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium" title={task.file.name}>{task.file.name}</div>
        <div className={cn('text-xs tabular-nums', failed ? 'line-clamp-2 text-destructive' : 'truncate text-muted-foreground')}>{detail}</div>
        {task.status === 'uploading' && (
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-border" role="progressbar" aria-label={task.file.name}
            aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(task.progress * 100)}>
            <div className="h-full origin-left rounded-full bg-primary transition-transform duration-200" style={{ transform: `scaleX(${task.progress})` }} />
          </div>
        )}
      </div>
      {failed ? (
        !FINAL_ERRORS.has(task.error ?? '') && <Button variant="ghost" size="icon-sm" onClick={() => void retry()} aria-label={t('files.uploads.retry')} title={t('files.uploads.retry')}>
          <RotateCw />
        </Button>
      ) : task.status === 'done' ? (
        <span className="flex size-8 items-center justify-center text-primary"><Check className="size-4" /></span>
      ) : (
        <Button variant="ghost" size="icon-sm" className="text-muted-foreground" onClick={() => queue.cancel(task.id)}
          aria-label={t('files.uploads.cancel')} title={t('files.uploads.cancel')}>
          <X />
        </Button>
      )}
      {failed && (
        <Button variant="ghost" size="icon-sm" className="-ml-2 text-muted-foreground" onClick={() => queue.cancel(task.id)} aria-label={t('files.uploads.dismiss')}>
          <X />
        </Button>
      )}
    </li>
  );
}

/** One folder upload: „Ordner „Urlaub“: 37 von 120 Dateien“, folder errors, failed files below. */
function GroupRow({ group, tasks, queue }: { group: UploadGroup; tasks: UploadTask[]; queue: UploadQueue }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const creating = group.state === 'creating';
  const active = creating || tasks.some((x) => x.status === 'queued' || x.status === 'uploading');
  const done = tasks.filter((x) => x.status === 'done').length;
  const failedTasks = tasks.filter((x) => x.status === 'error' || x.status === 'conflict');
  const bytes = tasks.reduce((s, x) => s + x.file.size, 0);
  const sent = tasks.reduce((s, x) => s + x.file.size * (x.status === 'done' ? 1 : x.progress), 0);
  const progress = bytes > 0 ? sent / bytes : done / Math.max(1, tasks.length);
  const skipped = group.errors.reduce((s, e) => s + e.files, 0);
  const label = t('files.uploads.folderProgress', { name: group.name, done, total: tasks.length });

  let detail: string;
  if (creating) detail = t('files.uploads.folderCreating');
  else if (active) detail = t('files.uploads.progress', { loaded: formatBytes(sent, locale), total: formatBytes(bytes, locale) });
  else detail = formatBytes(bytes, locale);

  return (
    <>
      <li className="flex items-center gap-3 px-4 py-2">
        <FileIcon item={{ type: 'folder', name: group.name, mime: null }} className="size-5" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium" title={label}>{label}</div>
          <div className="truncate text-xs text-muted-foreground tabular-nums">{detail}</div>
          {group.errors.length > 0 && (
            <div className="mt-0.5 text-xs text-destructive">
              <p>{t('files.uploads.folderErrors', { count: group.errors.length })}{skipped > 0 && ` ${t('files.uploads.folderSkipped', { count: skipped })}`}</p>
              <ul className="line-clamp-3">
                {group.errors.map((e) => <li key={e.path} className="truncate" title={e.path}>{t('files.uploads.folderError', { path: e.path, error: t(errorKey(e.code)) })}</li>)}
              </ul>
            </div>
          )}
          {active && !creating && (
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-border" role="progressbar" aria-label={label}
              aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
              <div className="h-full origin-left rounded-full bg-primary transition-transform duration-200" style={{ transform: `scaleX(${progress})` }} />
            </div>
          )}
        </div>
        {!active && group.errors.length === 0 && failedTasks.length === 0 ? (
          <span className="flex size-8 items-center justify-center text-primary"><Check className="size-4" /></span>
        ) : (
          <Button variant="ghost" size="icon-sm" className="text-muted-foreground" onClick={() => queue.cancelGroup(group.id)}
            aria-label={active ? t('files.uploads.cancelFolder') : t('files.uploads.dismiss')} title={active ? t('files.uploads.cancelFolder') : t('files.uploads.dismiss')}>
            <X />
          </Button>
        )}
      </li>
      {failedTasks.map((task) => <TaskRow key={task.id} task={task} queue={queue} />)}
    </>
  );
}

/** Bottom-right upload tray: collapsible, per-file progress, retry, auto-hides 5 s after a clean finish. */
export function UploadPanel({ queue }: { queue: UploadQueue }) {
  const { t } = useTranslation();
  const tasks = useUploads(queue);
  const groups = useUploadGroups(queue);
  const [collapsed, setCollapsed] = useState(false);

  const total = tasks.length;
  const creating = groups.some((g) => g.state === 'creating');
  const active = creating || tasks.some((x) => x.status === 'queued' || x.status === 'uploading');
  const done = tasks.filter((x) => x.status === 'done').length;
  const failed = tasks.filter((x) => x.status === 'error' || x.status === 'conflict').length + groups.reduce((s, g) => s + g.errors.length, 0);
  const empty = total === 0 && groups.length === 0;
  const groupIds = new Set(groups.map((g) => g.id));
  const loose = tasks.filter((x) => !x.groupId || !groupIds.has(x.groupId));
  const bytes = tasks.reduce((s, x) => s + x.file.size, 0);
  const sent = tasks.reduce((s, x) => s + x.file.size * (x.status === 'done' ? 1 : x.progress), 0);
  const progress = bytes > 0 ? sent / bytes : done / Math.max(1, total);

  useEffect(() => {
    if (empty || active || failed > 0) return;
    const id = window.setTimeout(() => queue.clearFinished(), AUTO_HIDE_MS);
    return () => window.clearTimeout(id);
  }, [empty, active, failed, queue]);

  useEffect(() => {
    if (!active) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [active]);

  useEffect(() => { if (empty) setCollapsed(false); }, [empty]);

  if (empty) return null;

  const title = active
    ? total === 0 ? t('files.uploads.folderCreating') : t('files.uploads.uploading', { done, total })
    : failed > 0 ? t('files.uploads.failed', { count: failed }) : t('files.uploads.done', { count: done });

  return (
    <section
      aria-label={t('files.uploads.region')}
      className="fixed right-2 bottom-2 left-2 z-30 overflow-hidden rounded-xl bg-popover text-popover-foreground shadow-lg ring-1 ring-foreground/10 animate-in fade-in-0 slide-in-from-bottom-4 duration-200 sm:right-4 sm:bottom-4 sm:left-auto sm:w-[22rem]"
    >
      <header className="flex h-13 items-center gap-3 pr-2 pl-4">
        <ProgressRing value={progress} state={active ? 'active' : failed > 0 ? 'failed' : 'done'} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold" aria-live="polite">{title}</div>
          {!active && (
            <div className="text-xs text-muted-foreground">
              {failed === 0 ? t('files.uploads.finished') : t('files.uploads.done', { count: done })}
            </div>
          )}
        </div>
        <Button variant="ghost" size="icon-sm" className="text-muted-foreground aria-expanded:bg-transparent aria-expanded:text-muted-foreground hover:aria-expanded:bg-muted" onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed} aria-label={collapsed ? t('files.uploads.expand') : t('files.uploads.collapse')}>
          <ChevronDown className={cn('transition-transform duration-150', collapsed && 'rotate-180')} />
        </Button>
        {!active && (
          <Button variant="ghost" size="icon-sm" className="text-muted-foreground" onClick={() => queue.clearInactive()} aria-label={t('files.uploads.close')}>
            <X />
          </Button>
        )}
      </header>
      {!collapsed && (
        <ul className="max-h-[min(18rem,45dvh)] overflow-y-auto border-t py-1">
          {groups.map((g) => <GroupRow key={`g${g.id}`} group={g} tasks={tasks.filter((x) => x.groupId === g.id)} queue={queue} />)}
          {loose.map((task) => <TaskRow key={task.id} task={task} queue={queue} />)}
        </ul>
      )}
    </section>
  );
}
