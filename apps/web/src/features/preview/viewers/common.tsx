import { Download, LoaderCircle } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { FileIcon, fileKind, kindStyle } from '@/features/files/FileIcon';
import { formatBytes } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { PreviewSource, PreviewText } from '../source';

/** Props of every viewer. A viewer calls `onUnavailable` when it cannot show the file after all. */
export interface ViewerProps {
  source: PreviewSource;
  onUnavailable(): void;
  /** Starts a download of the original, when allowed. */
  onDownload?(): void;
}

/** Spinner that appears only if loading takes longer than a blink (no flash on cached content). */
export function Loading({ className }: { className?: string }) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  useEffect(() => { const id = window.setTimeout(() => setVisible(true), 180); return () => window.clearTimeout(id); }, []);
  return (
    <div role="status" className={cn('flex items-center justify-center text-white/60 transition-opacity duration-150', visible ? 'opacity-100' : 'opacity-0', className)}>
      <LoaderCircle aria-hidden className="size-6 animate-spin" strokeWidth={1.75} />
      <span className="sr-only">{t('preview.loading')}</span>
    </div>
  );
}

/** Big file icon, a message and the download button: for files without a preview or a failed one. */
export function NoPreview({ source, failed = false, onDownload }: { source: PreviewSource; failed?: boolean; onDownload?(): void }) {
  const { t, i18n } = useTranslation();
  const item = { type: 'file' as const, name: source.name, mime: source.mime };
  return (
    <div className="flex max-w-sm flex-col items-center text-center text-white">
      <div style={kindStyle(fileKind(item))} className="mb-6 flex size-32 items-center justify-center rounded-[1.75rem] bg-(--ft)/14 ring-1 ring-(--ft)/25 ring-inset">
        <FileIcon item={item} strokeWidth={1} className="size-16" />
      </div>
      <p className="text-lg font-semibold tracking-tight">{t('preview.none.title')}</p>
      <p className="mt-1.5 text-sm text-white/65">
        {failed ? t('preview.none.failed') : t('preview.none.body')}
      </p>
      <p className="mt-1 text-xs text-white/45 tabular-nums">{formatBytes(source.size, i18n.language)}</p>
      {onDownload && (
        <Button className="mt-6" onClick={onDownload}>
          <Download />{t('common.download')}
        </Button>
      )}
    </div>
  );
}

/**
 * Paper sheet for text, code and markdown: the document floats on the dark stage in the app's
 * own theme colours, so a README looks like a page and not like a terminal.
 */
export function Sheet({ children, className, footer }: { children: ReactNode; className?: string; footer?: ReactNode }) {
  return (
    <div className={cn('flex max-h-full w-full max-w-[58rem] flex-col overflow-hidden rounded-xl bg-background text-foreground ring-1 ring-white/10', className)}>
      <div className="min-h-0 flex-1 overflow-auto overscroll-contain">{children}</div>
      {footer}
    </div>
  );
}

/** Shown under text previews the server cut off. */
export function TruncatedNote({ onDownload }: { onDownload?(): void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t bg-muted/60 px-5 py-2.5 text-xs text-muted-foreground">
      <span>{t('preview.truncated')}</span>
      {onDownload && (
        <Button size="xs" variant="outline" onClick={onDownload}><Download />{t('common.download')}</Button>
      )}
    </div>
  );
}

type TextState = { status: 'loading' } | { status: 'ready'; data: PreviewText } | { status: 'error' };

/** Loads the preview text of a source (aborted when the viewer goes away). */
export function usePreviewText(source: PreviewSource, onUnavailable: () => void): TextState {
  const [state, setState] = useState<TextState>({ status: 'loading' });
  useEffect(() => {
    if (!source.loadText) { setState({ status: 'error' }); onUnavailable(); return; }
    const ctrl = new AbortController();
    source.loadText(ctrl.signal).then(
      (data) => setState({ status: 'ready', data }),
      () => { if (!ctrl.signal.aborted) { setState({ status: 'error' }); onUnavailable(); } },
    );
    return () => ctrl.abort();
  }, [source, onUnavailable]);
  return state;
}
