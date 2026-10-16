import { Inject, Injectable } from '@nestjs/common';
import { constants } from 'node:fs';
import { mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { APP_CONFIG, AppConfig } from '../config';
import { DerivedStore } from './derived-store';
import { extOf, IMAGE_EXTS, PDF_EXTS, SVG_EXTS, THUMB_EXTS, VIDEO_EXTS } from './preview-kind';
import { heifToJpeg, pdfFirstPage, ToolFailedError, ToolOptions, videoFrame } from './tools';

// The worker decodes one file at a time per slot; libvips' operation cache would only hold memory.
sharp.cache(false);

/** The file cannot be decoded (corrupt, hostile, over the pixel limit): retrying will not help. */
export class BadInputError extends Error {}

/** Thumbnail source: a live file of the job's content hash. */
export interface ThumbSource { abs: string; name: string; size: bigint }

export interface ThumbResult {
  status: 'done' | 'unsupported';
  meta: Record<string, unknown>;
}

const SHARP_INPUT = { limitInputPixels: 100_000_000, sequentialRead: true, failOn: 'error' as const };
const SHARP_TIMEOUT = { seconds: 60 };
const QUALITY = 78;
/** SVGs are parsed from memory (no base path → librsvg resolves no external file references). */
const SVG_MAX_BYTES = 10 * 1024 * 1024;
const RASTER_FORMATS = new Set(['jpeg', 'png', 'webp', 'gif', 'tiff', 'avif', 'heif', 'svg']);
const HEIF_EXTS = new Set(['heic', 'heif']);

const tryOpen = async (abs: string) => open(abs, constants.O_RDONLY | constants.O_NOFOLLOW);

/** Reads at most `max` bytes; throws BadInputError if the file is larger. */
async function readCapped(abs: string, max: number): Promise<Buffer> {
  const fh = await tryOpen(abs);
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size > max) throw new BadInputError(`file too large to rasterize (${st.size} bytes)`);
    const buf = Buffer.alloc(st.size);
    const { bytesRead } = await fh.read(buf, 0, st.size, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** True if the file starts like XML/SVG (libvips would otherwise sniff and render it from the path). */
async function looksLikeXml(abs: string): Promise<boolean> {
  const fh = await tryOpen(abs);
  try {
    const buf = Buffer.alloc(512);
    const { bytesRead } = await fh.read(buf, 0, 512, 0);
    const head = buf.subarray(0, bytesRead).toString('utf8').replace(/^﻿/, '').trimStart();
    return head.startsWith('<');
  } finally {
    await fh.close();
  }
}

@Injectable()
export class Thumbnailer {
  /** Overridable in tests (fake tool binaries, short timeouts). */
  toolOptions: ToolOptions = {};

  constructor(
    private readonly store: DerivedStore,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Writes `thumb-256.webp` and `thumb-1024.webp` (plus `poster.webp` for videos) for `job.sha`.
   * Throws BadInputError for undecodable input and tool errors for tool failures/timeouts.
   */
  async generateThumb(job: { sha: string }, src: ThumbSource): Promise<ThumbResult> {
    const ext = extOf(src.name);
    if (!THUMB_EXTS.includes(ext)) return { status: 'unsupported', meta: { reason: 'type' } };
    const fh = await tryOpen(src.abs);
    const st = await fh.stat().finally(() => fh.close());
    if (!st.isFile()) throw new BadInputError('not a regular file');
    if (st.size > this.config.previewMaxBytes) return { status: 'unsupported', meta: { reason: 'too_large' } };

    const tmpRoot = path.join(this.store.root, '.tmp');
    await mkdir(tmpRoot, { recursive: true });
    const tmpDir = await mkdtemp(path.join(tmpRoot, 'job-'));
    try {
      let input: string | Buffer = src.abs;
      let poster = false;
      if (HEIF_EXTS.has(ext)) {
        input = await this.tool(() => heifToJpeg(src.abs, path.join(tmpDir, 'heif'), this.toolOptions));
      } else if (PDF_EXTS.includes(ext)) {
        input = await this.tool(() => pdfFirstPage(src.abs, path.join(tmpDir, 'page'), this.toolOptions));
      } else if (VIDEO_EXTS.includes(ext)) {
        input = await this.tool(() => videoFrame(src.abs, path.join(tmpDir, 'frame'), this.toolOptions));
        poster = true;
      } else if (SVG_EXTS.includes(ext) || (IMAGE_EXTS.includes(ext) && (await looksLikeXml(src.abs)))) {
        input = await readCapped(src.abs, SVG_MAX_BYTES);
      }
      const meta = await this.render(job.sha, input, poster);
      return { status: 'done', meta };
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }

  /** Tool failures on a given input are permanent; timeouts and a missing binary are not. */
  private async tool<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ToolFailedError) throw new BadInputError(e.message);
      throw e;
    }
  }

  private async render(sha: string, input: string | Buffer, poster: boolean): Promise<Record<string, unknown>> {
    try {
      const info = await sharp(input, SHARP_INPUT).metadata();
      if (!info.format || !RASTER_FORMATS.has(info.format)) throw new BadInputError(`unsupported image format ${info.format ?? 'unknown'}`);
      // An SVG reaching this point from a path (e.g. a video frame never is one) is refused.
      if (info.format === 'svg' && typeof input === 'string') throw new BadInputError('svg must be rasterized from memory');
      const width = info.autoOrient?.width ?? info.width;
      const height = info.autoOrient?.height ?? info.height;
      const large = await sharp(input, SHARP_INPUT).timeout(SHARP_TIMEOUT).rotate()
        .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: QUALITY }).toBuffer();
      const small = await sharp(large, SHARP_INPUT).timeout(SHARP_TIMEOUT)
        .resize({ width: 256, height: 256, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: QUALITY }).toBuffer();
      if (poster) {
        const p = await sharp(input, SHARP_INPUT).timeout(SHARP_TIMEOUT).rotate()
          .resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: QUALITY }).toBuffer();
        await this.store.writeAtomic(this.store.pathFor(sha, 'poster'), p);
      }
      await this.store.writeAtomic(this.store.pathFor(sha, 'thumb', 1024), large);
      await this.store.writeAtomic(this.store.pathFor(sha, 'thumb', 256), small);
      return { sizes: [256, 1024], poster, width, height, format: info.format };
    } catch (e) {
      if (e instanceof BadInputError) throw e;
      // sharp/libvips errors (pixel limit, truncated or corrupt data, timeout) describe the input.
      if (e instanceof Error && !('code' in e)) throw new BadInputError(e.message);
      throw e;
    }
  }
}
