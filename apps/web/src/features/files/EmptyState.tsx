import { FolderPlus, FolderUp, Upload } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

/** Typographic empty folder: the panel itself reads as a drop area, with the two ways in (none when read-only). */
export function EmptyState({ isRoot, canAdd, onUpload, onUploadFolder, onNewFolder }: {
  isRoot: boolean; canAdd: boolean; onUpload(): void; onUploadFolder(): void; onNewFolder(): void;
}) {
  const { t } = useTranslation();
  return (
    <div className="p-4 md:p-6">
      <div className="flex min-h-[min(26rem,60dvh)] flex-col items-start justify-end rounded-2xl border border-dashed border-foreground/15 p-6 md:p-10">
        <h2 className="text-2xl font-semibold text-foreground">{isRoot ? t('files.empty.rootTitle') : t('files.empty.title')}</h2>
        <p className="mt-2 max-w-[46ch] text-base text-muted-foreground">{canAdd ? t('files.empty.body') : t('files.empty.readOnlyBody')}</p>
        {canAdd && (
          <div className="mt-6 flex flex-wrap gap-2">
            <Button onClick={onUpload}><Upload />{t('files.uploadFiles')}</Button>
            <Button variant="outline" onClick={onUploadFolder}><FolderUp />{t('files.uploadFolder')}</Button>
            <Button variant="outline" onClick={onNewFolder}><FolderPlus />{t('files.newFolderDialog.title')}</Button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Centered message used for load errors and missing folders. */
export function StatusMessage({ title, body, children }: { title: string; body?: string; children?: ReactNode }) {
  return (
    <div className="flex min-h-[60dvh] flex-col items-center justify-center px-6 text-center">
      <h2 className="text-xl font-semibold">{title}</h2>
      {body && <p className="mt-2 max-w-[44ch] text-base text-muted-foreground">{body}</p>}
      {children && <div className="mt-5">{children}</div>}
    </div>
  );
}

const WIDTHS = ['w-48', 'w-36', 'w-56', 'w-28', 'w-44', 'w-40', 'w-52', 'w-32'];

export function SkeletonRows({ view }: { view: 'list' | 'grid' }) {
  if (view === 'grid') {
    return (
      <div aria-hidden className="grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-3 px-4 pt-4 md:px-6 md:pt-5">
        {WIDTHS.map((w) => (
          <div key={w} className="p-1.5">
            <Skeleton className="aspect-[4/3] w-full rounded-lg" />
            <Skeleton className="mt-2.5 h-3.5 w-3/4" />
            <Skeleton className="mt-1.5 h-3 w-1/3" />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div aria-hidden>
      <div className="h-9 border-b" />
      {WIDTHS.map((w) => (
        <div key={w} className="flex h-11 items-center gap-3 border-b border-border/70 pr-4 pl-3 md:pl-6">
          <Skeleton className="size-5 rounded-sm" />
          <Skeleton className={`h-3.5 ${w}`} />
          <Skeleton className="ml-auto hidden h-3 w-20 sm:block" />
          <Skeleton className="hidden h-3 w-14 sm:block md:mr-12" />
        </div>
      ))}
    </div>
  );
}
