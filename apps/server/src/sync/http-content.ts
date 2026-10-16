import type { Item } from '@prisma/client';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { PassThrough, Readable } from 'node:stream';
import { SyncError } from '../common/sync-error';
import { parseRange } from './range';
import { mimeFor } from './serializer.service';

export type HeaderMap = Record<string, string | string[] | undefined>;

export const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
export const unquote = (v: string | undefined) => v?.trim().replace(/^W\//, '').replace(/^"(.*)"$/, '$1');
/** Entity tags of an If-None-Match / If-Match list, unquoted. */
export const etagList = (v: string | string[] | undefined) => (first(v) ?? '').split(',').map((t) => unquote(t) ?? '').filter(Boolean);

/** RFC 5987 encoding (encodeURIComponent leaves `'()*!` alone, which are not attr-chars). */
const rfc5987 = (s: string) => encodeURIComponent(s).replace(/['()*!]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const asciiFallback = (s: string) => s.replace(/[^\x20-\x7e]|["\\]/g, '_');

/** `Content-Disposition: attachment` with an ASCII fallback and the UTF-8 name. */
export function attachmentDisposition(name: string): string {
  return `attachment; filename="${asciiFallback(name)}"; filename*=UTF-8''${rfc5987(name)}`;
}

/** User content must never run as script on the app origin (HTML/SVG uploads). PDFs stay viewable inline. */
export const SANDBOX_CSP = "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox";

/**
 * Opens a resolved file for reading. O_NOFOLLOW: a symlink swapped in after the realpath check is
 * never followed. Anything that is not a regular file is reported as not found.
 */
export async function openNoFollow(abs: string): Promise<FileHandle> {
  const fh = await open(abs, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => { throw new SyncError('not_found'); });
  try {
    if (!(await fh.stat()).isFile()) throw new SyncError('not_found');
  } catch (e) {
    await fh.close();
    throw e;
  }
  return fh;
}

/**
 * Streams the file at `abs` (already resolved and scope-checked by the caller) for indexed `item`
 * with Range, ETag, If-None-Match and If-Range support and the sandbox headers for user content.
 */
export async function sendFile(req: FastifyRequest, reply: FastifyReply, item: Item, abs: string, opts: { download: boolean }) {
  const fh = await openNoFollow(abs);
  let handedOver = false;
  try {
    // Size and dates come from the opened file, so Content-Length always matches the bytes sent
    // (the file may have been edited on the host and not be indexed yet).
    const st = await fh.stat({ bigint: true });
    const size = Number(st.size);
    const mtime = new Date(Number(st.mtimeMs)); // same derivation as the indexer (statEntry)
    const tag = `v${item.version}`;
    reply.header('Cache-Control', 'private, no-store').header('ETag', `"${tag}"`).header('Accept-Ranges', 'bytes').header('Last-Modified', mtime.toUTCString());
    // URLs may carry a `dt` token: never pass them on (e.g. links clicked inside a PDF).
    reply.header('Referrer-Policy', 'no-referrer');
    const inm = etagList(req.headers['if-none-match']);
    if (inm.includes(tag) || inm.includes('*')) return reply.status(304).send();
    // If-Range: resume only if the client's validator still describes these bytes; otherwise
    // send the full file (200) so a resumed download never splices bytes of a changed file.
    // The version tag only counts while the file on disk still matches the indexed row (a host
    // edit that is not indexed yet keeps the old version number).
    const onDiskMatchesRow = st.size === item.size && mtime.getTime() === item.mtime.getTime() &&
      (item.ino === null || (st.ino === item.ino && st.dev === item.dev));
    const ifRange = first(req.headers['if-range'])?.trim();
    const rangeAllowed = !ifRange || (/^(W\/)?"/.test(ifRange)
      ? !ifRange.startsWith('W/') && unquote(ifRange) === tag && onDiskMatchesRow
      : ifRange === mtime.toUTCString());
    const range = rangeAllowed ? parseRange(first(req.headers.range), size) : null;
    if (range === 'invalid') {
      return reply.status(416).header('Content-Range', `bytes */${size}`).type('application/json')
        .send({ statusCode: 416, message: 'range not satisfiable', code: 'range_not_satisfiable' });
    }
    const mime = mimeFor(item.name);
    reply.header('Content-Type', mime).header('X-Content-Type-Options', 'nosniff');
    if (mime !== 'application/pdf') reply.header('Content-Security-Policy', SANDBOX_CSP);
    if (opts.download) reply.header('Content-Disposition', attachmentDisposition(item.name));
    handedOver = true;
    if (range) {
      reply.status(206).header('Content-Range', `bytes ${range.start}-${range.end}/${size}`).header('Content-Length', range.end - range.start + 1);
      return reply.send(fh.createReadStream({ start: range.start, end: range.end }));
    }
    reply.header('Content-Length', size);
    return reply.send(fh.createReadStream());
  } finally {
    if (!handedOver) await fh.close();
  }
}

/**
 * Raw request body as a stream. The octet-stream parser hands us the request stream; an
 * empty body never reaches the parser. Anything else (JSON, text) would be silently lost.
 */
export function rawBody(body: unknown, headers: HeaderMap, maxUploadBytes: number): Readable {
  const length = first(headers['content-length']);
  if (length !== undefined && Number(length) > maxUploadBytes) throw new SyncError('too_large');
  if (body instanceof Readable) return body;
  const hasBody = (length !== undefined && Number(length) > 0) || headers['transfer-encoding'] !== undefined;
  if ((body !== undefined && body !== null) || hasBody) {
    throw new SyncError('invalid_request', 'body must be sent as application/octet-stream');
  }
  const empty = new PassThrough();
  empty.end();
  return empty;
}
