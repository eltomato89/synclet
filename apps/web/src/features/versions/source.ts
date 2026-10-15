import type { SyncItem, VersionWire } from '@synclet/shared';
import { previewToken } from '@/features/preview/preview-url';
import { isRasterSafe, type PreviewSource, type PreviewText } from '@/features/preview/source';
import { versionContentUrl } from './queries';

/** Largest text / PDF the panel pulls into the browser for a preview. */
export const MAX_TEXT_BYTES = 256 * 1024;
export const MAX_PDF_BYTES = 50 * 1024 * 1024;

const created = new Set<string>();
/** Frees the blob URLs made for PDF previews (call when the panel closes). */
export function revokeVersionBlobs() {
  for (const u of created) URL.revokeObjectURL(u);
  created.clear();
}

/** Whether a version of this file can be previewed from its content (no thumbnails exist for versions). */
export function canPreviewVersion(item: Pick<SyncItem, 'name' | 'preview'>): boolean {
  const kind = item.preview?.kind;
  if (!kind || kind === 'none') return false;
  // SVG/HEIC/TIFF/BMP originals are never loaded, and without a thumbnail there is nothing else to show.
  if (kind === 'image') return isRasterSafe(item.name);
  return true;
}

/** Drops a UTF-8 sequence cut off at the end of `bytes` (a byte-range cap can split a character). */
export function trimIncompleteUtf8(bytes: Uint8Array): Uint8Array {
  const n = bytes.length;
  for (let back = 1; back <= Math.min(3, n); back++) {
    const b = bytes[n - back];
    if ((b & 0xc0) === 0x80) continue; // continuation byte: keep looking for the lead byte
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    return need > back ? bytes.subarray(0, n - back) : bytes;
  }
  return bytes;
}

export function decode(buf: ArrayBuffer, truncated: boolean): { text: string; encoding: 'utf-8' | 'latin1' } {
  const all = new Uint8Array(buf);
  const bytes = truncated ? trimIncompleteUtf8(all) : all;
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' }; } catch {
    return { text: new TextDecoder('latin1').decode(all), encoding: 'latin1' };
  }
}

/**
 * Preview source for an old version. `contentUrl` is the version content route with the item's
 * preview token. That route is an attachment, which an `<iframe>` would download instead of show,
 * so PDFs are fetched and framed from a blob URL; text is fetched and capped.
 */
export async function versionPreviewSource(item: SyncItem, version: VersionWire): Promise<PreviewSource> {
  const { token } = await previewToken(item);
  const url = versionContentUrl(item.id, version.id, token);
  const kind = canPreviewVersion(item) ? item.preview?.kind ?? 'none' : 'none';
  const base: PreviewSource = {
    kind, name: item.name, size: version.size, mime: item.mime,
    contentUrl: url, downloadUrl: url, thumbnailUrl: () => null,
    rasterSafe: kind === 'image' && isRasterSafe(item.name), language: item.preview?.language,
  };
  if (kind === 'pdf') {
    if (version.size > MAX_PDF_BYTES) return { ...base, kind: 'none' };
    const res = await fetch(url);
    if (!res.ok) throw new Error(`version content ${res.status}`);
    const blob = new Blob([await res.arrayBuffer()], { type: 'application/pdf' });
    const blobUrl = URL.createObjectURL(blob);
    created.add(blobUrl);
    return { ...base, contentUrl: blobUrl };
  }
  if (kind === 'text' || kind === 'markdown' || kind === 'code') {
    return {
      ...base,
      async loadText(signal): Promise<PreviewText> {
        const res = await fetch(url, { signal, headers: { Range: `bytes=0-${MAX_TEXT_BYTES - 1}` } });
        if (!res.ok) throw new Error(`version content ${res.status}`);
        const buf = (await res.arrayBuffer()).slice(0, MAX_TEXT_BYTES);
        const truncated = version.size > MAX_TEXT_BYTES;
        return { ...decode(buf, truncated), truncated };
      },
    };
  }
  return base;
}
