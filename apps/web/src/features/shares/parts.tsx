import type { ShareLinkWire } from '@synclet/shared';
import { ArrowDownToLine, LockKeyhole, Upload } from 'lucide-react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Badge } from '@/components/ui/badge';
import { errorKey } from '@/features/files/errors';
import { ApiError } from '@/lib/api';
import { absoluteUrl, copyText, shareStatus, useShareMutations } from './queries';

export const notify = {
  success: (msg: string, description?: string) => toast.success(msg, { position: 'bottom-center', description }),
  error: (msg: string) => toast.error(msg, { position: 'bottom-center' }),
};

/** i18n key for a failed share request. */
export function shareErrorKey(err: unknown): string {
  if (err instanceof ApiError && err.code === 'invalid_request') return 'shares.errors.invalid';
  if (err instanceof ApiError && err.code === 'not_found') return 'shares.errors.not_found';
  return errorKey(err);
}

/** Host and a shortened token: enough to tell links apart without a wall of base64. */
export function displayUrl(url: string): string {
  const abs = absoluteUrl(url);
  try {
    const u = new URL(abs);
    const token = u.pathname.split('/').pop() ?? '';
    const short = token.length > 14 ? `${token.slice(0, 10)}…` : token;
    return `${u.host}${u.pathname.slice(0, u.pathname.length - token.length)}${short}`;
  } catch { return abs; }
}

export function formatDay(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(iso));
}

/** "No expiry" / "Until 12 Oct 2026" / "Expired on 3 Oct 2026". */
export function expiryText(share: Pick<ShareLinkWire, 'expiresAt' | 'revokedAt'>, t: TFunction, locale: string): string {
  if (!share.expiresAt) return t('shares.expiry.never');
  const date = formatDay(share.expiresAt, locale);
  return shareStatus(share) === 'expired' ? t('shares.expiry.expiredOn', { date }) : t('shares.expiry.until', { date });
}

/** Small markers for settings that change what a recipient sees: password, upload, no download. */
export function ShareBadges({ share }: { share: ShareLinkWire }) {
  const { t } = useTranslation();
  const cls = 'h-4.5 gap-1 px-1.5 text-[11px] font-medium text-muted-foreground';
  return (
    <>
      {share.hasPassword && <Badge variant="outline" className={cls}><LockKeyhole />{t('shares.badges.password')}</Badge>}
      {share.allowUpload && <Badge variant="outline" className={cls}><Upload />{t('shares.badges.upload')}</Badge>}
      {!share.allowDownload && <Badge variant="outline" className={cls}><ArrowDownToLine />{t('shares.badges.noDownload')}</Badge>}
    </>
  );
}

export function useCopyLink() {
  const { t } = useTranslation();
  return (share: Pick<ShareLinkWire, 'url'>) => {
    // A link whose token can't be decrypted (server secret changed) needs a new link first.
    if (!share.url) { notify.error(t('shares.errors.noUrl')); return; }
    copyText(absoluteUrl(share.url)).then(
      () => notify.success(t('shares.toast.copied')),
      () => notify.error(t('shares.errors.copy')),
    );
  };
}

export type ShareConfirmAction = { kind: 'rotate' | 'revoke'; share: ShareLinkWire };

/** Confirmation for "new link" (the old URL stops working) and "revoke". */
export function ShareConfirm({ action, open, onOpenChange, onRotated }: {
  action: ShareConfirmAction | null;
  open: boolean;
  onOpenChange(open: boolean): void;
  onRotated?(share: ShareLinkWire): void;
}) {
  const { t } = useTranslation();
  const m = useShareMutations();
  if (!action) return null;
  const name = action.share.itemName;
  const rotate = action.kind === 'rotate';
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={rotate ? t('shares.rotate.title') : t('shares.revoke.title')}
      body={rotate ? t('shares.rotate.body', { name }) : t('shares.revoke.body', { name })}
      confirmLabel={rotate ? t('shares.rotate.submit') : t('shares.revoke.submit')}
      pendingLabel={rotate ? t('shares.rotate.submitting') : t('shares.revoke.submitting')}
      destructive={!rotate}
      errorMessage={(err) => t(shareErrorKey(err))}
      onConfirm={async () => {
        if (rotate) {
          const updated = await m.rotate.mutateAsync(action.share.id);
          if (onRotated) onRotated(updated);
          else notify.success(t('shares.toast.rotated'));
        } else {
          await m.revoke.mutateAsync(action.share.id);
          notify.success(t('shares.toast.revoked'));
        }
      }}
    />
  );
}
