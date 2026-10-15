import type { PreviewInfo, PublicShareEntry } from '@synclet/shared';
import { shareUrls } from './api';

/**
 * Preview adapter
 * ===============
 * Viewers never build URLs themselves. They receive a `PreviewSource`, which says what kind of
 * file it is and where its bytes and thumbnails come from. The public share page builds sources
 * for `/api/public/shares/:token/...` (`publicPreviewSource`); the signed-in file browser
 * (Task 9's QuickLook) can build them for the sync API, so both pages share one set of viewers.
 *
 * Plugging in viewers: `PreviewStage` (PreviewViewer.tsx) looks up `viewers[source.kind]`.
 * Replace or add entries there (e.g. text / markdown / code from Task 9); kinds without a viewer
 * fall back to the "no preview" panel with a download button.
 *
 * Security: `contentUrl` is only ever used for media elements, iframes of PDFs and raster images.
 * SVG (and anything else that could run script) is shown through `thumbnailUrl` only.
 */
export type PreviewKind = PreviewInfo['kind'];

export interface PreviewSource {
  kind: PreviewKind;
  name: string;
  size: number;
  mime: string | null;
  /** Inline content (no attachment disposition). Allowed by the server even without downloads for previewable types. */
  contentUrl: string;
  /** Attachment download, or null when the share does not allow downloads. */
  downloadUrl: string | null;
  /** Server-rendered WebP thumbnail, or null when it is known not to exist. */
  thumbnailUrl(size: 256 | 1024): string | null;
  /** True when the original may be shown in an `<img>` (raster formats browsers decode; never SVG). */
  rasterSafe: boolean;
}

const ext = (name: string) => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};

const RASTER = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp']);
const IMAGE = new Set([...RASTER, 'svg', 'heic', 'heif', 'tif', 'tiff', 'ico']);
const VIDEO = new Set(['mp4', 'm4v', 'mov', 'webm', 'ogv']);
const AUDIO = new Set(['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'oga', 'opus']);
const MARKDOWN = new Set(['md', 'markdown']);
const TEXT = new Set(['txt', 'log', 'csv', 'tsv']);
const CODE = new Set([
  'json', 'yaml', 'yml', 'toml', 'xml', 'html', 'htm', 'css', 'scss', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb',
  'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'sh', 'zsh', 'bash', 'ps1', 'sql', 'ini', 'conf',
  'cfg', 'lua', 'dart', 'vue', 'svelte',
]);

/** Preview kind of a file from its name (and mime as a fallback). */
export function previewKind(name: string, mime: string | null): PreviewKind {
  const e = ext(name);
  if (IMAGE.has(e)) return 'image';
  if (VIDEO.has(e)) return 'video';
  if (AUDIO.has(e)) return 'audio';
  if (e === 'pdf') return 'pdf';
  if (MARKDOWN.has(e)) return 'markdown';
  if (CODE.has(e)) return 'code';
  if (TEXT.has(e)) return 'text';
  const m = mime ?? '';
  if (m === 'application/pdf') return 'pdf';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('image/') && m !== 'image/svg+xml') return 'image';
  if (m.startsWith('text/')) return 'text';
  return 'none';
}

export const isRasterSafe = (name: string) => RASTER.has(ext(name));

/**
 * Source of a file inside a public share. `entry.id` is its sync id; `''` addresses the shared
 * item itself (file shares). `hasThumbnail: undefined` means unknown: the thumbnail is tried.
 */
export function publicPreviewSource(
  token: string,
  entry: Pick<PublicShareEntry, 'name' | 'size' | 'mime'> & { id: string; hasThumbnail?: boolean },
  allowDownload: boolean,
): PreviewSource {
  const urls = shareUrls(token);
  return {
    kind: previewKind(entry.name, entry.mime),
    name: entry.name,
    size: entry.size,
    mime: entry.mime,
    contentUrl: urls.content(entry.id),
    downloadUrl: allowDownload ? urls.content(entry.id, { download: true }) : null,
    thumbnailUrl: (size) => (entry.hasThumbnail === false ? null : urls.thumbnail(entry.id, size)),
    rasterSafe: isRasterSafe(entry.name),
  };
}
