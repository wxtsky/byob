/**
 * PDF → text, in the offscreen document (pdf.js). The service worker fetches
 * the file inside the page (so the page's cookies apply), streams the bytes
 * here in base64 chunks, then asks for the text page by page.
 *
 * Everything is bundled: the pdf.js worker is a build asset and the CMaps
 * (needed for CJK fonts) are copied into the extension by wxt.config.ts.
 */
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export type PdfMessage =
  | { action: 'pdf-start'; id: string; size: number }
  | { action: 'pdf-chunk'; id: string; offset: number; data: string }
  | { action: 'pdf-text'; id: string; maxPages: number; maxChars: number }
  | { action: 'pdf-free'; id: string };

interface PendingPdf {
  bytes: Uint8Array;
  received: number;
  lastMsgAt: number;
}

const files = new Map<string, PendingPdf>();
const ORPHAN_MS = 120_000;

// The service worker owns the request; if it died, nobody collects these.
setInterval(() => {
  for (const [id, f] of files) if (Date.now() - f.lastMsgAt > ORPHAN_MS) files.delete(id);
}, 30_000);

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** pdf.js text items → lines; hasEOL marks the ends pdf.js detected. */
function pageText(items: Array<{ str?: string; hasEOL?: boolean }>): string {
  let s = '';
  for (const it of items) {
    if (typeof it.str !== 'string') continue;
    s += it.str;
    if (it.hasEOL) s += '\n';
  }
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export async function handlePdfMessage(m: PdfMessage): Promise<Record<string, unknown>> {
  if (m.action === 'pdf-start') {
    files.set(m.id, { bytes: new Uint8Array(m.size), received: 0, lastMsgAt: Date.now() });
    return { ok: true };
  }
  if (m.action === 'pdf-free') {
    files.delete(m.id);
    return { ok: true };
  }
  const f = files.get(m.id);
  if (!f) return { ok: false, error: `unknown pdf ${m.id}` };
  f.lastMsgAt = Date.now();
  if (m.action === 'pdf-chunk') {
    const part = b64ToBytes(m.data);
    if (m.offset + part.length > f.bytes.length) return { ok: false, error: 'chunk past the declared size' };
    f.bytes.set(part, m.offset);
    f.received += part.length;
    return { ok: true, received: f.received };
  }
  files.delete(m.id);
  const task = pdfjs.getDocument({
    data: f.bytes,
    cMapUrl: chrome.runtime.getURL('pdfjs/cmaps/'),
    cMapPacked: true,
  });
  try {
    const doc = await task.promise;
    const pages: string[] = [];
    let chars = 0;
    const last = Math.min(doc.numPages, m.maxPages);
    for (let n = 1; n <= last && chars <= m.maxChars; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const text = pageText(content.items as Array<{ str?: string; hasEOL?: boolean }>);
      pages.push(text);
      chars += text.length;
      page.cleanup();
    }
    return { ok: true, numPages: doc.numPages, pages };
  } finally {
    await task.destroy();
  }
}
