/**
 * Regenerates e2e/fixtures/report.pdf: a minimal two-page PDF with a real
 * text layer (Helvetica, WinAnsi), small enough to commit.
 *   bun e2e/make-pdf.ts
 */
import * as path from 'node:path';

const pages = [
  ['Quarterly Report', 'Revenue grew 42 percent in the third quarter.'],
  ['Appendix', 'The second page mentions zebras exactly once.'],
];
const objs: string[] = [];
const add = (s: string): number => {
  objs.push(s);
  return objs.length;
};
const catalog = add('');
const pagesObj = add('');
const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
const kids: number[] = [];
for (const [title, body] of pages) {
  const stream = `BT /F1 20 Tf 72 720 Td (${title}) Tj ET\nBT /F1 12 Tf 72 690 Td (${body}) Tj ET`;
  const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
}
objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;

let out = '%PDF-1.4\n';
const offsets: number[] = [];
objs.forEach((o, i) => {
  offsets.push(out.length);
  out += `${i + 1} 0 obj\n${o}\nendobj\n`;
});
const xref = out.length;
out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

await Bun.write(path.join(import.meta.dir, 'fixtures/report.pdf'), out);
