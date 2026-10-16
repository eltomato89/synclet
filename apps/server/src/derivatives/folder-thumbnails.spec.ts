import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { DerivedStore } from './derived-store';
import { composeMosaic, FOLDER_THUMB_DIMS, folderThumbKey, mosaicCells } from './folder-thumbnails';

const area = (cells: { width: number; height: number }[]) => cells.reduce((a, c) => a + c.width * c.height, 0);

describe('mosaicCells', () => {
  it('0 → none, 1 → the whole tile', () => {
    expect(mosaicCells(0, 256, 192, 3)).toEqual([]);
    expect(mosaicCells(1, 256, 192, 3)).toEqual([{ left: 0, top: 0, width: 256, height: 192 }]);
  });

  it('2 → side by side, full height, separated by the gap', () => {
    expect(mosaicCells(2, 256, 192, 3)).toEqual([
      { left: 0, top: 0, width: 126, height: 192 },
      { left: 129, top: 0, width: 127, height: 192 },
    ]);
  });

  it('3 → a large cell on the left, two stacked on the right', () => {
    expect(mosaicCells(3, 256, 192, 3)).toEqual([
      { left: 0, top: 0, width: 126, height: 192 },
      { left: 129, top: 0, width: 127, height: 94 },
      { left: 129, top: 97, width: 127, height: 95 },
    ]);
  });

  it('4 or more → a 2×2 grid covering the tile except the gaps', () => {
    const cells = mosaicCells(4, 1024, 768, 12);
    expect(cells).toHaveLength(4);
    expect(mosaicCells(9, 1024, 768, 12)).toEqual(cells);
    expect(area(cells)).toBe(1024 * 768 - 12 * 768 - 12 * 1024 + 12 * 12);
    for (const c of cells) {
      expect(c.left + c.width).toBeLessThanOrEqual(1024);
      expect(c.top + c.height).toBeLessThanOrEqual(768);
    }
  });
});

describe('folderThumbKey', () => {
  const a = 'a'.repeat(64); const b = 'b'.repeat(64);
  it('is a content hash that depends on the set and the order of the children', () => {
    expect(folderThumbKey([a, b])).toMatch(/^[0-9a-f]{64}$/);
    expect(folderThumbKey([a, b])).toBe(folderThumbKey([a, b]));
    expect(folderThumbKey([a, b])).not.toBe(folderThumbKey([b, a]));
    expect(folderThumbKey([a])).not.toBe(folderThumbKey([a, b]));
  });
});

describe('composeMosaic', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'synclet-mosaic-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const tile = async (name: string, color: { r: number; g: number; b: number }, w = 400, h = 300) => {
    const p = path.join(dir, `${name}.webp`);
    await writeFile(p, await sharp({ create: { width: w, height: h, channels: 3, background: color } }).webp({ lossless: true }).toBuffer());
    return p;
  };
  const pixel = async (img: Buffer, x: number, y: number) => {
    const { data, info } = await sharp(img).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const i = (y * info.width + x) * 4;
    return { r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3] };
  };
  const near = (p: { r: number; g: number; b: number }, c: { r: number; g: number; b: number }) =>
    Math.abs(p.r - c.r) < 40 && Math.abs(p.g - c.g) < 40 && Math.abs(p.b - c.b) < 40;
  const RED = { r: 230, g: 20, b: 20 }; const GREEN = { r: 20, g: 200, b: 20 };
  const BLUE = { r: 20, g: 20, b: 230 }; const YELLOW = { r: 230, g: 220, b: 20 };

  it('a webp of the size of the requested bucket (4:3)', async () => {
    const src = await tile('a', RED, 300, 800); // portrait source: cropped to the cell
    for (const size of [256, 1024] as const) {
      const out = await composeMosaic([src], size);
      const meta = await sharp(out).metadata();
      expect(meta.format).toBe('webp');
      expect({ w: meta.width, h: meta.height }).toEqual({ w: FOLDER_THUMB_DIMS[size].width, h: FOLDER_THUMB_DIMS[size].height });
      expect(near(await pixel(out, 5, 5), RED)).toBe(true);
    }
  });

  it('places the pictures in cell order with transparent gaps', async () => {
    const srcs = [await tile('r', RED), await tile('g', GREEN), await tile('b', BLUE), await tile('y', YELLOW)];
    const four = await composeMosaic(srcs, 256);
    expect(near(await pixel(four, 30, 30), RED)).toBe(true);
    expect(near(await pixel(four, 220, 30), GREEN)).toBe(true);
    expect(near(await pixel(four, 30, 160), BLUE)).toBe(true);
    expect(near(await pixel(four, 220, 160), YELLOW)).toBe(true);
    expect((await pixel(four, 127, 30)).a).toBeLessThan(30); // the vertical gap

    const three = await composeMosaic(srcs.slice(0, 3), 256);
    expect(near(await pixel(three, 30, 30), RED)).toBe(true);
    expect(near(await pixel(three, 30, 160), RED)).toBe(true); // the large left cell
    expect(near(await pixel(three, 220, 30), GREEN)).toBe(true);
    expect(near(await pixel(three, 220, 160), BLUE)).toBe(true);

    const two = await composeMosaic(srcs.slice(0, 2), 256);
    expect(near(await pixel(two, 30, 160), RED)).toBe(true);
    expect(near(await pixel(two, 220, 160), GREEN)).toBe(true);
  });
});

describe('DerivedStore folder thumbnails', () => {
  let meta: string; let store: DerivedStore;
  beforeEach(async () => { meta = await mkdtemp(path.join(os.tmpdir(), 'synclet-derived-')); store = new DerivedStore(meta); });
  afterEach(async () => { await rm(meta, { recursive: true, force: true }); });

  it('paths below <derived>/folders, keyed by a hex key and the size', () => {
    const key = 'ab'.repeat(32);
    expect(store.folderThumbPath(key, 256)).toBe(path.join(meta, 'derived', 'folders', 'ab', `${key}-256.webp`));
    expect(() => store.folderThumbPath('../x', 256)).toThrow();
    expect(() => store.folderThumbPath(key, 512 as 256)).toThrow();
  });

  it('gcFolderThumbs removes mosaics older than the TTL, keeps fresh ones; the content GC ignores them', async () => {
    const oldKey = '0a'.repeat(32); const freshKey = '0b'.repeat(32);
    const old = store.folderThumbPath(oldKey, 256); const fresh = store.folderThumbPath(freshKey, 1024);
    await store.writeAtomic(old, Buffer.from('x'));
    await store.writeAtomic(fresh, Buffer.from('y'));
    const tmp = path.join(path.dirname(old), '.tmp-abc');
    await mkdir(path.dirname(tmp), { recursive: true });
    await writeFile(tmp, 'partial');
    const longAgo = new Date(Date.now() - 40 * 24 * 3600_000);
    await utimes(old, longAgo, longAgo);
    await utimes(tmp, longAgo, longAgo);

    expect(await store.gc(async () => new Set())).toBe(0); // not a <sha> dir
    expect(await store.has(old)).toBe(true);
    expect(await store.gcFolderThumbs(30 * 24 * 3600_000)).toBe(2);
    expect(await store.has(old)).toBe(false);
    expect(await store.has(tmp)).toBe(false);
    expect(await store.has(fresh)).toBe(true);
  });
});
