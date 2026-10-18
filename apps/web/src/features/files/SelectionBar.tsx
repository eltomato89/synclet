import { Copy, Download, FolderInput, type LucideIcon, Trash2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { BulkActions, BulkCaps } from './bulk';

function BarButton({ icon: Icon, label, onClick, disabled, reason, destructive }: {
  icon: LucideIcon; label: string; onClick(): void; disabled?: boolean; reason?: string; destructive?: boolean;
}) {
  const button = (
    <Button variant="ghost" size="sm" disabled={disabled} onClick={onClick} aria-label={label}
      className={cn('text-muted-foreground hover:text-foreground', destructive && 'hover:bg-destructive/10 hover:text-destructive')}>
      <Icon /><span className="max-lg:hidden">{label}</span>
    </Button>
  );
  return (
    <Tooltip>
      {/* A disabled button gets no pointer events: the span carries the tooltip. */}
      <TooltipTrigger asChild>{disabled ? <span tabIndex={0}>{button}</span> : button}</TooltipTrigger>
      <TooltipContent>{disabled && reason ? reason : label}</TooltipContent>
    </Tooltip>
  );
}

/** Replaces the topbar actions while two or more items are selected. */
export function SelectionBar({ count, caps, actions, onClear }: { count: number; caps: BulkCaps; actions: BulkActions; onClear(): void }) {
  const { t } = useTranslation();
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5">
      <Button variant="ghost" size="icon-sm" onClick={onClear} aria-label={t('files.selection.clear')} className="text-muted-foreground">
        <X />
      </Button>
      <span className="truncate text-sm font-semibold tabular-nums">{t('files.selection.count', { count })}</span>
      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        <BarButton icon={Download} label={t('files.bulk.download')} onClick={actions.download} />
        <BarButton icon={Copy} label={t('files.bulk.copy')} onClick={actions.copy} />
        <BarButton icon={FolderInput} label={t('files.bulk.move')} onClick={actions.move} disabled={!caps.move} reason={t('files.bulk.cannotMove')} />
        <BarButton icon={Trash2} label={t('common.delete')} onClick={actions.remove} disabled={!caps.delete} reason={t('files.bulk.cannotDelete')} destructive />
      </div>
    </div>
  );
}
