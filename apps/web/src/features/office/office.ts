import type { OfficeNewFormat } from '@synclet/shared';

// Client-side mirror of the server's office file types (apps/server/src/office/office.service.ts).
// The server stays authoritative (415 for anything else).

/** Edited in place by the Document Server. */
const EDITABLE = new Set([
  'docx', 'docm', 'dotx', 'odt', 'ott', 'rtf', 'txt',
  'xlsx', 'xlsm', 'xltx', 'ods', 'ots', 'csv',
  'pptx', 'pptm', 'potx', 'odp', 'otp',
]);
/** Opened view-only (legacy binary formats). PDF is left to QuickLook, which shows it better. */
const VIEW_ONLY = new Set(['doc', 'dot', 'xls', 'ppt']);

export function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** Whether "Open in Office" is offered for a file of this name. */
export function isOfficeFile(name: string): boolean {
  const ext = extOf(name);
  return EDITABLE.has(ext) || VIEW_ONLY.has(ext);
}

/** The formats the "New" menu offers directly; the rest sit under "More". */
export const PRIMARY_FORMATS = ['docx', 'xlsx', 'pptx'] as const satisfies readonly OfficeNewFormat[];
export const MORE_FORMATS = ['odt', 'ods', 'odp', 'txt', 'csv'] as const satisfies readonly OfficeNewFormat[];

/** Route of the full-screen editor for a file. */
export function officePath(itemId: string): string {
  return `/office/${encodeURIComponent(itemId)}`;
}

/** Opens the editor for a file in a new tab. */
export function openOfficeTab(itemId: string): void {
  window.open(officePath(itemId), '_blank', 'noopener');
}

/**
 * For a file that does not exist yet: opens a blank tab now (inside the click, so popup blockers
 * let it through) and returns a handle that later points it at the editor or closes it again.
 */
export function reserveOfficeTab(): { go(itemId: string): void; cancel(): void } {
  const w = window.open('', '_blank');
  if (w) w.opener = null;
  return {
    go: (itemId) => {
      if (w && !w.closed) w.location.replace(officePath(itemId));
      else openOfficeTab(itemId);
    },
    cancel: () => { w?.close(); },
  };
}

// ---- Document Server api.js -------------------------------------------------------------------

export interface DocEditor { destroyEditor?(): void }
export interface DocsApi { DocEditor: new (placeholderId: string, config: unknown) => DocEditor }

declare global {
  interface Window { DocsAPI?: DocsApi }
}

export function apiScriptUrl(documentServerUrl: string): string {
  return `${documentServerUrl.replace(/\/+$/, '')}/web-apps/apps/api/documents/api.js`;
}

const loads = new Map<string, Promise<DocsApi>>();

/**
 * Loads the Document Server's api.js once per URL. Concurrent and later calls share the same
 * promise; a failed load is forgotten (and its script tag removed) so a retry starts afresh.
 */
export function loadDocsApi(src: string): Promise<DocsApi> {
  const cached = loads.get(src);
  if (cached) return cached;
  const p = new Promise<DocsApi>((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.async = true;
    el.dataset.officeApi = '';
    el.onload = () => {
      if (window.DocsAPI) resolve(window.DocsAPI);
      else fail();
    };
    el.onerror = () => fail();
    function fail() {
      el.remove();
      loads.delete(src);
      reject(new Error(`could not load ${src}`));
    }
    document.head.appendChild(el);
  });
  loads.set(src, p);
  return p;
}

/** Test hook: forget loaded scripts. */
export function resetDocsApiForTests(): void {
  loads.clear();
  document.querySelectorAll('script[data-office-api]').forEach((el) => el.remove());
  delete window.DocsAPI;
}
