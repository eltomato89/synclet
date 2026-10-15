import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { CODE_EXTS, extOf, MARKDOWN_EXTS, OFFICE_EXTS, PDF_EXTS, TEXT_EXTS } from './preview-kind';
import { pdfText, ToolOptions, unzipMembers } from './tools';

/** Extracted text is stored (and indexed) up to this many UTF-8 bytes. */
export const MAX_TEXT_BYTES = 1024 * 1024;
/** Tool output cap: PDF text with layout padding and office XML are much larger than the text in them. */
const PDF_MAX_OUTPUT = 8 * 1024 * 1024;
const ZIP_MAX_OUTPUT = 32 * 1024 * 1024;

const PLAIN_EXTS = new Set([...TEXT_EXTS, ...MARKDOWN_EXTS, ...CODE_EXTS]);

/** Zip members holding the document text, per office format (unzip wildcard patterns). */
const OFFICE_MEMBERS: Record<string, string[]> = {
  docx: ['word/document.xml'],
  xlsx: ['xl/sharedStrings.xml'],
  pptx: ['ppt/slides/slide*.xml'],
  odt: ['content.xml'], ods: ['content.xml'], odp: ['content.xml'],
};

export type TextEncodingName = 'utf-8' | 'latin1';

/**
 * Decodes bytes as UTF-8, or as latin1 if more than 1 % of the decoded characters are invalid
 * UTF-8. A multi-byte sequence cut off at the end of `buf` (a read prefix) is dropped, not
 * counted as invalid. A UTF-8 BOM is removed.
 */
export function decodeText(buf: Buffer): { text: string; encoding: TextEncodingName } {
  const utf8 = new TextDecoder('utf-8').decode(buf, { stream: true });
  let bad = 0;
  for (let i = utf8.indexOf('�'); i >= 0; i = utf8.indexOf('�', i + 1)) bad++;
  if (bad > 0 && bad > utf8.length * 0.01) return { text: buf.toString('latin1'), encoding: 'latin1' };
  return { text: utf8, encoding: 'utf-8' };
}

/**
 * Heuristic for "this is not text": more than 5 % control characters (other than tab, line
 * breaks, form feed and escape) in the first 8 KiB. Text in any 8-bit encoding has almost none.
 */
export function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  if (!n) return false;
  let ctrl = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if ((b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0x0c && b !== 0x1b) || b === 0x7f) ctrl++;
  }
  return ctrl > n * 0.05;
}

/** `text` cut to at most `maxBytes` UTF-8 bytes, on a character boundary. */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (text.length <= maxBytes / 3 || Buffer.byteLength(text) <= maxBytes) return text;
  const { read } = new TextEncoder().encodeInto(text, new Uint8Array(maxBytes));
  return text.slice(0, read);
}

/** Reads at most `max` bytes from the start of a regular file (symlinks are never followed). */
export async function readPrefix(abs: string, max: number): Promise<{ buf: Buffer; size: number }> {
  const fh = await open(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new Error('not a regular file');
    const buf = Buffer.alloc(Math.min(st.size, max));
    let off = 0;
    while (off < buf.length) {
      const { bytesRead } = await fh.read(buf, off, buf.length - off, off);
      if (!bytesRead) break;
      off += bytesRead;
    }
    return { buf: buf.subarray(0, off), size: st.size };
  } finally {
    await fh.close();
  }
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** Decodes the predefined XML entities and numeric character references. */
export function decodeXmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, ent: string) => {
    if (ent[0] === '#') {
      const cp = ent[1] === 'x' || ent[1] === 'X' ? Number.parseInt(ent.slice(2), 16) : Number.parseInt(ent.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : ' ';
    }
    return ENTITIES[ent] ?? m;
  });
}

/**
 * Element names (local part) that separate words: paragraphs, headings, breaks, tabs, table cells,
 * shared strings, slide shapes. All other tags are dropped without a separator, because Word,
 * PowerPoint and LibreOffice split a single word into several runs (`<w:r>`, `<a:r>`,
 * `<text:span>`) whenever formatting, spell-check or revision ids change inside it.
 */
const SEPARATING_TAGS = new Set(['p', 'h', 'br', 'cr', 'tab', 's', 'line-break', 'si', 'tc', 'table-cell', 'list-item', 'sp', 'row', 'tr', 'frame']);

/** Plain text of office XML: tags removed, entities decoded, whitespace collapsed. */
export function xmlToText(xml: string): string {
  const stripped = xml.replace(/<[^>]+>/g, (tag) => {
    const m = /^<\/?(?:[\w.-]+:)?([\w.-]+)/.exec(tag);
    return m && SEPARATING_TAGS.has(m[1]) ? ' ' : '';
  });
  return decodeXmlEntities(stripped).replace(/\s+/g, ' ').trim();
}

function finish(text: string): string | null {
  // Postgres text cannot hold NUL characters.
  const clean = truncateUtf8(text.replace(/\u0000/g, ''), MAX_TEXT_BYTES);
  return clean.trim() ? clean : null;
}

/**
 * Searchable text of a file, by extension: plain text/markdown/code (first 1 MiB, UTF-8 or
 * latin1, null for binary content), PDF (first 50 pages via pdftotext) and office documents
 * (document XML via unzip). Result at most 1 MiB UTF-8; null if the type is not supported or
 * there is no text. Tool errors (missing, timeout, failure) are thrown.
 */
export async function extractText(abs: string, name: string, size: number, opts: ToolOptions = {}): Promise<string | null> {
  const ext = extOf(name);
  if (size === 0) return null;
  if (PLAIN_EXTS.has(ext)) {
    const { buf } = await readPrefix(abs, MAX_TEXT_BYTES);
    if (looksBinary(buf)) return null;
    return finish(decodeText(buf).text);
  }
  if (PDF_EXTS.includes(ext)) {
    return finish(await pdfText(abs, PDF_MAX_OUTPUT, opts));
  }
  if (OFFICE_EXTS.includes(ext)) {
    const xml = await unzipMembers(abs, OFFICE_MEMBERS[ext], ZIP_MAX_OUTPUT, opts);
    return finish(xmlToText(xml));
  }
  return null;
}
