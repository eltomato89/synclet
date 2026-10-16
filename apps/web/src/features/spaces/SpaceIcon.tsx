import type { SyncSpaceKind } from '@synclet/shared';
import { Folder, HardDrive, Users } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Icon of a space: people for team folders, a drive for external storages, a folder for "My files". */
export function SpaceIcon({ kind, className }: { kind: SyncSpaceKind; className?: string }) {
  const Icon = kind === 'shared' ? Users : kind === 'external' ? HardDrive : Folder;
  return <Icon aria-hidden className={cn('size-4 shrink-0', className)} />;
}
