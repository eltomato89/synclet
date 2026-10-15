import { Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');

/** Splits a drop into plain files; dropped folders are reported separately (folder upload is Phase 1b). */
function collect(dt: DataTransfer): { files: File[]; skippedFolders: boolean } {
  const files: File[] = [];
  let skippedFolders = false;
  const items = Array.from(dt.items ?? []);
  if (items.length > 0 && typeof items[0].webkitGetAsEntry === 'function') {
    for (const it of items) {
      if (it.kind !== 'file') continue;
      const entry = it.webkitGetAsEntry();
      if (entry?.isDirectory) { skippedFolders = true; continue; }
      const f = it.getAsFile();
      if (f) files.push(f);
    }
    return { files, skippedFolders };
  }
  return { files: Array.from(dt.files), skippedFolders };
}

/**
 * Drop target covering the whole window: dragging files from the OS anywhere onto the page
 * shows an overlay; dropping enqueues them into the current folder.
 */
export function DropZone({ enabled, folderName, onFiles }: { enabled: boolean; folderName: string; onFiles(files: File[]): void }) {
  const { t } = useTranslation();
  const [active, setActive] = useState(false);
  const depth = useRef(0);
  const latest = useRef({ onFiles, t });
  latest.current = { onFiles, t };

  useEffect(() => {
    if (!enabled) return;
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current++;
      setActive(true);
    };
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setActive(false);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e) || !e.dataTransfer) return;
      e.preventDefault();
      depth.current = 0;
      setActive(false);
      const { files, skippedFolders } = collect(e.dataTransfer);
      if (skippedFolders) toast.info(latest.current.t('files.drop.foldersUnsupported'), { position: 'bottom-center' });
      if (files.length) latest.current.onFiles(files);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
      depth.current = 0;
      setActive(false);
    };
  }, [enabled]);

  if (!active) return null;
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-40 bg-canvas/70 p-3 backdrop-blur-[2px] animate-in fade-in-0 duration-150 md:p-4">
      <div className="flex h-full flex-col items-center justify-center gap-4 rounded-2xl border-2 border-dashed border-primary/60 bg-primary/4">
        <div className="flex size-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-md">
          <Upload className="size-6" />
        </div>
        <div className="text-center">
          <p className="text-xl font-semibold tracking-[-0.014em]">{t('files.drop.title')}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t('files.drop.target', { folder: folderName })}</p>
        </div>
      </div>
    </div>
  );
}
