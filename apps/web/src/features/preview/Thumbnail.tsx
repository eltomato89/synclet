import type { SyncItem } from '@synclet/shared';
import { type ReactNode, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { useNearViewport, useThumbnailUrl } from './thumbnails';

/**
 * An item's thumbnail over its fallback (the file icon). The icon stays until the image has
 * decoded, then the image fades in on top; a failed image (e.g. an expired token after a long
 * night) leaves the icon. Items without `preview.thumbnail` never request anything.
 */
export function Thumbnail({ item, size = 256, className, imgClassName, children, overlay }: {
  item: SyncItem;
  size?: 256 | 1024;
  className?: string;
  imgClassName?: string;
  /** Fallback shown until (or instead of) the image. */
  children: ReactNode;
  /** Drawn over the loaded image (e.g. a play badge for videos). */
  overlay?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const near = useNearViewport(ref);
  const url = useThumbnailUrl(item, size, near);
  const [loaded, setLoaded] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const shown = !!url && loaded === url && failed !== url;

  return (
    <div ref={ref} className={cn('relative', className)} data-thumb={shown ? 'loaded' : undefined}>
      <div className={cn('contents', shown && '[&>*]:invisible')}>{children}</div>
      {url && failed !== url && (
        <img
          key={url}
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onLoad={() => setLoaded(url)}
          onError={() => setFailed(url)}
          className={cn(
            'absolute inset-0 size-full opacity-0 transition-opacity duration-200 ease-out',
            shown && 'opacity-100',
            imgClassName,
          )}
        />
      )}
      {shown && overlay}
    </div>
  );
}
