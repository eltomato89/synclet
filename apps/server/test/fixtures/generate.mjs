// Regenerates the sharp-based and hand-written fixtures (see README.md).
// Run from apps/server: node test/fixtures/generate.mjs
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const dir = path.dirname(fileURLToPath(import.meta.url));
const out = (name) => path.join(dir, name);

// 64x32 landscape: left half red, right half blue; EXIF orientation 6 (rotate 90° CW on display),
// so an orientation-aware thumbnail is portrait (32x64) with red on top.
const half = (r, g, b) => sharp({ create: { width: 32, height: 32, channels: 3, background: { r, g, b } } }).png().toBuffer();
const landscape = sharp({ create: { width: 64, height: 32, channels: 3, background: { r: 0, g: 0, b: 0 } } })
  .composite([{ input: await half(255, 0, 0), left: 0, top: 0 }, { input: await half(0, 0, 255), left: 32, top: 0 }]);
await landscape.jpeg({ quality: 90 }).withMetadata({ orientation: 6 }).toFile(out('rotated.jpg'));

await sharp({ create: { width: 80, height: 60, channels: 4, background: { r: 0, g: 160, b: 80, alpha: 1 } } }).png().toFile(out('sample.png'));

await writeFile(out('script.svg'), `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="120" height="80" onload="alert('onload')">
  <script type="text/javascript">alert('xss');document.cookie;</script>
  <rect width="120" height="80" fill="#3366cc"/>
  <image xlink:href="file:///etc/passwd" width="10" height="10"/>
  <a xlink:href="javascript:alert(1)"><circle cx="60" cy="40" r="20" fill="#ffcc00"/></a>
</svg>
`);

// Minimal one-page PDF (a filled rectangle), with a correct xref table.
const objs = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << >> >>',
];
const stream = '0.2 0.4 0.8 rg 20 20 160 60 re f';
objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
let pdf = '%PDF-1.4\n';
const offsets = [];
objs.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
const xref = pdf.length;
pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
await writeFile(out('sample.pdf'), pdf, 'latin1');

await writeFile(out('sample.txt'), 'Plain text fixture.\nSecond line.\n');
await writeFile(out('sample.md'), '# Fixture\n\nSome *markdown* text.\n');
await writeFile(out('sample.ts'), 'export const answer: number = 42;\n');

