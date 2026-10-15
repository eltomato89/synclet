import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeOffice, writeTextPdf, writeZip } from '../../test/text-fixtures';
import { itIfTool } from '../../test/tools';
import { decodeText, extractText, looksBinary, MAX_TEXT_BYTES, truncateUtf8, xmlToText } from './text-extract';
import { ToolFailedError } from './tools';

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures');

describe('text extraction', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'synclet-text-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const put = async (name: string, content: string | Buffer) => {
    const abs = path.join(dir, name);
    await writeFile(abs, content);
    return abs;
  };
  const extract = async (abs: string) => extractText(abs, path.basename(abs), 1);

  it('txt as UTF-8', async () => {
    const abs = await put('a.txt', 'Grüße aus Köln – café\n');
    expect(await extract(abs)).toBe('Grüße aus Köln – café\n');
  });

  it('txt as latin1 when it is not valid UTF-8', async () => {
    const abs = await put('a.txt', Buffer.from('Grüße aus Köln, café crème', 'latin1'));
    expect(await extract(abs)).toBe('Grüße aus Köln, café crème');
    expect(decodeText(Buffer.from('Grüße', 'latin1')).encoding).toBe('latin1');
    expect(decodeText(Buffer.from('Grüße', 'utf8')).encoding).toBe('utf-8');
  });

  it('a few invalid bytes in a long UTF-8 text stay UTF-8 (≤ 1 %)', () => {
    const buf = Buffer.concat([Buffer.from('ä'.repeat(500), 'utf8'), Buffer.from([0xff])]);
    expect(decodeText(buf).encoding).toBe('utf-8');
  });

  it('a UTF-8 sequence cut off at the end of the read prefix is dropped, not counted', () => {
    const buf = Buffer.from('abc€', 'utf8').subarray(0, 5); // € = 3 bytes, 2 of them kept
    expect(decodeText(buf)).toEqual({ text: 'abc', encoding: 'utf-8' });
  });

  it('md and ts fixtures', async () => {
    const md = path.join(dir, 'sample.md'); await copyFile(path.join(FIXTURES, 'sample.md'), md);
    const ts = path.join(dir, 'sample.ts'); await copyFile(path.join(FIXTURES, 'sample.ts'), ts);
    expect(await extract(md)).toContain('Some *markdown* text.');
    expect((await extract(ts))?.length).toBeGreaterThan(0);
  });

  it('NUL characters are stripped', async () => {
    const words = ' lorem ipsum'.repeat(10);
    expect(await extract(await put('n.txt', `a\u0000b${words}`))).toBe(`ab${words}`);
  });

  it('binary content → null, also behind a text extension', async () => {
    const bin = Buffer.alloc(4096);
    for (let i = 0; i < bin.length; i++) bin[i] = (i * 7919) % 256;
    expect(looksBinary(bin)).toBe(true);
    expect(await extract(await put('blob.txt', bin))).toBeNull();
    expect(await extract(await put('blob.bin', 'plain words'))).toBeNull(); // unsupported extension
    expect(await extract(await put('empty.txt', '  \n'))).toBeNull();
  });

  it('text above 1 MiB is truncated to 1 MiB on a character boundary', async () => {
    const abs = await put('big.txt', 'ä'.repeat(MAX_TEXT_BYTES)); // 2 MiB of UTF-8
    const text = (await extract(abs))!;
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_TEXT_BYTES);
    expect(Buffer.byteLength(text)).toBeGreaterThan(MAX_TEXT_BYTES - 4);
    expect(text).toMatch(/^ä+$/);
    expect(truncateUtf8('a€b', 3)).toBe('a');
  });

  it('xmlToText: runs joined, paragraphs separated, entities decoded', () => {
    expect(xmlToText('<w:p><w:r><w:t>Rech</w:t></w:r><w:r><w:t>nung</w:t></w:r></w:p><w:p><w:r><w:t>A &amp; B &#x263A; &#65;</w:t></w:r></w:p>'))
      .toBe('Rechnung A & B ☺ A');
    expect(xmlToText('<text:p>eins<text:s/>zwei<text:tab/>drei</text:p><text:p>vier</text:p>')).toBe('eins zwei drei vier');
  });

  itIfTool('unzip', 'docx, xlsx, pptx and odt', async () => {
    for (const kind of ['docx', 'xlsx', 'pptx', 'odt'] as const) {
      const abs = path.join(dir, `doc.${kind}`);
      await writeOffice(abs, kind, ['Rechnung Nummer 4711', 'Grüße & Dank']);
      const text = await extract(abs);
      expect(text).toContain('Rechnung Nummer 4711');
      expect(text).toContain('Grüße & Dank');
    }
  });

  itIfTool('unzip', 'office file without the text member → null; not a zip → tool failure', async () => {
    const abs = path.join(dir, 'empty.docx');
    await writeZip(abs, { 'other.xml': '<x>hidden</x>' });
    expect(await extract(abs)).toBeNull();
    await expect(extract(await put('fake.docx', 'not a zip'))).rejects.toBeInstanceOf(ToolFailedError);
  });

  itIfTool('unzip', 'an encrypted member fails fast (no password prompt) with a tool failure', async () => {
    const abs = path.join(dir, 'locked.docx');
    await writeZip(abs, { 'word/document.xml': '<w:p><w:r><w:t>secret</w:t></w:r></w:p>' });
    // Mark every entry as encrypted (general purpose flag bit 0 in local and central headers).
    const buf = await readFile(abs);
    for (let i = 0; i + 4 <= buf.length; i++) {
      const sig = buf.readUInt32LE(i);
      if (sig === 0x04034b50) buf.writeUInt16LE(buf.readUInt16LE(i + 6) | 1, i + 6);
      else if (sig === 0x02014b50) buf.writeUInt16LE(buf.readUInt16LE(i + 8) | 1, i + 8);
    }
    await writeFile(abs, buf);
    const started = Date.now();
    await expect(extract(abs)).rejects.toBeInstanceOf(ToolFailedError);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  itIfTool('unzip', 'a decompression bomb only yields a capped prefix', async () => {
    const abs = path.join(dir, 'bomb.docx');
    // 64 MiB of highly compressible XML (~64 KiB zipped); the tool output is capped at 32 MiB.
    const para = '<w:p><w:r><w:t>bomb</w:t></w:r></w:p>';
    await writeZip(abs, { 'word/document.xml': Buffer.from(para.repeat(Math.ceil((64 * 1024 * 1024) / para.length))) });
    const text = (await extract(abs))!;
    expect(text.startsWith('bomb bomb')).toBe(true);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_TEXT_BYTES);
  }, 60_000);

  itIfTool('pdftotext', 'pdf text', async () => {
    const abs = path.join(dir, 'invoice.pdf');
    await writeTextPdf(abs, 'Rechnung Betrag 42 Euro');
    expect(await extract(abs)).toContain('Rechnung Betrag 42 Euro');
  });

  itIfTool('pdftotext', 'pdf without text → null', async () => {
    const abs = path.join(dir, 'picture.pdf');
    await copyFile(path.join(FIXTURES, 'sample.pdf'), abs);
    expect(await extract(abs)).toBeNull();
  });
});
