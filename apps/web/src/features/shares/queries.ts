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

/** Writes a link to the clipboard; falls back to a hidden textarea where the API is missing. */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  if (!ok) throw new Error('copy failed');
}
