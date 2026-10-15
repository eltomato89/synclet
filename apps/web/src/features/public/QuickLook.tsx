import { ChevronLeft, ChevronRight, Download, X } from 'lucide-react';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { formatBytes } from '@/lib/format';
import type { PreviewSource } from './preview';
import { PreviewStage } from './PreviewViewer';

/**
 * Full-size preview of one file of a folder share, with previous / next through the files of
 * the folder (buttons and arrow keys) and a download button when the link allows downloads.
 */
export function QuickLook({ sources, index, onIndex, onClose }: {
  sources: PreviewSource[];
  index: number | null;
  onIndex(i: number): void;
  onClose(): void;
}) {
  const { t, i18n } = useTranslation();
  const source = index === null ? null : sources[index];
  const count = sources.length;
  const go = (delta: number) => { if (index !== null && count > 1) onIndex((index + delta + count) % count); };

  useEffect(() => {
    if (index === null || count < 2) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.metaKey || e.ctrlKey) return;
      // Media elements use the arrow keys for seeking.
      if (e.target instanceof HTMLMediaElement) return;
      if (e.key === 'ArrowRight') { e.preventDefault(); onIndex((index + 1) % count); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); onIndex((index - 1 + count) % count); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, count, onIndex]);

  return (
    <Dialog open={source !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[min(90dvh,960px)] w-[calc(100%-1rem)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-6xl"
      >
        {source && (
          <>
            <header className="flex items-center gap-3 border-b py-2 pr-2 pl-4">
              <div className="min-w-0 flex-1">
                <DialogTitle className="truncate text-base font-semibold" title={source.name}>{source.name}</DialogTitle>
                <DialogDescription className="text-xs text-muted-foreground tabular-nums">
                  {count > 1
                    ? t('publicShare.quickLook.position', { index: index! + 1, count, size: formatBytes(source.size, i18n.language) })
                    : formatBytes(source.size, i18n.language)}
                </DialogDescription>
              </div>
              {source.downloadUrl && (
                <Button asChild variant="outline" size="sm">
                  <a href={source.downloadUrl} download>
                    <Download />
                    <span className="max-sm:sr-only">{t('publicShare.download')}</span>
                  </a>
                </Button>
              )}
              <DialogClose asChild>
                <Button variant="ghost" size="icon-sm" aria-label={t('common.close')}>
                  <X />
                </Button>
              </DialogClose>
            </header>
            <div className="relative flex min-h-0 flex-1 bg-canvas">
              <PreviewStage source={source} className="flex-1 p-3 sm:p-6" />
              {count > 1 && (
                <>
                  <Button
                    variant="outline" size="icon" onClick={() => go(-1)} aria-label={t('publicShare.quickLook.previous')}
                    className="absolute top-1/2 left-2 -translate-y-1/2 rounded-full bg-background/90 backdrop-blur-sm sm:left-3"
                  >
                    <ChevronLeft />
                  </Button>
                  <Button
                    variant="outline" size="icon" onClick={() => go(1)} aria-label={t('publicShare.quickLook.next')}
                    className="absolute top-1/2 right-2 -translate-y-1/2 rounded-full bg-background/90 backdrop-blur-sm sm:right-3"
                  >
                    <ChevronRight />
                  </Button>
                </>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
