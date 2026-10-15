import type { PreviewInfo } from '@synclet/shared';

export type PreviewKind = PreviewInfo['kind'];

/** Raster formats sharp decodes directly (plus HEIC/HEIF via heif-convert, SVG via librsvg). */
export const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'heic', 'heif', 'tif', 'tiff', 'bmp'];
/** SVG is previewed only as a rasterized thumbnail, never served inline (it can carry script). */
export const SVG_EXTS = ['svg'];
export const PDF_EXTS = ['pdf'];
export const MARKDOWN_EXTS = ['md', 'markdown'];
export const TEXT_EXTS = ['txt', 'log', 'csv', 'tsv', 'ini', 'conf'];
export const VIDEO_EXTS = ['mp4', 'm4v', 'mov', 'webm', 'mkv'];
export const AUDIO_EXTS = ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus'];
/** Office documents: no preview kind, but text is extracted for search (Task 6). */
export const OFFICE_EXTS = ['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp'];

/** Extension → highlight.js language. */
const CODE_LANGUAGES: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', json: 'json',
  py: 'python', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', swift: 'swift',
  c: 'c', h: 'c', cpp: 'cpp', cs: 'csharp', rb: 'ruby', php: 'php', sh: 'bash',
  yml: 'yaml', yaml: 'yaml', toml: 'ini', xml: 'xml', html: 'xml', css: 'css', sql: 'sql',
};
export const CODE_EXTS = Object.keys(CODE_LANGUAGES);

/** Extensions whose files get a `thumb` derivative job. */
export const THUMB_EXTS = [...IMAGE_EXTS, ...SVG_EXTS, ...PDF_EXTS, ...VIDEO_EXTS];
/** Extensions whose files get a `text` derivative job. */
export const TEXT_JOB_EXTS = [...TEXT_EXTS, ...MARKDOWN_EXTS, ...CODE_EXTS, ...PDF_EXTS, ...OFFICE_EXTS];

/** Lower-case extension without the dot ('' if none; a leading dot alone is not an extension). */
export function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i <= 0 || i === name.length - 1 ? '' : name.slice(i + 1).toLowerCase();
}

const BY_EXT = new Map<string, PreviewKind>([
  ...IMAGE_EXTS.map((e) => [e, 'image'] as const),
  ...SVG_EXTS.map((e) => [e, 'image'] as const),
  ...PDF_EXTS.map((e) => [e, 'pdf'] as const),
  ...MARKDOWN_EXTS.map((e) => [e, 'markdown'] as const),
  ...TEXT_EXTS.map((e) => [e, 'text'] as const),
  ...CODE_EXTS.map((e) => [e, 'code'] as const),
  ...VIDEO_EXTS.map((e) => [e, 'video'] as const),
  ...AUDIO_EXTS.map((e) => [e, 'audio'] as const),
]);

/**
 * Preview kind of a file. The extension decides (it is what the thumbnail worker and the
 * content route's MIME type go by); the MIME type is only a fallback for unknown extensions,
 * and never yields 'image' for SVG/HTML-like types.
 */
export function previewKind(name: string, mime: string | null): PreviewKind {
  const byExt = BY_EXT.get(extOf(name));
  if (byExt) return byExt;
  if (!mime) return 'none';
  if (mime === 'text/plain') return 'text';
  if (mime === 'text/markdown') return 'markdown';
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'none';
}

/** highlight.js language for code files, undefined otherwise. */
export function codeLanguage(name: string): string | undefined {
  return CODE_LANGUAGES[extOf(name)];
}
