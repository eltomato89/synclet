import type { SyncItem } from '@synclet/shared';
import {
  File, FileArchive, FileAudio, FileCode, FileImage, FileSpreadsheet, FileText, FileVideo, Folder, Presentation,
  type LucideIcon,
} from 'lucide-react';
import type { CSSProperties } from 'react';
import { cn } from '@/lib/utils';

export type FileKind =
  | 'folder' | 'image' | 'video' | 'audio' | 'pdf' | 'code' | 'archive' | 'spreadsheet' | 'presentation' | 'document' | 'generic';

const EXT: Record<string, FileKind> = {};
const add = (kind: FileKind, exts: string) => { for (const e of exts.split(' ')) EXT[e] = kind; };
add('image', 'jpg jpeg png gif webp avif heic heif bmp tif tiff svg ico raw cr2 nef arw dng psd');
add('video', 'mp4 m4v mov avi mkv webm wmv flv mpg mpeg 3gp');
add('audio', 'mp3 m4a aac wav flac ogg oga opus aiff aif wma mid midi');
add('pdf', 'pdf');
add('code', 'txt md markdown json yaml yml toml xml html htm css scss js mjs cjs ts tsx jsx py rb go rs java kt swift c h cpp hpp cs php sh zsh bash ps1 sql ini conf cfg env log lua dart vue svelte');
add('archive', 'zip rar 7z tar gz tgz bz2 xz zst dmg iso');
add('spreadsheet', 'xls xlsx xlsm ods numbers csv tsv');
add('presentation', 'ppt pptx odp key');
add('document', 'doc docx odt rtf pages epub tex');

export function fileKind(item: Pick<SyncItem, 'type' | 'name' | 'mime'>): FileKind {
  if (item.type === 'folder') return 'folder';
  const dot = item.name.lastIndexOf('.');
  const ext = dot > 0 ? item.name.slice(dot + 1).toLowerCase() : '';
  if (EXT[ext]) return EXT[ext];
  const mime = item.mime ?? '';
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('text/')) return 'code';
  return 'generic';
}

const ICONS: Record<FileKind, LucideIcon> = {
  folder: Folder, image: FileImage, video: FileVideo, audio: FileAudio, pdf: FileText, code: FileCode,
  archive: FileArchive, spreadsheet: FileSpreadsheet, presentation: Presentation, document: FileText, generic: File,
};

/** Tint for a kind as a CSS custom property, usable as `text-(--ft)` / `bg-(--ft)/10`. */
export function kindStyle(kind: FileKind): CSSProperties {
  return { '--ft': `var(--ft-${kind})` } as CSSProperties;
}

/** File-type icon tinted per kind. Folders are drawn filled so they stand apart from files. */
export function FileIcon({ item, className, strokeWidth = 1.75 }: { item: Pick<SyncItem, 'type' | 'name' | 'mime'>; className?: string; strokeWidth?: number }) {
  const kind = fileKind(item);
  const Icon = ICONS[kind];
  return (
    <Icon
      aria-hidden
      strokeWidth={strokeWidth}
      style={kindStyle(kind)}
      className={cn('shrink-0 text-(--ft)', kind === 'folder' && 'fill-(--ft)/20', className)}
    />
  );
}
