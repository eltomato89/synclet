import { afterEach, describe, expect, it, vi } from 'vitest';
import { canOpenInOffice } from '@/features/files/FileActions';
import { apiScriptUrl, isOfficeFile, loadDocsApi, officePath, openOfficeTab, reserveOfficeTab, resetDocsApiForTests } from './office';

afterEach(() => { resetDocsApiForTests(); vi.restoreAllMocks(); });

describe('office file types', () => {
  it('covers editable and view-only office formats, case-insensitively', () => {
    for (const n of ['a.docx', 'b.XLSX', 'c.pptx', 'd.odt', 'e.ods', 'f.odp', 'g.txt', 'h.csv', 'i.rtf', 'old.doc', 'old.xls', 'old.ppt']) {
      expect(isOfficeFile(n), n).toBe(true);
    }
  });
  it('leaves everything else (and PDF) out', () => {
    for (const n of ['a.pdf', 'b.png', 'c.md', 'docx', '.docx', 'noext', 'archive.docx.zip']) expect(isOfficeFile(n), n).toBe(false);
  });
});

describe('canOpenInOffice', () => {
  const open = { openInOffice: () => {} };
  it('needs office to be available', () => {
    expect(canOpenInOffice({ type: 'file', name: 'a.docx' }, open)).toBe(true);
    expect(canOpenInOffice({ type: 'file', name: 'a.docx' }, {})).toBe(false);
  });
  it('is offered for office files only, never folders', () => {
    expect(canOpenInOffice({ type: 'file', name: 'a.png' }, open)).toBe(false);
    expect(canOpenInOffice({ type: 'folder', name: 'Plan.docx' }, open)).toBe(false);
  });
});

describe('tabs', () => {
  it('opens the editor route in a new tab without opener', () => {
    const spy = vi.spyOn(window, 'open').mockReturnValue(null);
    openOfficeTab('f_1');
    expect(spy).toHaveBeenCalledWith('/office/f_1', '_blank', 'noopener');
    expect(officePath('f_1')).toBe('/office/f_1');
  });
  it('reserves a blank tab and points it at the editor later, or closes it', () => {
    const replace = vi.fn();
    const close = vi.fn();
    const w = { opener: {}, closed: false, location: { replace }, close } as unknown as Window;
    vi.spyOn(window, 'open').mockReturnValue(w);
    const tab = reserveOfficeTab();
    expect(w.opener).toBeNull();
    tab.go('f_9');
    expect(replace).toHaveBeenCalledWith('/office/f_9');
    reserveOfficeTab().cancel();
    expect(close).toHaveBeenCalled();
  });
});

describe('loadDocsApi', () => {
  const src = apiScriptUrl('https://office.example.com/');
  const scripts = () => document.querySelectorAll(`script[src="${src}"]`);

  it('builds the api.js URL', () => {
    expect(src).toBe('https://office.example.com/web-apps/apps/api/documents/api.js');
  });

  it('adds the script once and shares the promise', async () => {
    const a = loadDocsApi(src);
    const b = loadDocsApi(src);
    expect(a).toBe(b);
    expect(scripts()).toHaveLength(1);
    const api = { DocEditor: class {} } as never;
    window.DocsAPI = api;
    scripts()[0].dispatchEvent(new Event('load'));
    await expect(a).resolves.toBe(api);
    await expect(loadDocsApi(src)).resolves.toBe(api);
    expect(scripts()).toHaveLength(1);
  });

  it('forgets a failed load so a retry adds a fresh script', async () => {
    const a = loadDocsApi(src);
    scripts()[0].dispatchEvent(new Event('error'));
    await expect(a).rejects.toThrow(/could not load/);
    expect(scripts()).toHaveLength(0);
    const b = loadDocsApi(src);
    expect(b).not.toBe(a);
    expect(scripts()).toHaveLength(1);
    window.DocsAPI = { DocEditor: class {} } as never;
    scripts()[0].dispatchEvent(new Event('load'));
    await expect(b).resolves.toBeDefined();
  });

  it('fails when the script loads but defines no DocsAPI', async () => {
    const a = loadDocsApi(src);
    scripts()[0].dispatchEvent(new Event('load'));
    await expect(a).rejects.toThrow();
  });
});
