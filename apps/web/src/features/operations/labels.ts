import type { SyncOperation } from '@synclet/shared';
import type { TFunction } from 'i18next';

export function targetLabel(t: TFunction, op: Pick<SyncOperation, 'targetId' | 'targetName'>): string {
  return op.targetName ?? (op.targetId === 'root' ? t('operations.myFiles') : '');
}

export function operationTitle(t: TFunction, op: SyncOperation): string {
  return t(`operations.title.${op.kind}`, { count: op.itemCount, target: targetLabel(t, op) });
}
