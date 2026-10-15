import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { itIfTool } from '../../test/tools';
import { AppConfig, loadConfig } from '../config';
import { DerivedStore } from './derived-store';
import { BadInputError, Thumbnailer } from './thumbnails';

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures');
const SHA = 'ab'.repeat(32);

describe('Thumbnailer', () => {
  let meta: string; let data: string; let store: DerivedStore; let thumbs: Thumbnailer; let config: AppConfig;
  beforeEach(async () => {
    meta = await mkdtemp(path.join(os.tmpdir(), 'synclet-thumb-meta-'));
    data = await mkdtemp(path.join(os.tmpdir(), 'synclet-thumb-data-'));
    config = { ...loadConfig({}), dataRoot: data, metaRoot: meta };
    store = new DerivedStore(meta);
    thumbs = new Thumbnailer(store, config);
  });
  afterEach(async () => {
    await rm(meta, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  });

  /** Copies a fixture (optionally under another name) into the data dir and thumbnails it. */
  const run = async (fixture: string, name = fixture) => {
    const abs = path.join(data, name);
    await copyFile(path.join(FIXTURES, fixture), abs);
    return thumbs.generateThumb({ sha: SHA }, { abs, name, size: 0n });
  };
  const meta256 = () => sharp(store.pathFor(SHA, 'thumb', 256)).metadata();
  const meta1024 = () => sharp(store.pathFor(SHA, 'thumb', 1024)).metadata();
  const noTempLeft = async () => expect(await readdir(path.join(store.root, '.tmp')).catch(() => [])).toEqual([]);

  it('jpg: honors the EXIF orientation and writes both webp sizes', async () => {
    const r = await run('rotated.jpg');
    expect(r).toMatchObject({ status: 'done', meta: { sizes: [256, 1024], poster: false, width: 32, height: 64 } });
    const m = await meta1024();
    expect(m.format).toBe('webp');
    expect([m.width, m.height]).toEqual([32, 64]); // portrait after rotation, not enlarged
    expect(m.orientation).toBeUndefined(); // metadata stripped
    // Red half (left in the stored pixels) ends up on top after a 90° CW rotation.
    const { data: px, info } = await sharp(store.pathFor(SHA, 'thumb', 1024)).raw().toBuffer({ resolveWithObject: true });
    const at = (x: number, y: number) => [...px.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)];
    expect(at(16, 5)[0]).toBeGreaterThan(200);
    expect(at(16, 58)[2]).toBeGreaterThan(200);
    expect((await meta256()).format).toBe('webp');
    expect(await store.has(store.pathFor(SHA, 'poster'))).toBe(false);
    await noTempLeft();
  });

  it('png', async () => {
    expect((await run('sample.png')).status).toBe('done');
    expect([(await meta256()).width, (await meta256()).height]).toEqual([80, 60]);
  });

  it('downscales large images to 1024 and 256 on the longest edge', async () => {
    await sharp({ create: { width: 3000, height: 1500, channels: 3, background: '#888' } }).jpeg().toFile(path.join(data, 'big.jpg'));
    await thumbs.generateThumb({ sha: SHA }, { abs: path.join(data, 'big.jpg'), name: 'big.jpg', size: 0n });
    expect([(await meta1024()).width, (await meta1024()).height]).toEqual([1024, 512]);
    expect([(await meta256()).width, (await meta256()).height]).toEqual([256, 128]);
  });

  it('svg with <script>: rasterized to webp, no script anywhere in the output', async () => {
    const r = await run('script.svg');
    expect(r.status).toBe('done');
    for (const size of [256, 1024] as const) {
      const buf = await readFile(store.pathFor(SHA, 'thumb', size));
      expect(buf.subarray(0, 4).toString()).toBe('RIFF');
      expect(buf.subarray(8, 12).toString()).toBe('WEBP');
      const text = buf.toString('latin1').toLowerCase();
      for (const needle of ['<script', 'alert', 'javascript:', '<svg', 'onload']) expect(text).not.toContain(needle);
    }
  });

  it('an SVG disguised as .png is still rasterized from memory', async () => {
    const r = await run('script.svg', 'disguised.png');
    expect(r).toMatchObject({ status: 'done', meta: { format: 'svg' } });
  });

  itIfTool('heif-convert', 'heic via heif-convert', async () => {
    const r = await run('sample.heic');
    expect(r.status).toBe('done');
    expect([(await meta1024()).width, (await meta1024()).height]).toEqual([80, 60]);
    await noTempLeft();
  });

  itIfTool('pdftoppm', 'pdf: first page', async () => {
    const r = await run('sample.pdf');
    expect(r.status).toBe('done');
    const m = await meta1024();
    expect(m.format).toBe('webp');
    expect(m.width).toBeGreaterThan(m.height!); // 200x100 pt page
    await noTempLeft();
  });

  itIfTool(['ffmpeg', 'ffprobe'], 'mp4: poster frame and thumbnails', async () => {
    const r = await run('sample.mp4');
    expect(r).toMatchObject({ status: 'done', meta: { poster: true } });
    const poster = await sharp(store.pathFor(SHA, 'poster')).metadata();
    expect([poster.format, poster.width, poster.height]).toEqual(['webp', 96, 64]);
    expect((await meta256()).format).toBe('webp');
    await noTempLeft();
  });

  itIfTool(['ffmpeg', 'ffprobe'], 'a playlist disguised as .mp4 is refused (no HLS/concat demuxers)', async () => {
    const abs = path.join(data, 'evil.mp4');
    await writeFile(abs, '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:1.0,\n/etc/hosts\n#EXT-X-ENDLIST\n');
    await expect(thumbs.generateThumb({ sha: SHA }, { abs, name: 'evil.mp4', size: 0n })).rejects.toBeInstanceOf(BadInputError);
    await noTempLeft();
  });

  it('mp3 and other types → unsupported, nothing written', async () => {
    expect((await run('sample.mp3')).status).toBe('unsupported');
    expect((await run('sample.txt')).status).toBe('unsupported');
    expect(await store.has(store.pathFor(SHA, 'thumb', 256))).toBe(false);
  });

  it('decompression bomb → BadInputError before decoding', async () => {
    // 12000 x 12000 = 144 MP > 100 MP limit; a 1-bit palette PNG of that size is only a few KB.
    const abs = path.join(data, 'bomb.png');
    await sharp({ create: { width: 12000, height: 12000, channels: 3, background: '#000' }, limitInputPixels: false })
      .png({ palette: true, colours: 2, compressionLevel: 9 }).toFile(abs);
    await expect(thumbs.generateThumb({ sha: SHA }, { abs, name: 'bomb.png', size: 0n })).rejects.toThrow(/pixel limit/i);
    await noTempLeft();
  }, 60_000);

  it('an SVG declaring a huge canvas hits the pixel limit', async () => {
    const abs = path.join(data, 'huge.svg');
    await writeFile(abs, '<svg xmlns="http://www.w3.org/2000/svg" width="50000" height="50000"><rect width="10" height="10"/></svg>');
    await expect(thumbs.generateThumb({ sha: SHA }, { abs, name: 'huge.svg', size: 0n })).rejects.toThrow(/pixel limit/i);
  });

  it('corrupt image → BadInputError', async () => {
    const abs = path.join(data, 'broken.jpg');
    await writeFile(abs, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 7)]));
    await expect(thumbs.generateThumb({ sha: SHA }, { abs, name: 'broken.jpg', size: 0n })).rejects.toBeInstanceOf(BadInputError);
  });

  it('files above previewMaxBytes are refused', async () => {
    thumbs = new Thumbnailer(store, { ...config, previewMaxBytes: 100 });
    expect(await run('sample.png')).toMatchObject({ status: 'unsupported', meta: { reason: 'too_large' } }); // 297 bytes
  });
});
