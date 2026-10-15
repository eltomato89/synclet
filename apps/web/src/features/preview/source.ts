import type { PreviewInfo, SyncItem } from '@synclet/shared';
import { api } from '@/lib/api';
import { previewToken, thumbnailUrlFor } from './preview-url';

/**
 * Preview sources
 * ===============
 * Viewers never build URLs themselves: they receive a `PreviewSource` saying what the file is and
 * where its bytes, thumbnails and text come from. The signed-in browser builds sources for the
 * sync API (`syncPreviewSource`); the public share page can build them for its own routes, so
 * both use the same viewers. The shape matches the public page's adapter (Task 11) plus the
 * optional `language` and `loadText`.
 *
 * Security: `contentUrl` is only ever put into media elements, the PDF iframe and `<img>` for
 * `rasterSafe` formats. SVG, HEIC, TIFF and BMP originals are never loaded, only their WebP
 * thumbnail: an SVG can carry script and the others are not decoded by every browser anyway.
 */
export type PreviewKind = PreviewInfo['kind'];

export interface PreviewText { text: string; truncated: boolean; encoding: 'utf-8' | 'latin1' }

export interface PreviewSource {
  kind: PreviewKind;
  name: string;
  size: number;
  mime: string | null;
  /** Inline content URL (no attachment disposition). */
  contentUrl: string;
  /** Attachment download, or null when downloads are not allowed. */
  downloadUrl: string | null;
  /** Server-rendered WebP thumbnail, or null when there is none (yet). */
  thumbnailUrl(size: 256 | 1024): string | null;
  /** True when the original may be shown in an `<img>`. */
  rasterSafe: boolean;
  /** highlight.js language for `kind === 'code'`. */
  language?: string;
  /** Text for text/markdown/code previews. */
  loadText?(signal: AbortSignal): Promise<PreviewText>;
}

const extOf = (name: string) => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};

/** Originals every current browser decodes and that cannot run script. */
const RASTER_SAFE = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif']);
export const isRasterSafe = (name: string) => RASTER_SAFE.has(extOf(name));

/** True when double-click / Space should open QuickLook rather than download. */
export function isPreviewable(item: Pick<SyncItem, 'type' | 'name' | 'preview'>): boolean {
  const p = item.preview;
  if (item.type !== 'file' || !p || p.kind === 'none') return false;
  // Images that may not be loaded directly need their thumbnail.
  return p.kind !== 'image' || p.thumbnail || isRasterSafe(item.name);
}

/** Source for a file of the signed-in user (resolves a preview token first). */
export async function syncPreviewSource(item: SyncItem): Promise<PreviewSource> {
  const { token, contentUrl } = await previewToken(item);
  const preview = item.preview ?? { kind: 'none', thumbnail: false };
  const id = encodeURIComponent(item.id);
  return {
    kind: preview.kind,
    name: item.name,
    size: item.size,
    mime: item.mime,
    contentUrl,
    downloadUrl: `${contentUrl}&download=1`,
    thumbnailUrl: (size) => (preview.thumbnail ? thumbnailUrlFor(item, token, size) : null),
    rasterSafe: isRasterSafe(item.name),
    language: preview.language,
    loadText: (signal) => api<PreviewText>(`/sync/v1/items/${id}/preview-text`, { signal }),
  };
}
