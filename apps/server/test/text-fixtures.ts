import type { Archiver, ArchiverOptions } from 'archiver';
import { createWriteStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';

// archiver@7 exports a factory function (see src/shares/zip.ts).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const archiver = require('archiver') as (format: 'zip', options: ArchiverOptions) => Archiver;

/** Writes a zip with the given entries (name → content). */
export async function writeZip(file: string, entries: Record<string, string | Buffer>): Promise<void> {
  const out = createWriteStream(file);
  const zip = archiver('zip', { zlib: { level: 6 } });
  const done = new Promise<void>((resolve, reject) => { out.on('close', resolve); zip.on('error', reject); out.on('error', reject); });
  zip.pipe(out);
  for (const [name, content] of Object.entries(entries)) zip.append(content, { name });
  await zip.finalize();
  await done;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Minimal office documents whose text is `paragraphs`. Words are deliberately split into several
 * runs (as Word does after spell-checking) to check that runs are not separated by spaces.
 */
export async function writeOffice(file: string, kind: 'docx' | 'xlsx' | 'pptx' | 'odt', paragraphs: string[]): Promise<void> {
  const ct = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>';
  const splitRun = (p: string, open: string, close: string, runOpen = '', runClose = '') => {
    const mid = Math.max(1, Math.floor(p.length / 2));
    return `${runOpen}${open}${esc(p.slice(0, mid))}${close}${runClose}${runOpen}${open}${esc(p.slice(mid))}${close}${runClose}`;
  };
  if (kind === 'docx') {
    const body = paragraphs.map((p) => `<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr>${splitRun(p, '<w:t xml:space="preserve">', '</w:t>', '<w:r><w:rPr><w:b/></w:rPr>', '</w:r>')}</w:p>`).join('');
    await writeZip(file, {
      '[Content_Types].xml': ct,
      'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
    });
  } else if (kind === 'xlsx') {
    const si = paragraphs.map((p) => `<si><t>${esc(p)}</t></si>`).join('');
    await writeZip(file, {
      '[Content_Types].xml': ct,
      'xl/sharedStrings.xml': `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${paragraphs.length}">${si}</sst>`,
      'xl/workbook.xml': '<workbook/>',
    });
  } else if (kind === 'pptx') {
    const slide = (p: string) => `<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p>${splitRun(p, '<a:t>', '</a:t>', '<a:r>', '</a:r>')}</a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
    const entries: Record<string, string> = { '[Content_Types].xml': ct, 'ppt/presentation.xml': '<p:presentation/>' };
    paragraphs.forEach((p, i) => { entries[`ppt/slides/slide${i + 1}.xml`] = slide(p); });
    await writeZip(file, entries);
  } else {
    const body = paragraphs.map((p) => `<text:p text:style-name="P1">${splitRun(p, '<text:span text:style-name="T1">', '</text:span>')}</text:p>`).join('');
    await writeZip(file, {
      mimetype: 'application/vnd.oasis.opendocument.text',
      'content.xml': `<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text>${body}</office:text></office:body></office:document-content>`,
    });
  }
}

/** A one-page PDF showing `text` (ASCII) in Helvetica, with a correct xref table. */
export async function writeTextPdf(file: string, text: string): Promise<void> {
  const stream = `BT /F1 12 Tf 20 50 Td (${text.replace(/[\\()]/g, (c) => `\\${c}`)}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  await writeFile(file, pdf, 'latin1');
}
