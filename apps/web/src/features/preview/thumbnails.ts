import type { SyncItem } from '@synclet/shared';
import { type RefObject, useEffect, useState } from 'react';
import { previewToken, thumbnailUrlFor } from './preview-url';

type ThumbItem = Pick<SyncItem, 'id' | 'etag' | 'type' | 'preview'>;

/** Only files the worker has a thumbnail for get one requested. */
export const hasThumbnail = (item: ThumbItem) => item.type === 'file' && item.preview?.thumbnail === true;

/**
 * Resolves the thumbnail URL for an item (preview token from the shared cache). Nothing is
 * requested for items without `preview.thumbnail`, and nothing before `enabled` (the element
 * is near the viewport): `loading="lazy"` only defers the image, not the token request.
 */
export async function thumbnailUrl(item: ThumbItem, size: 256 | 1024): Promise<string | null> {
  if (!hasThumbnail(item)) return null;
  const { token } = await previewToken(item);
  return thumbnailUrlFor(item, token, size);
}

export function useThumbnailUrl(item: ThumbItem, size: 256 | 1024, enabled: boolean): string | null {
  const wanted = hasThumbnail(item);
  const [state, setState] = useState<{ key: string; url: string | null }>({ key: '', url: null });
  const key = `${item.id}\n${item.etag}\n${size}`;
  useEffect(() => {
    if (!wanted || !enabled) return;
    let live = true;
    thumbnailUrl(item, size).then(
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
