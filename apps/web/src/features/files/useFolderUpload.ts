import type { SyncItem } from '@synclet/shared';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ApiError, api } from '@/lib/api';
import { errorKey } from './errors';
import {
  buildPlan, type ConflictAnswer, type ConflictQuestion, type FolderUploadDeps, type Picked, resolveChoices, type TreeTarget, uploadTree,
} from './folderUpload';
import { fetchAllChildren } from './queries';
import type { UploadQueue } from './uploads';

const createFolder: FolderUploadDeps['createFolder'] = (parentId, name, onConflict) =>
  api<SyncItem>('/sync/v1/items', { method: 'POST', json: { parentId, type: 'folder', name, onConflict } });

/**
 * Uploads picked or dropped files and folders into `folderId`: loose files go straight into the
 * queue; for every folder whose name already exists the user decides (merge / keep both / skip),
 * then its folders are created and its files queued as one group in the upload panel.
 * Render `question`/`answer` with `FolderConflictDialog`.
 */
export function useFolderUpload({ queue, folderId, siblings, onFoldersChanged }: {
  queue: UploadQueue; folderId: string; siblings: SyncItem[]; onFoldersChanged(): void;
}) {
  const { t } = useTranslation();
  const [question, setQuestion] = useState<ConflictQuestion | null>(null);
  const resolver = useRef<((a: ConflictAnswer) => void) | null>(null);
  /** Conflict questions of one pick at a time: a later pick waits until the dialog is done. */
  const turn = useRef<Promise<unknown>>(Promise.resolve());
  const latest = useRef({ siblings, onFoldersChanged, t });
  latest.current = { siblings, onFoldersChanged, t };

  const ask = (q: ConflictQuestion) => new Promise<ConflictAnswer>((resolve) => {
    resolver.current = resolve;
    setQuestion(q);
  });
  const answer = (a: ConflictAnswer) => {
    const r = resolver.current;
    resolver.current = null;
    setQuestion(null);
    r?.(a);
  };

  async function runTree({ tree, mergeInto, mergeName }: TreeTarget, g: number) {
    const deps: FolderUploadDeps = { createFolder, listChildren: fetchAllChildren, enqueue: (files, parentId) => queue.enqueue(files, parentId, g) };
    try {
      const res = await uploadTree(tree, { parentId: folderId, mergeInto, mergeName }, deps, {
        onRoot: (root) => { queue.updateGroup(g, { name: root.name }); if (!mergeInto) latest.current.onFoldersChanged(); },
        cancelled: () => !queue.hasGroup(g),
      });
      if (res.cancelled) return;
      queue.updateGroup(g, { state: 'ready', errors: res.errors });
      if (!res.rootId) {
        const { t: tr } = latest.current;
        toast.error(tr('files.folderUpload.failed', { name: tree.name, error: tr(errorKey(res.errors[0]?.code)) }), { position: 'bottom-center' });
      }
    } catch (e) {
      queue.updateGroup(g, { state: 'ready', errors: [{ path: tree.name, code: e instanceof ApiError ? e.code : 'unknown', files: tree.files.length }] });
    } finally {
      latest.current.onFoldersChanged();
    }
  }

  async function upload(picked: Picked) {
    if (picked.unreadable) {
      toast.error(latest.current.t('files.folderUpload.unreadable', { count: picked.unreadable }), { position: 'bottom-center' });
    }
    const plan = buildPlan(picked);
    if (plan.looseFiles.length) queue.enqueue(plan.looseFiles, folderId);
    if (plan.trees.length === 0) return;
    // Siblings are read when this pick's turn comes, so an earlier pick's new folders count.
    const choices = turn.current.then(() => resolveChoices(plan.trees, latest.current.siblings, ask));
    turn.current = choices.catch(() => undefined);
    const targets = await choices;
    // Every folder shows up in the panel right away; they are created one after the other (many
    // small requests), their files then upload in parallel anyway.
    const groups = targets.map((target) => [target, queue.addGroup(target.mergeName ?? target.tree.name)] as const);
    for (const [target, g] of groups) {
      if (queue.hasGroup(g)) await runTree(target, g);
    }
  }

  return { upload, question, answer };
}
