import { Download } from 'lucide-react';
import { type ComponentType, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { FileIcon, fileKind, kindStyle } from '@/features/files/FileIcon';
import { formatBytes } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useProbedDownload } from './download';
import type { PreviewKind, PreviewSource } from './preview';

/** Props of every viewer. A viewer calls `onUnavailable` when it cannot show the file after all. */
export interface ViewerProps {
  source: PreviewSource;
  onUnavailable(): void;
}
export type Viewer = ComponentType<ViewerProps>;

/**
 * Image: the 1024 px thumbnail; while there is none, the original for raster formats browsers
 * decode. SVG originals are never rendered (they could carry script), only their thumbnail.
 */
function ImageViewer({ source, onUnavailable }: ViewerProps) {
  const { t } = useTranslation();
  const candidates = [source.thumbnailUrl(1024), source.rasterSafe ? source.contentUrl : null].filter((u): u is string => !!u);
  const [index, setIndex] = useState(0);
  const src = candidates[index];
  useEffect(() => { if (!src) onUnavailable(); }, [src, onUnavailable]);
  if (!src) return null;
  return (
    <img
      key={src}
      src={src}
      alt={t('publicShare.preview.imageAlt', { name: source.name })}
      onError={() => setIndex((i) => i + 1)}
      className="max-h-full max-w-full rounded-md object-contain"
      draggable={false}
    />
  );
}

function VideoViewer({ source, onUnavailable }: ViewerProps) {
  return (
    <video
      src={source.contentUrl}
      poster={source.thumbnailUrl(1024) ?? undefined}
      controls
      playsInline
      preload="metadata"
      controlsList={source.downloadUrl ? undefined : 'nodownload'}
      onError={onUnavailable}
      className="max-h-full max-w-full rounded-md bg-black"
    />
  );
}

function AudioViewer({ source, onUnavailable }: ViewerProps) {
  return (
    <div className="flex w-full max-w-md flex-col items-center gap-6">
      <div style={kindStyle('audio')} className="flex size-28 items-center justify-center rounded-2xl bg-(--ft)/10">
        <FileIcon item={{ type: 'file', name: source.name, mime: source.mime }} strokeWidth={1.25} className="size-12" />
      </div>
      <audio
        src={source.contentUrl}
        controls
        preload="metadata"
        controlsList={source.downloadUrl ? undefined : 'nodownload'}
        onError={onUnavailable}
        className="w-full"
      />
    </div>
  );
}

function PdfViewer({ source }: ViewerProps) {
  return (
    <iframe
      src={source.contentUrl}
      title={source.name}
      className="size-full rounded-md border bg-background"
    />
  );
}

/**
 * Viewer per preview kind. Kinds missing here (text, markdown, code, none) show the fallback
 * panel. Task 9's QuickLook viewers plug in by adding entries, e.g. `viewers.markdown = …`.
 */
export const viewers: Partial<Record<PreviewKind, Viewer>> = {
  image: ImageViewer,
  video: VideoViewer,
  audio: AudioViewer,
  pdf: PdfViewer,
};

/** Shown when there is no viewer for a file, or the viewer gave up. */
export function NoPreview({ source, className }: { source: PreviewSource; className?: string }) {
  const { t, i18n } = useTranslation();
  const probed = useProbedDownload();
  const kind = fileKind({ type: 'file', name: source.name, mime: source.mime });
  return (
    <div className={cn('flex max-w-sm flex-col items-center text-center', className)}>
      <div style={kindStyle(kind)} className="flex size-24 items-center justify-center rounded-2xl bg-(--ft)/10">
        <FileIcon item={{ type: 'file', name: source.name, mime: source.mime }} strokeWidth={1.25} className="size-11" />
      </div>
      <p className="mt-5 text-lg font-semibold break-all">{source.name}</p>
      <p className="mt-1 text-sm text-muted-foreground tabular-nums">{formatBytes(source.size, i18n.language)}</p>
      <p className="mt-4 text-base text-muted-foreground">
        {source.downloadUrl ? t('publicShare.preview.none') : t('publicShare.preview.noneNoDownload')}
      </p>
      {source.downloadUrl && (
        <Button asChild className="mt-5">
          <a href={source.downloadUrl} download onClick={probed}>
            <Download />
            {t('publicShare.download')}
          </a>
        </Button>
      )}
    </div>
  );
}

/** Picks the viewer for `source` and falls back to `NoPreview`. Fills its parent box. */
export function PreviewStage({ source, className }: { source: PreviewSource; className?: string }) {
  const [failedFor, setFailedFor] = useState<string | null>(null);
  const failed = failedFor === source.contentUrl;
  const View = failed ? undefined : viewers[source.kind];
  const url = source.contentUrl;
  const onUnavailable = useCallback(() => setFailedFor(url), [url]);
  return (
    <div className={cn('flex min-h-0 items-center justify-center', className)}>
      {View ? <View key={source.contentUrl} source={source} onUnavailable={onUnavailable} /> : <NoPreview source={source} />}
    </div>
  );
}
