import { FileIcon, fileKind, kindStyle } from '@/features/files/FileIcon';
import type { ViewerProps } from './common';

/**
 * Native players with the preview-token content URL (the server answers Range requests, so
 * seeking works without downloading the whole file). The 1024 px thumbnail is the poster.
 */
export function MediaViewer({ source, onUnavailable }: ViewerProps) {
  const poster = source.thumbnailUrl(1024) ?? undefined;
  if (source.kind === 'video') {
    return (
      <video
        src={source.contentUrl}
        poster={poster}
        controls
        playsInline
        preload="metadata"
        onError={onUnavailable}
        className="max-h-full max-w-full rounded-lg bg-black outline-none"
      />
    );
  }
  const item = { type: 'file' as const, name: source.name, mime: source.mime };
  return (
    <div className="flex w-full max-w-md flex-col items-center gap-8">
      <div style={kindStyle(fileKind(item))} className="flex aspect-square w-56 max-w-full items-center justify-center overflow-hidden rounded-[1.75rem] bg-(--ft)/14 ring-1 ring-(--ft)/25 ring-inset">
        {poster
          ? <img src={poster} alt="" className="size-full object-cover" />
          : <FileIcon item={item} strokeWidth={1} className="size-20" />}
      </div>
      <audio src={source.contentUrl} controls preload="metadata" onError={onUnavailable} className="w-full" />
    </div>
  );
}
