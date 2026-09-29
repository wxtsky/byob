/** browser_select, browser_scroll, browser_drag, browser_upload_file. */
import { Tools } from '@byob/shared';
import type { CdpSession } from '../cdp.js';
import { ByobError } from '../errors.js';
import {
  callOnElement,
  describeHandle,
  hasTarget,
  resolveTarget,
  waitActionable,
  mainFrameLoc,
  type ElementHandle,
} from '../dom/element.js';
import { evaluateIsolated, sendTo } from '../dom/frames.js';
import { observe } from '../event-hub.js';
import { mouseDown, mouseMove, mouseUp } from '../input/mouse.js';
import { withEffects } from '../settle.js';
import { actionResult, attach, pickTab } from './_common.js';
import { snapshotAfter } from './snapshot.js';

// ---------------------------------------------------------------------------
// select
// ---------------------------------------------------------------------------

export const SELECT_FN = `function (values) {
  const el = this;
  if (el.tagName !== 'SELECT') return { notSelect: el.tagName.toLowerCase(), role: el.getAttribute('role') };
  const opts = Array.from(el.options);
  const label = (o) => (o.label || o.textContent || '').trim();
  const picked = [];
  const missing = [];
  for (const v of values) {
    const t = v.trim();
    const o = opts.find((o) => o.value === v) || opts.find((o) => label(o) === t)
      || opts.find((o) => label(o).toLowerCase() === t.toLowerCase());
    if (o) picked.push(o); else missing.push(v);
  }
  if (missing.length) return { missing, available: opts.slice(0, 40).map((o) => label(o) || o.value) };
  if (!el.multiple && picked.length > 1) return { tooMany: true };
  for (const o of opts) o.selected = picked.includes(o);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { selected: picked.map((o) => label(o) || o.value) };
}`;

export async function handleSelect(raw: unknown, signal: AbortSignal): Promise<unknown> {
  const p = Tools.SelectInput.parse(raw);
  const tabId = await pickTab(p);
  const session = await attach(tabId, signal, 'select');
  const el = await resolveTarget(session, p, signal);
  await waitActionable(el, { enabled: true, hitTest: false, timeoutMs: (p.timeoutSec ?? 5) * 1000 }, signal);
  type R = { notSelect?: string; role?: string; missing?: string[]; available?: string[]; tooMany?: boolean; selected?: string[] };
  const { result, effects, interrupted } = await withEffects(session, () => callOnElement<R>(el, SELECT_FN, [p.values], signal), { signal });
  if (interrupted || !result) {
    return actionResult(tabId, `Selected ${p.values.map((v) => JSON.stringify(v)).join(', ')} in ${describeHandle(el)} (the page opened a dialog)`, effects, { ref: el.ref });
  }
  if (result.notSelect) {
    throw new ByobError('invalid_argument', `${describeHandle(el)} is a <${result.notSelect}>, not a <select>.`,
      'For a custom dropdown: browser_click it, then click the option (browser_find role:"option" name:"…").');
  }
  if (result.missing) {
    throw new ByobError('option_not_found', `No option ${result.missing.map((m) => JSON.stringify(m)).join(', ')} in ${describeHandle(el)}.`,
      `Available: ${result.available!.join(' | ')}`);
  }
  if (result.tooMany) throw new ByobError('invalid_argument', `${describeHandle(el)} is single-select; pass one value.`);
  return {
    ...actionResult(tabId, `Selected ${result.selected!.map((s) => JSON.stringify(s)).join(', ')} in ${describeHandle(el)}`, effects, { ref: el.ref }),
    ...(await snapshotAfter(session, p.snapshot, signal)),
  };
}

// ---------------------------------------------------------------------------
// scroll
// ---------------------------------------------------------------------------

/** Scroll a container (or the page when `this` is the scrolling element),
 *  climbing to the nearest scrollable ancestor if needed. */
export const SCROLL_FN = `function (dir, amount, to) {
  let el = this;
  const scrollable = (n) => {
    if (!n || n.nodeType !== 1) return false;
    if (n === document.scrollingElement) return true;
    const cs = getComputedStyle(n);
    const oy = /(auto|scroll|overlay)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 1;
    const ox = /(auto|scroll|overlay)/.test(cs.overflowX) && n.scrollWidth > n.clientWidth + 1;
    return oy || ox;
  };
  while (el && !scrollable(el)) el = el.parentElement;
  if (!el) el = document.scrollingElement || document.documentElement;
  const page = el === document.scrollingElement;
  const vh = page ? innerHeight : el.clientHeight;
  const vw = page ? innerWidth : el.clientWidth;
  if (to === 'top') el.scrollTo({ top: 0, behavior: 'instant' });
  else if (to === 'bottom') el.scrollTo({ top: el.scrollHeight, behavior: 'instant' });
  else {
    const dy = dir === 'down' ? (amount || vh * 0.85) : dir === 'up' ? -(amount || vh * 0.85) : 0;
    const dx = dir === 'right' ? (amount || vw * 0.85) : dir === 'left' ? -(amount || vw * 0.85) : 0;
    el.scrollBy({ top: dy, left: dx, behavior: 'instant' });
  }
  return {
    page,
    top: Math.round(el.scrollTop), left: Math.round(el.scrollLeft),
    maxTop: Math.max(0, el.scrollHeight - el.clientHeight), maxLeft: Math.max(0, el.scrollWidth - el.clientWidth),
  };
}`;

type ScrollState = { page: boolean; top: number; left: number; maxTop: number; maxLeft: number };

function describeScroll(s: ScrollState): string {
  const where = s.maxTop === 0 ? 'no vertical scroll' : s.top <= 0 ? 'at top' : s.top >= s.maxTop - 1 ? 'at bottom' : `${Math.round((s.top / s.maxTop) * 100)}%`;
  return `${s.page ? 'page' : 'container'} scrollTop=${s.top}/${s.maxTop} (${where})`;
}

export async function handleScroll(raw: unknown, signal: AbortSignal): Promise<unknown> {
  const p = Tools.ScrollInput.parse(raw);
  const tabId = await pickTab(p);
  const session = await attach(tabId, signal, 'scroll');
  const waitLazy = (): Promise<void> => new Promise((r) => setTimeout(r, 250));

  if (hasTarget(p)) {
    const el = await resolveTarget(session, p, signal);
    if (!p.direction && !p.to) {
      await sendTo(session, el.frame.sessionId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: el.backendNodeId }, signal)
        .catch(() => {});
      return actionResult(tabId, `Scrolled ${describeHandle(el)} into view`, {}, { ref: el.ref });
    }
    const st = await callOnElement<ScrollState>(el, SCROLL_FN, [p.direction ?? null, p.amount ?? 0, p.to ?? null], signal);
    await waitLazy();
    return actionResult(tabId, `Scrolled ${p.to ?? p.direction} inside ${describeHandle(el)} — ${describeScroll(st)}`, {}, { ref: el.ref, scroll: st });
  }
  if (!p.direction && !p.to) {
    throw new ByobError('invalid_argument', 'browser_scroll: pass direction, to, or a target to scroll into view.');
  }
  const loc = await mainFrameLoc(session, signal);
  const r = await evaluateIsolated<ScrollState>(session, loc,
    `(${SCROLL_FN}).call(document.scrollingElement || document.documentElement, ${JSON.stringify(p.direction ?? null)}, ${p.amount ?? 0}, ${JSON.stringify(p.to ?? null)})`,
    { signal });
  await waitLazy();
  return actionResult(tabId, `Scrolled ${p.to ?? p.direction} — ${describeScroll(r.value!)}`, {}, { scroll: r.value });
}

// ---------------------------------------------------------------------------
// drag
// ---------------------------------------------------------------------------

async function dragEndPoint(
  session: CdpSession,
  end: { ref?: string; selector?: string; x?: number; y?: number },
  framePath: string[] | undefined,
  which: string,
  signal: AbortSignal,
): Promise<{ x: number; y: number; label: string; el?: ElementHandle }> {
  if (end.ref !== undefined || end.selector !== undefined) {
    const el = await resolveTarget(session, { ref: end.ref, selector: end.selector, framePath }, signal);
    const pt = await waitActionable(el, { hitTest: false, timeoutMs: 5000 }, signal);
    return { x: pt.x, y: pt.y, label: describeHandle(el), el };
  }
  if (end.x !== undefined && end.y !== undefined) return { x: end.x, y: end.y, label: `(${end.x}, ${end.y})` };
  throw new ByobError('invalid_argument', `browser_drag: ${which} needs ref, selector, or x+y.`);
}

export const SIM_DND_FN = `function (target) {
  const src = this;
  const draggable = src.draggable || src.closest('[draggable="true"]');
  if (!draggable) return false;
  const dt = new DataTransfer();
  const box = (el) => { const r = el.getBoundingClientRect(); return { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }; };
  const fire = (el, type, at) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, dataTransfer: dt, ...at }));
  fire(src, 'dragstart', box(src));
  fire(target, 'dragenter', box(target));
  fire(target, 'dragover', box(target));
  fire(target, 'drop', box(target));
  fire(src, 'dragend', box(target));
  return true;
}`;

export async function handleDrag(raw: unknown, signal: AbortSignal): Promise<unknown> {
  const p = Tools.DragInput.parse(raw);
  const tabId = await pickTab({ tabId: p.tabId, ref: p.from.ref ?? p.to.ref });
  const session = await attach(tabId, signal, 'drag');
  const from = await dragEndPoint(session, p.from, p.framePath, 'from', signal);
  const to = await dragEndPoint(session, p.to, p.framePath, 'to', signal);

  // HTML5 drag-and-drop never sees synthetic mouse moves. With drag
  // interception on, Chrome hands us the drag data when a native drag
  // starts, and we replay it as real drag events over the target.
  let dragData: unknown = null;
  const off = observe((e) => {
    if (e.tabId === tabId && !e.sessionId && e.method === 'Input.dragIntercepted') dragData = e.params.data;
  });
  await session.send('Input.setInterceptDrags', { enabled: true }, signal).catch(() => {});
  let html5 = false;
  try {
    const { effects } = await withEffects(session, async () => {
      await mouseMove(session, from.x, from.y, {}, signal);
      await mouseDown(session, from.x, from.y, signal);
      for (let i = 1; i <= p.steps; i++) {
        const t = i / p.steps;
        await mouseMove(session, from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, { buttons: 1 }, signal);
        if (dragData) break;
      }
      // The interception event can trail the last move by a frame or two.
      for (let i = 0; i < 10 && !dragData; i++) await new Promise((r) => setTimeout(r, 30));
      if (dragData) {
        html5 = true;
        for (const type of ['dragEnter', 'dragOver', 'drop']) {
          await session.send('Input.dispatchDragEvent', { type, x: to.x, y: to.y, data: dragData, modifiers: 0 }, signal);
        }
      }
      await mouseUp(session, to.x, to.y, signal);
      // No native drag was intercepted (headless, or the page starts drags
      // in ways Chrome doesn't hand over): replay the HTML5 event sequence
      // in the page with a shared DataTransfer.
      if (!html5 && from.el && to.el && from.el.frame.frameId === to.el.frame.frameId) {
        const r = await sendTo<{ result: { value?: boolean } }>(session, from.el.frame.sessionId, 'Runtime.callFunctionOn', {
          objectId: from.el.objectId,
          functionDeclaration: SIM_DND_FN,
          arguments: [{ objectId: to.el.objectId }],
          returnByValue: true,
        }, signal);
        html5 = r.result.value === true;
      }
    }, { signal });
    return {
      ...actionResult(tabId, `Dragged ${from.label} → ${to.label}${html5 ? ' (HTML5 drag-and-drop)' : ''}`, effects),
      ...(await snapshotAfter(session, p.snapshot, signal)),
    };
  } finally {
    off();
    await session.send('Input.setInterceptDrags', { enabled: false }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// upload
// ---------------------------------------------------------------------------

export async function handleUploadFile(raw: unknown, signal: AbortSignal): Promise<unknown> {
  const p = Tools.UploadFileInput.parse(raw);
  const tabId = await pickTab(p);
  const session = await attach(tabId, signal, 'upload');
  const el = await resolveTarget(session, p, signal);
  const kind = await callOnElement<{ ok: boolean; multiple: boolean; tag: string }>(el, `function () {
    return { ok: this.tagName === 'INPUT' && this.type === 'file', multiple: !!this.multiple, tag: this.tagName.toLowerCase() + (this.type ? '[type=' + this.type + ']' : '') };
  }`, [], signal);
  if (!kind.ok) {
    throw new ByobError('not_a_file_input', `${describeHandle(el)} is <${kind.tag}>, not <input type=file>.`,
      'Many sites hide the real input: browser_find selector-less won\'t see it — try selector "input[type=file]".');
  }
  if (p.paths.length > 1 && !kind.multiple) {
    throw new ByobError('invalid_argument', `${describeHandle(el)} accepts a single file.`);
  }
  await sendTo(session, el.frame.sessionId, 'DOM.setFileInputFiles', { files: p.paths, backendNodeId: el.backendNodeId }, signal);
  return actionResult(tabId, `Attached ${p.paths.length} file(s) to ${describeHandle(el)}`, {}, { ref: el.ref });
}
