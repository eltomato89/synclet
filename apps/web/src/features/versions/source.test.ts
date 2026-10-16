import type { SyncItem, VersionWire } from '@synclet/shared';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as tokens from '@/features/preview/preview-url';
import { decode, MAX_PDF_BYTES, MAX_TEXT_BYTES, trimIncompleteUtf8, versionPreviewSource } from './source';

const item = (name: string, kind: string) => ({ id: 'f_1', etag: 'e', name, mime: null, size: 1, preview: { kind, thumbnail: true } }) as unknown as SyncItem;
const ver = (size: number) => ({ id: 'v1', version: 1, size }) as VersionWire;

beforeEach(() => { vi.spyOn(tokens, 'previewToken').mockResolvedValue({ token: 'tok', contentUrl: '/x' }); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('trims only an incomplete trailing UTF-8 sequence', () => {
  const euro = new TextEncoder().encode('a€'); // 61 e2 82 ac
  expect(trimIncompleteUtf8(euro.subarray(0, 2))).toHaveLength(1);
  expect(trimIncompleteUtf8(euro.subarray(0, 3))).toHaveLength(1);
  expect(trimIncompleteUtf8(euro)).toHaveLength(4);
  expect(trimIncompleteUtf8(new TextEncoder().encode('abc'))).toHaveLength(3);
});

it('decodes a cut-off UTF-8 text as UTF-8, genuine latin1 as latin1', () => {
  const euro = new TextEncoder().encode('a€');
  const cut = euro.slice(0, 3).buffer;
  expect(decode(cut, true)).toEqual({ text: 'a', encoding: 'utf-8' });
  expect(decode(Uint8Array.of(0x63, 0x61, 0x66, 0xe9).buffer, false)).toEqual({ text: 'café', encoding: 'latin1' });
});

it('text preview requests a range and survives a split character', async () => {
  const bytes = new Uint8Array(MAX_TEXT_BYTES + 10).fill(0x61);
  bytes.set([0xe2, 0x82], MAX_TEXT_BYTES - 2); // lead + 1 continuation cut at the cap
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => bytes.buffer });
  vi.stubGlobal('fetch', fetchMock);
  const src = await versionPreviewSource(item('a.txt', 'text'), ver(MAX_TEXT_BYTES + 10));
  const out = await src.loadText!(new AbortController().signal);
  expect(fetchMock.mock.calls[0][0]).toBe('/api/sync/v1/items/f_1/versions/v1/content?dt=tok');
  expect(fetchMock.mock.calls[0][1].headers.Range).toBe(`bytes=0-${MAX_TEXT_BYTES - 1}`);
  expect(out.encoding).toBe('utf-8');
  expect(out.truncated).toBe(true);
  expect(out.text).toBe('a'.repeat(MAX_TEXT_BYTES - 2));
});

it('PDFs are framed from a blob URL, and big ones are not previewed', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) }));
  const create = vi.fn().mockReturnValue('blob:pdf');
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() }));
  const src = await versionPreviewSource(item('a.pdf', 'pdf'), ver(4));
  expect(src.kind).toBe('pdf');
  expect(src.contentUrl).toBe('blob:pdf');
  expect((create.mock.calls[0][0] as Blob).type).toBe('application/pdf');
  expect((await versionPreviewSource(item('a.pdf', 'pdf'), ver(MAX_PDF_BYTES + 1))).kind).toBe('none');
});

it('only raster images are shown from the content URL', async () => {
  const png = await versionPreviewSource(item('a.png', 'image'), ver(1));
  expect(png).toMatchObject({ kind: 'image', rasterSafe: true, contentUrl: '/api/sync/v1/items/f_1/versions/v1/content?dt=tok' });
  expect(png.thumbnailUrl(256)).toBeNull();
  for (const name of ['a.svg', 'a.heic']) {
    expect((await versionPreviewSource(item(name, 'image'), ver(1))).kind).toBe('none');
  }
});
