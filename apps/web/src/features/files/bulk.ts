import type { SyncItem, ZipTicketResponse } from '@synclet/shared';
import type { TFunction } from 'i18next';
import { api } from '@/lib/api';

export interface BulkCaps { move: boolean; delete: boolean }
export interface BulkActions { download(): void; copy(): void; move(): void; remove(): void }

/** What every selected item allows (copying and downloading only need read access). */
export function bulkCaps(items: Pick<SyncItem, 'capabilities'>[]): BulkCaps {
  return { move: items.every((i) => i.capabilities.move), delete: items.every((i) => i.capabilities.delete) };
}

/** Indirection for tests: jsdom cannot spy on window.location.assign. */
export const nav = { assign: (url: string) => window.location.assign(url) };

export async function downloadZip(items: Pick<SyncItem, 'id'>[]): Promise<void> {
  const { url } = await api<ZipTicketResponse>('/sync/v1/download-zip', { method: 'POST', json: { itemIds: items.map((i) => i.id) } });
  nav.assign(url);
}

const APPLE = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent);
/** Label for a ⌘/Ctrl shortcut: "⌘C" on Apple devices, else "Ctrl+C" / "Strg+C". */
export function shortcut(t: TFunction, key: string): string {
  return APPLE ? `⌘${key}` : t('files.bulk.ctrl', { key });
}
