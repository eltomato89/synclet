import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { ConflictAnswer, ConflictChoice, ConflictQuestion } from './folderUpload';

/**
 * Asked when an uploaded folder's name already exists in the target folder: merge into the
 * existing folder, keep both ("Urlaub (2)") or leave this folder out. An existing file can only
 * be kept next to. With more conflicts to come, "apply to all" answers them too.
 */
export function FolderConflictDialog({ question, onAnswer }: { question: ConflictQuestion | null; onAnswer(a: ConflictAnswer): void }) {
  return (
    <Dialog open={!!question} onOpenChange={(o) => { if (!o) onAnswer({ choice: 'cancel', applyAll: false }); }}>
      {/* Keyed per question so "apply to all" starts unchecked every time. */}
      {question && <ConflictContent key={`${question.name}|${question.remaining}`} q={question} onAnswer={onAnswer} />}
    </Dialog>
  );
}

function ConflictContent({ q, onAnswer }: { q: ConflictQuestion; onAnswer(a: ConflictAnswer): void }) {
  const { t } = useTranslation();
  const [applyAll, setApplyAll] = useState(false);
  const answer = (choice: ConflictChoice) => onAnswer({ choice, applyAll: q.remaining > 0 && applyAll });
  const isFolder = q.existingType === 'folder';
  return (
    <DialogContent className="gap-5" showCloseButton={false}>
      <DialogHeader>
        <DialogTitle className="text-lg font-semibold">{t('files.folderConflict.title', { name: q.name })}</DialogTitle>
        <DialogDescription>{isFolder ? t('files.folderConflict.folderBody') : t('files.folderConflict.fileBody')}</DialogDescription>
      </DialogHeader>
      {q.remaining > 0 && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4 accent-primary" checked={applyAll} onChange={(e) => setApplyAll(e.target.checked)} />
          {t('files.folderConflict.applyAll')}
        </label>
      )}
      <DialogFooter className="sm:flex-wrap">
        <Button variant="outline" onClick={() => answer('cancel')}>{t('common.cancel')}</Button>
        <Button variant={isFolder ? 'outline' : 'default'} className="max-w-full" onClick={() => answer('rename')}>
          <span className="truncate">{t('files.folderConflict.keep', { name: q.keepName })}</span>
        </Button>
        {isFolder && <Button autoFocus onClick={() => answer('merge')}>{t('files.folderConflict.merge')}</Button>}
      </DialogFooter>
    </DialogContent>
  );
}
