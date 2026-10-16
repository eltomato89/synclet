import type { SyncItem } from '@synclet/shared';
import { type RefObject, useEffect, useState } from 'react';
import { previewToken, thumbnailUrlFor } from './preview-url';

type ThumbItem = Pick<SyncItem, 'id' | 'etag' | 'type' | 'preview'>;

export interface ThumbOptions {
  /** Folders get the server's mosaic of their children's thumbnails (grid tiles only). */
  folders?: boolean;
}

/**
 * Only files the worker has a thumbnail for get one requested; folders with a mosaic
 * (`preview.thumbnailKey`) only where the caller opts in.
 */
export const hasThumbnail = (item: ThumbItem, opts: ThumbOptions = {}) =>
  item.preview?.thumbnail === true
  && (item.type === 'file' || (!!opts.folders && item.type === 'folder' && !!item.preview.thumbnailKey));

/**
 * Resolves the thumbnail URL for an item (preview token from the shared cache). Nothing is
 * requested for items without `preview.thumbnail`, and nothing before `enabled` (the element
 * is near the viewport): `loading="lazy"` only defers the image, not the token request.
 */
export async function thumbnailUrl(item: ThumbItem, size: 256 | 1024, opts: ThumbOptions = {}): Promise<string | null> {
  if (!hasThumbnail(item, opts)) return null;
  const { token } = await previewToken(item);
  return thumbnailUrlFor(item, token, size);
}

export function useThumbnailUrl(item: ThumbItem, size: 256 | 1024, enabled: boolean, opts: ThumbOptions = {}): string | null {
  const wanted = hasThumbnail(item, opts);
  const [state, setState] = useState<{ key: string; url: string | null }>({ key: '', url: null });
  // A folder's picture changes with its children (thumbnailKey), not with its etag.
  const key = `${item.id}\n${item.etag}\n${item.preview?.thumbnailKey ?? ''}\n${size}`;
  useEffect(() => {
    if (!wanted || !enabled) return;
    let live = true;
    thumbnailUrl(item, size, opts).then(
      (url) => { if (live) setState({ key, url }); },
      () => { if (live) setState({ key, url: null }); },
    );
    return () => { live = false; };
    // `item` changes identity on every poll; the key captures what matters.
  }, [key, wanted, enabled]);
  return wanted && state.key === key ? state.url : null;
}

/** True once the element came within `margin` of the viewport (stays true). */
export function useNearViewport(ref: RefObject<Element | null>, margin = '300px'): boolean {
  const [near, setNear] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const el = ref.current;
    if (near || !el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { setNear(true); io.disconnect(); }
    }, { rootMargin: margin });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, near, margin]);
  return near;
}
