import type { SyncItem, SyncSpaceKind } from '@synclet/shared';
import { ChevronRight, Folder, House } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormError } from '@/components/auth/FormError';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { SpaceIcon } from '@/features/spaces/SpaceIcon';
import { isUnavailable, useSpaces, useUnavailableSpaces } from '@/features/spaces/useSpaces';
import { cn } from '@/lib/utils';
import { errorKey } from './errors';
import { ROOT_ID, useSubfolders } from './queries';

interface Target { id: string; name: string }

interface TreeCtx {
  /** The items being moved: none is a target, and a moved folder's subtree is never shown. */
  blocked: Set<string>;
  /** The parent all items share ("Current location"), else null. */
  currentParent: string | null;
  expanded: Set<string>;
  toggle(id: string): void;
  target: Target | null;
  setTarget(t: Target): void;
}

/** `space` marks a top-level node: the root of a space (its icon follows the space kind). */
function TreeNode({ node, depth, ctx, space }: { node: Target; depth: number; ctx: TreeCtx; space?: SyncSpaceKind }) {
  const { t } = useTranslation();
  // A moved folder can't be a target, and its subtree is never shown (descendants are invalid too).
  const self = ctx.blocked.has(node.id);
  const open = ctx.expanded.has(node.id) && !self;
  const { data: children, isPending } = useSubfolders(node.id, open);
  const selected = ctx.target?.id === node.id;
  const current = node.id === ctx.currentParent;

  return (
    <li role="none">
      <div
        className={cn(
          'group flex h-8 items-center gap-1 rounded-md pr-2 transition-colors duration-100',
          selected ? 'bg-accent-soft text-foreground' : !self && 'hover:bg-accent',
        )}
        style={{ paddingLeft: depth * 16 + 4 }}
      >
        <button
          type="button"
          disabled={self}
          aria-label={t(open ? 'files.moveDialog.collapse' : 'files.moveDialog.expand', { name: node.name })}
          aria-expanded={open}
          onClick={() => ctx.toggle(node.id)}
          className="flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 disabled:invisible"
        >
          <ChevronRight className={cn('size-3.5 transition-transform duration-150', open && 'rotate-90')} />
        </button>
        <button
          type="button"
          role="treeitem"
          aria-selected={selected}
          aria-disabled={self || undefined}
          disabled={self}
          onClick={() => ctx.setTarget(node)}
          onDoubleClick={() => { if (!self) ctx.toggle(node.id); }}
          className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-sm text-left text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-45"
        >
          {space === 'personal' ? <House className="size-4 shrink-0 text-muted-foreground" />
            : space ? <SpaceIcon kind={space} className="text-muted-foreground" />
              : <Folder className="size-4 shrink-0 fill-(--ft-folder)/20 text-(--ft-folder)" />}
          <span className="truncate">{node.name}</span>
          {current && <span className="ml-auto shrink-0 pl-2 text-xs text-muted-foreground">{t('files.moveDialog.currentLocation')}</span>}
        </button>
      </div>
      {open && (
        <ul role="group">
          {isPending ? (
            <li role="none" style={{ paddingLeft: (depth + 1) * 16 + 32 }} className="flex h-8 items-center">
              <Skeleton className="h-3.5 w-28" />
            </li>
          ) : children && children.length > 0 ? (
            children.map((c) => <TreeNode key={c.id} node={{ id: c.id, name: c.name }} depth={depth + 1} ctx={ctx} />)
          ) : (
            <li role="none" style={{ paddingLeft: (depth + 1) * 16 + 32 }} className="flex h-8 items-center text-xs text-muted-foreground">
              {t('files.moveDialog.noSubfolders')}
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

/** Folder tree picker; children load lazily as nodes expand. */
export function MoveDialog({ open, onOpenChange, items, expandedIds, onMove, onClosed }: {
  open: boolean;
  onOpenChange(open: boolean): void;
  items: SyncItem[];
  /** Folders to show expanded initially (the path to the current folder). */
  expandedIds: string[];
  onMove(target: Target): Promise<unknown>;
  onClosed?(): void;
}) {
  const { t } = useTranslation();
  const { spaces } = useSpaces();
  const unavailable = useUnavailableSpaces();
  // Top level: "My files" and every other space the user may write to (moves across spaces work).
  const roots = spaces.length === 0
    ? [{ id: ROOT_ID, name: t('shell.myFiles'), kind: 'personal' as const }]
    : spaces
      .filter((s) => s.kind === 'personal' || (s.canWrite && !isUnavailable(unavailable, s.id)))
      .map((s) => ({ id: s.rootId, name: s.kind === 'personal' ? t('shell.myFiles') : s.name, kind: s.kind }));
  const [expanded, setExpanded] = useState(() => new Set([ROOT_ID, ...expandedIds]));
  const [target, setTarget] = useState<Target | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const blocked = useMemo(() => new Set(items.map((i) => i.id)), [items]);
  const parents = new Set(items.map((i) => i.parentId));
  const currentParent = parents.size === 1 ? [...parents][0] : null;
  const one = items.length === 1 ? items[0] : null;

  const ctx: TreeCtx = {
    blocked,
    currentParent,
    expanded,
    toggle: (id) => setExpanded((s) => { const n = new Set(s); if (!n.delete(id)) n.add(id); return n; }),
    target,
    setTarget: (tg) => { setTarget(tg); setError(null); },
  };
  const canSubmit = !!target && target.id !== currentParent && !blocked.has(target.id) && !pending;

  async function submit() {
    if (!target || !canSubmit) return;
    setPending(true);
    setError(null);
    try {
      await onMove(target);
      onOpenChange(false);
    } catch (err) {
      setError(t(errorKey(err)));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!pending) onOpenChange(o); }}>
      <DialogContent className="gap-5 sm:max-w-lg" onCloseAutoFocus={(e) => { if (onClosed) { e.preventDefault(); onClosed(); } }}>
        <DialogHeader>
          <DialogTitle className="pr-8 text-lg font-semibold break-all">{one ? t('files.moveDialog.title', { name: one.name }) : t('files.moveDialog.titleMany', { count: items.length })}</DialogTitle>
          <DialogDescription>{t('files.moveDialog.description')}</DialogDescription>
        </DialogHeader>
        <div className="h-72 overflow-y-auto rounded-lg border p-1.5">
          <ul role="tree" aria-label={t('files.moveDialog.tree')}>
            {roots.map((r) => <TreeNode key={r.id} node={{ id: r.id, name: r.name }} depth={0} ctx={ctx} space={r.kind} />)}
          </ul>
        </div>
        <FormError>{error}</FormError>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={pending}>{t('common.cancel')}</Button>
          </DialogClose>
          <Button onClick={() => void submit()} disabled={!canSubmit} className="max-w-full min-w-0">
            <span className="truncate">
              {pending
                ? t('files.moveDialog.submitting')
                : target && target.id !== currentParent
                  ? t('files.moveDialog.submitTo', { name: target.name })
                  : t('files.moveDialog.submit')}
            </span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
