import { Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { type Picked, pickedFromDataTransfer } from './folderUpload';

const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');

/**
 * Drop target covering the whole window: dragging files from the OS anywhere onto the page
 * shows an overlay; dropping hands the files and folders (walked recursively) to `onPicked`.
 */
export function DropZone({ enabled, folderName, onPicked, folders = true }: {
  enabled: boolean; folderName: string; onPicked(picked: Picked): void;
  /** False: dropped folders are listed in `picked.folders` but not read. */
  folders?: boolean;
}) {
  const { t } = useTranslation();
  const [active, setActive] = useState(false);
  const depth = useRef(0);
  const latest = useRef({ onPicked, t, folders });
  latest.current = { onPicked, t, folders };

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
      pickedFromDataTransfer(e.dataTransfer, { walk: latest.current.folders }).then(
        (picked) => { if (picked.files.length || picked.folders.length) latest.current.onPicked(picked); },
        () => { toast.error(latest.current.t('files.folderUpload.readFailed'), { position: 'bottom-center' }); },
      );
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
