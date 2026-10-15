import type { CreateShareInput, ShareLinkWire } from '@synclet/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export const SHARES_KEY = ['shares'] as const;
export const itemSharesKey = (itemId: string) => [...SHARES_KEY, 'item', itemId] as const;

export type SharePatch = Partial<Pick<CreateShareInput, 'password' | 'expiresAt' | 'allowDownload' | 'allowUpload'>>;

/** All active links of the signed-in user, newest first. */
export function useShares() {
  return useQuery({ queryKey: [...SHARES_KEY, 'all'], queryFn: () => api<ShareLinkWire[]>('/shares') });
}

/** Active links of one item. */
export function useItemShares(itemId: string, enabled = true) {
  return useQuery({
    queryKey: itemSharesKey(itemId),
    queryFn: () => api<ShareLinkWire[]>(`/shares?itemId=${encodeURIComponent(itemId)}`),
    enabled,
  });
}

export function useShareMutations() {
  const qc = useQueryClient();
  const settled = () => qc.invalidateQueries({ queryKey: SHARES_KEY });
  return {
    create: useMutation({
      mutationFn: (input: CreateShareInput) => api<ShareLinkWire>('/shares', { method: 'POST', json: input }),
      onSettled: settled,
    }),
    update: useMutation({
      mutationFn: (v: { id: string; patch: SharePatch }) => api<ShareLinkWire>(`/shares/${v.id}`, { method: 'PATCH', json: v.patch }),
      onSettled: settled,
    }),
    rotate: useMutation({
      mutationFn: (id: string) => api<ShareLinkWire>(`/shares/${id}/rotate`, { method: 'POST' }),
      onSettled: settled,
    }),
    revoke: useMutation({
      mutationFn: (id: string) => api<void>(`/shares/${id}`, { method: 'DELETE' }),
      onSettled: settled,
    }),
  };
}

/** The server returns "/s/<token>" unless a public URL is configured: make it absolute for copying. */
export function absoluteUrl(url: string): string {
  if (!url) return '';
  try { return new URL(url, window.location.origin).href; } catch { return url; }
}

export type ShareStatus = 'active' | 'expired' | 'revoked';

export function shareStatus(share: Pick<ShareLinkWire, 'revokedAt' | 'expiresAt'>, now: number = Date.now()): ShareStatus {
  if (share.revokedAt) return 'revoked';
  if (share.expiresAt && new Date(share.expiresAt).getTime() <= now) return 'expired';
  return 'active';
}

/**
 * Copies with the legacy `execCommand('copy')`. The helper textarea goes into the dialog that
 * holds the focus (a modal's focus trap would otherwise pull focus back and nothing gets copied),
 * and the focus returns afterwards. Pass the clicked button as `trigger`: Safari and macOS Firefox
 * don't focus buttons on click, so the active element alone may be the body.
 */
const DIALOG = '[role="dialog"], [role="alertdialog"]';
export function execCopy(text: string, trigger?: HTMLElement | null): boolean {
  const active = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
  const host = trigger?.closest<HTMLElement>(DIALOG) ?? active?.closest<HTMLElement>(DIALOG) ?? document.body;
  const restore = trigger ?? active;
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.setAttribute('aria-hidden', 'true');
  Object.assign(ta.style, { position: 'fixed', top: '0', left: '0', width: '1px', height: '1px', opacity: '0' });
  host.appendChild(ta);
  let ok = false;
  try {
    ta.focus({ preventScroll: true });
    ta.select();
    ta.setSelectionRange(0, text.length);
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  } finally {
    ta.remove();
    restore?.focus({ preventScroll: true });
  }
  return ok;
}

/**
 * Writes text to the clipboard. `navigator.clipboard` only exists in secure contexts (not on
 * plain-http LAN installs) and can reject (permissions, unfocused document), so both paths are
 * tried. Rejects only if neither worked; callers then let the user copy by hand.
 */
export async function copyText(text: string, trigger?: HTMLElement | null): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch { /* fall through to the legacy path */ }
  }
  if (!execCopy(text, trigger)) throw new Error('copy failed');
}
