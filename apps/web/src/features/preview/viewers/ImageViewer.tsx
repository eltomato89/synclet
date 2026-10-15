import { Maximize, Scan } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { Loading, type ViewerProps } from './common';

/**
 * Candidates in display order: the 1024 px WebP thumbnail (fast, always safe), then the original
 * for raster formats browsers decode. SVG/HEIC/TIFF/BMP originals are never loaded – they stay on
 * the thumbnail (an SVG could carry script).
 */
export function imageCandidates(source: ViewerProps['source']): string[] {
  return [source.thumbnailUrl(1024), source.rasterSafe ? source.contentUrl : null].filter((u): u is string => !!u);
}

/**
 * Shows the thumbnail at once and swaps in the original when it has loaded in the background.
 * Fit (default) scales the picture into the stage; actual size shows it 1:1 and scrolls.
 */
export function ImageViewer({ source, onUnavailable }: ViewerProps) {
  const { t } = useTranslation();
  const candidates = useMemo(() => imageCandidates(source), [source]);
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  const [best, setBest] = useState<string | null>(null);
  const [actual, setActual] = useState(false);
  const usable = candidates.filter((u) => !failed.has(u));
  const original = source.rasterSafe ? source.contentUrl : null;
  // Display the original once it is decoded, else the first usable candidate.
  const src = best && !failed.has(best) ? best : usable[0] ?? null;

  useEffect(() => { if (usable.length === 0) onUnavailable(); }, [usable.length, onUnavailable]);

  // Preload the original behind the thumbnail.
  useEffect(() => {
    if (!original || candidates[0] === original) return;
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => setBest(original);
    img.onerror = () => setFailed((f) => new Set(f).add(original));
    img.src = original;
    return () => { img.onload = null; img.onerror = null; };
  }, [original, candidates]);

  const [loaded, setLoaded] = useState<string | null>(null);
  if (!src) return null;
  const ZoomIcon = actual ? Scan : Maximize;

  return (
    <div className="relative flex size-full items-center justify-center">
      <div className={cn('flex size-full', actual ? 'overflow-auto overscroll-contain' : 'items-center justify-center')}>
        <img
          src={src}
          alt={source.name}
          draggable={false}
          onLoad={() => setLoaded(src)}
          onError={() => setFailed((f) => new Set(f).add(src))}
          onClick={() => setActual((a) => !a)}
          className={cn(
            'select-none transition-opacity duration-200',
            loaded ? 'opacity-100' : 'opacity-0',
            actual ? 'm-auto max-w-none cursor-zoom-out' : 'max-h-full max-w-full cursor-zoom-in object-contain',
          )}
        />
      </div>
      {!loaded && <Loading className="absolute inset-0" />}
      <button
        type="button"
        onClick={() => setActual((a) => !a)}
        aria-pressed={actual}
        className="absolute bottom-3 left-1/2 inline-flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full bg-black/60 px-3 text-xs font-medium text-white/90 ring-1 ring-white/10 backdrop-blur-md outline-none transition-colors hover:bg-black/75 focus-visible:ring-3 focus-visible:ring-ring"
      >
        <ZoomIcon aria-hidden className="size-3.5" />
        {actual ? t('preview.zoomFit') : t('preview.zoomActual')}
      </button>
    </div>
  );
}
