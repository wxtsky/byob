/**
 * browser_screenshot — viewport / full page / element / clip, PNG · JPEG · PDF.
 *
 * Images are captured at CSS-pixel resolution (a retina tab would otherwise
 * produce 4× the pixels for no extra information) and the longest side is
 * capped, so an inline screenshot costs the model a predictable amount.
 * `annotate` draws the latest snapshot's refs onto the bitmap in the service
 * worker (OffscreenCanvas) — the page itself is never touched.
 */
import { Tools } from '@byob/shared';
import type { CdpSession } from '../cdp.js';
import { ByobError } from '../errors.js';
import { lookupRef } from '../refs.js';
import { describeHandle, hasTarget, resolveTarget } from '../dom/element.js';
import { frameOffset, mainFrameInfo, sendTo } from '../dom/frames.js';
import { keepAwakeEnd, keepAwakeStart } from '../keepalive.js';
import { checkUrlAllowed, urlForbiddenError } from '../url-guard.js';
import { navigateAndWait, openAgentTab, waitFirstLoad } from '../tab.js';
import { throwIfAborted } from '../signal-utils.js';
import { attach, pickTab, tabSummary } from './_common.js';
import { refsOfLastSnapshot, takeSnapshot } from './snapshot.js';

const MAX_SIDE = 1600;
const MAX_B64 = 40 * 1024 * 1024;
const lastHash = new Map<number, string>();
globalThis.chrome?.tabs?.onRemoved?.addListener((tabId: number) => lastHash.delete(tabId));

interface Metrics {
  cssVisualViewport: { pageX: number; pageY: number; clientWidth: number; clientHeight: number; scale?: number };
  cssContentSize: { width: number; height: number };
}

async function sha1(b64: string): Promise<string> {
  const buf = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const d = await crypto.subtle.digest('SHA-1', buf);
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

const PAPER: Record<string, { w: number; h: number }> = {
  A4: { w: 8.27, h: 11.69 }, Letter: { w: 8.5, h: 11 }, Legal: { w: 8.5, h: 14 },
};

async function printPdf(session: CdpSession, p: Tools.ScreenshotInputT, signal: AbortSignal): Promise<string> {
  const paper = PAPER[p.pdf?.paperFormat ?? 'A4']!;
  const r = await session.send<{ stream?: string }>('Page.printToPDF', {
    landscape: p.pdf?.landscape ?? false,
    printBackground: true,
    scale: 1,
    paperWidth: paper.w,
    paperHeight: paper.h,
    marginTop: 0.4, marginBottom: 0.4, marginLeft: 0.4, marginRight: 0.4,
    pageRanges: p.pdf?.pageRanges ?? '',
    transferMode: 'ReturnAsStream',
  }, signal);
  if (!r.stream) throw new ByobError('unknown', 'Page.printToPDF returned no stream');
  const chunks: string[] = [];
  try {
    for (;;) {
      throwIfAborted(signal);
      const c = await session.send<{ data: string; eof: boolean }>('IO.read', { handle: r.stream, size: 512 * 1024 }, signal);
      if (c.data) chunks.push(c.data);
      if (c.eof) break;
    }
  } finally {
    await session.send('IO.close', { handle: r.stream }).catch(() => {});
  }
  return chunks.join('');
}

interface Box { x: number; y: number; w: number; h: number; label: string }

/** Viewport boxes of the latest snapshot's refs. */
async function refBoxes(session: CdpSession, signal: AbortSignal): Promise<Box[]> {
  const tabId = session.tabId;
  let refs = refsOfLastSnapshot(tabId);
  // Refs from before a navigation point into a document that no longer
  // exists; take a fresh (interactive) snapshot instead.
  const main = await mainFrameInfo(session, signal);
  const first = refs.map((r) => lookupRef(tabId, r)).find((e) => e && !e.sessionId && e.frameId === main.frameId);
  if (!refs.length || !first || first.loaderId !== main.loaderId) {
    await takeSnapshot(session, { interactive: true }, signal);
    refs = refsOfLastSnapshot(tabId);
  }
  const vp = await session.send<{ result: { value: { w: number; h: number } } }>('Runtime.evaluate', {
    expression: '({ w: innerWidth, h: innerHeight })', returnByValue: true,
  }, signal);
  const { w: vw, h: vh } = vp.result.value;
  const boxes: Box[] = [];
  const offsets = new Map<string, { x: number; y: number }>();
  for (const ref of refs.slice(0, 400)) {
    const e = lookupRef(tabId, ref);
    if (!e || e.role === 'Iframe') continue;
    try {
      const q = await sendTo<{ quads: number[][] }>(session, e.sessionId, 'DOM.getContentQuads', { backendNodeId: e.backendNodeId }, signal);
      const quad = q.quads[0];
      if (!quad) continue;
      let off = offsets.get(e.frameId);
      if (!off) {
        off = e.sessionId ? await frameOffset(session, e.frameId, signal) : { x: 0, y: 0 };
        offsets.set(e.frameId, off);
      }
      const xs = [quad[0]!, quad[2]!, quad[4]!, quad[6]!].map((v) => v + off!.x);
      const ys = [quad[1]!, quad[3]!, quad[5]!, quad[7]!].map((v) => v + off!.y);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      const w = Math.max(...xs) - x;
      const h = Math.max(...ys) - y;
      if (w < 2 || h < 2 || x > vw || y > vh || x + w < 0 || y + h < 0) continue;
      boxes.push({ x, y, w, h, label: ref });
    } catch {
      /* node gone / no layout */
    }
  }
  return boxes;
}

// Worker-global canvas APIs; the extension's tsconfig has no DOM lib.
const G = globalThis as unknown as {
  createImageBitmap(b: Blob): Promise<{ width: number; height: number; close(): void }>;
  OffscreenCanvas: new (w: number, h: number) => {
    getContext(k: '2d'): any;
    convertToBlob(o: { type: string; quality?: number }): Promise<Blob>;
  };
};

async function drawBoxes(b64: string, mime: string, boxes: Box[], scale: number): Promise<string> {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const bmp = await G.createImageBitmap(new Blob([bytes], { type: mime }));
  const canvas = new G.OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  ctx.lineWidth = 2;
  ctx.font = 'bold 12px sans-serif';
  ctx.textBaseline = 'top';
  for (const b of boxes) {
    const x = b.x * scale;
    const y = b.y * scale;
    ctx.strokeStyle = 'rgba(230, 0, 90, 0.9)';
    ctx.strokeRect(x, y, b.w * scale, b.h * scale);
    const tw = ctx.measureText(b.label).width + 6;
    const ly = y >= 16 ? y - 16 : y;
    ctx.fillStyle = 'rgba(230, 0, 90, 0.92)';
    ctx.fillRect(x, ly, tw, 16);
    ctx.fillStyle = '#fff';
    ctx.fillText(b.label, x + 3, ly + 2);
  }
  const blob = await canvas.convertToBlob({ type: mime === 'image/jpeg' ? 'image/jpeg' : 'image/png', quality: 0.85 });
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

export async function handleScreenshot(raw: unknown, signal: AbortSignal): Promise<unknown> {
  const p = Tools.ScreenshotInput.parse(raw);
  let tabId: number;
  let opened = false;
  if (p.url) {
    const url = /^[a-z][a-z0-9+.-]*:/i.test(p.url) ? p.url : `https://${p.url}`;
    const g = checkUrlAllowed(url);
    if (!g.ok) {
      const env = urlForbiddenError(g.reason);
      throw new ByobError('url_forbidden', env.message, env.hint);
    }
    if (p.tabId !== undefined) {
      tabId = await pickTab(p);
      await navigateAndWait(tabId, url, 45_000, signal).catch((e) => {
        if ((e as { name?: string }).name === 'AbortError') throw e;
      });
    } else {
      tabId = await openAgentTab(url);
      opened = true;
      await waitFirstLoad(tabId, 45_000, signal).catch(() => {});
    }
  } else {
    tabId = await pickTab(p);
  }
  const session = await attach(tabId, signal, 'screenshot');
  keepAwakeStart();
  try {
    const info = { ...(await tabSummary(tabId)), opened };
    if (p.format === 'pdf') {
      const data = await printPdf(session, p, signal);
      return { ...info, _b64Data: data, mimeType: 'application/pdf', format: 'pdf', bytes: Math.floor((data.length * 3) / 4) };
    }

    const m = await session.send<Metrics>('Page.getLayoutMetrics', {}, signal);
    const vv = m.cssVisualViewport;
    let region: { x: number; y: number; width: number; height: number };
    let what = 'viewport';
    if (hasTarget(p)) {
      const el = await resolveTarget(session, p, signal);
      await sendTo(session, el.frame.sessionId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: el.backendNodeId }, signal).catch(() => {});
      const q = await sendTo<{ quads: number[][] }>(session, el.frame.sessionId, 'DOM.getContentQuads', { backendNodeId: el.backendNodeId }, signal)
        .catch(() => ({ quads: [] as number[][] }));
      const quad = q.quads[0];
      if (!quad) throw new ByobError('element_not_visible', `${describeHandle(el)} has no visible box to capture.`);
      const off = el.frame.sessionId ? await frameOffset(session, el.frame.frameId, signal) : { x: 0, y: 0 };
      const xs = [quad[0]!, quad[2]!, quad[4]!, quad[6]!];
      const ys = [quad[1]!, quad[3]!, quad[5]!, quad[7]!];
      const m2 = await session.send<Metrics>('Page.getLayoutMetrics', {}, signal);
      region = {
        x: Math.min(...xs) + off.x + m2.cssVisualViewport.pageX,
        y: Math.min(...ys) + off.y + m2.cssVisualViewport.pageY,
        width: Math.max(...xs) - Math.min(...xs),
        height: Math.max(...ys) - Math.min(...ys),
      };
      what = describeHandle(el);
    } else if (p.clip) {
      region = { x: p.clip.x + vv.pageX, y: p.clip.y + vv.pageY, width: p.clip.width, height: p.clip.height };
      what = 'clip';
    } else if (p.fullPage) {
      region = { x: 0, y: 0, width: m.cssContentSize.width, height: Math.min(m.cssContentSize.height, 16_000) };
      what = 'full page';
    } else {
      region = { x: vv.pageX, y: vv.pageY, width: vv.clientWidth, height: vv.clientHeight };
    }
    region.width = Math.max(1, Math.round(region.width));
    region.height = Math.max(1, Math.round(region.height));
    const scale = Math.min(1, MAX_SIDE / Math.max(region.width, region.height));
    const format = p.format === 'jpeg' ? 'jpeg' : 'png';
    const shot = await session.send<{ data: string }>('Page.captureScreenshot', {
      format,
      ...(format === 'jpeg' ? { quality: p.quality ?? 80 } : {}),
      clip: { ...region, scale },
      captureBeyondViewport: p.fullPage || hasTarget(p),
      fromSurface: true,
    }, signal);
    let data = shot.data;
    if (!data) throw new ByobError('unknown', 'Chrome returned an empty screenshot.');

    if (p.ifChanged) {
      const h = await sha1(data);
      const prev = lastHash.get(tabId);
      lastHash.set(tabId, h);
      if (prev === h) return { ...info, unchanged: true, what };
    }

    let legend: Array<{ ref: string; role: string; name: string }> | undefined;
    if (p.annotate && !p.fullPage && !hasTarget(p) && !p.clip) {
      const boxes = await refBoxes(session, signal);
      data = await drawBoxes(data, `image/${format}`, boxes, scale);
      legend = boxes.map((b) => {
        const e = lookupRef(tabId, b.label);
        return { ref: b.label, role: e?.role ?? '', name: e?.name ?? '' };
      });
    }
    if (data.length > MAX_B64) {
      throw new ByobError('unknown', `Screenshot too large (${Math.round(data.length / 1e6)} MB base64).`,
        'Use format:"jpeg", a clip, or an element target.');
    }
    return {
      ...info,
      _b64Data: data,
      mimeType: `image/${format}`,
      format,
      width: Math.round(region.width * scale),
      height: Math.round(region.height * scale),
      what,
      ...(legend ? { legend } : {}),
    };
  } finally {
    keepAwakeEnd();
  }
}
