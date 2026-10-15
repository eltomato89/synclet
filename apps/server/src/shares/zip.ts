import type { Archiver, ArchiverOptions } from 'archiver';
import type { Readable } from 'node:stream';

// archiver@7 (installed) exports a factory function; @types/archiver@8 describes the class-based
// v8 API, so the factory is typed here by hand.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const archiver = require('archiver') as (format: 'zip', options: ArchiverOptions) => Archiver;

/**
 * Entry name for a '/'-separated relative path: backslashes (a path separator for some Windows
 * extractors, so `..\..\x.bat` would escape the target folder) and control characters become `_`.
 */
export function zipEntryName(rel: string): string {
  // eslint-disable-next-line no-control-regex
  return rel.split('/').map((seg) => seg.replace(/[\\\u0000-\u001f\u007f]/g, '_')).join('/');
}

export interface ZipEntrySource {
  /** Path inside the archive, '/'-separated, no leading slash. */
  name: string;
  type: 'folder' | 'file';
  mtime: Date;
  /** Opens the file content (files only); null = skip the entry (e.g. vanished or unsafe on disk). */
  open?: () => Promise<Readable | null>;
}

export interface ZipStream {
  /** The archive bytes (application/zip). */
  stream: Readable;
  /** Stops producing: kills the archive and destroys the file stream being read. Idempotent. */
  abort(): void;
}

/**
 * Streams a ZIP of `entries` in order. Files are opened one at a time, only when the previous
 * entry has been fully written, so at most one file descriptor is open and memory stays bounded
 * by the consumer's backpressure. archiver switches to ZIP64 on its own for large archives.
 */
export function createZip(entries: Iterable<ZipEntrySource>, log: { warn(msg: string): void }): ZipStream {
  const archive = archiver('zip', { zlib: { level: 1 }, store: false });
  let current: Readable | null = null;
  let stopped = false;
  const abort = () => {
    if (stopped) return;
    stopped = true;
    current?.destroy();
    current = null;
    archive.abort();
  };
  archive.on('warning', (e: Error) => log.warn(`zip warning: ${e.message}`));
  // An archive error (e.g. a read error mid-file) ends the download; the client sees a truncated zip.
  archive.on('error', (e: Error) => {
    log.warn(`zip aborted: ${e.message}`);
    abort();
    archive.destroy(e);
  });

  /** Resolves when archiver has written the entry just appended (or the archive stopped). */
  const written = () => new Promise<void>((resolve) => {
    const done = () => {
      archive.off('entry', done);
      archive.off('close', done);
      archive.off('error', done);
      resolve();
    };
    archive.on('entry', done);
    archive.on('close', done);
    archive.on('error', done);
  });

  void (async () => {
    try {
      for (const e of entries) {
        if (stopped) return;
        if (e.type === 'folder') {
          const w = written();
          archive.append(Buffer.alloc(0), { name: `${e.name}/`, date: e.mtime, type: 'directory' });
          await w;
          continue;
        }
        const src = await e.open?.().catch((err: Error) => {
          log.warn(`zip: skipping ${e.name}: ${err.message}`);
          return null;
        });
        if (!src) continue;
        if (stopped) {
          src.destroy();
          return;
        }
        current = src;
        const w = written();
        archive.append(src, { name: e.name, date: e.mtime });
        await w;
        current = null;
      }
      // Not awaited: the promise settles only when the consumer has read everything.
      if (!stopped) archive.finalize().catch(() => undefined);
    } catch (err) {
      log.warn(`zip failed: ${(err as Error).message}`);
      abort();
      archive.destroy(err as Error);
    }
  })();

  return { stream: archive, abort };
}
