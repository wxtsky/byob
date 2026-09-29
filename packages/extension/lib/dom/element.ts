/**
 * Target resolution and actionability.
 *
 * Every element-level tool (click, hover, type, select, upload, drag, …)
 * funnels through here: a ref or CSS selector becomes an ElementHandle —
 * a backend node id plus a remote object in byob's isolated world — and
 * `waitActionable` then polls until the element is attached, visible,
 * stable, enabled and actually receives the pointer at its centre, the way
 * Playwright's auto-waiting does. Agents therefore don't need explicit waits
 * before most actions, and failures say *why* (covered by X, disabled, …).
 */
import type { CdpSession } from '../cdp.js';
import { ByobError, isStaleNodeError, isContextGoneError } from '../errors.js';
import { lookupRef, normalizeRef, refFor, tabOfRef, type RefEntry } from '../refs.js';
import {
  type FrameLoc,
  callFunctionOn,
  currentLoaderId,
  evaluateIsolated,
  frameOffset,
  getFrameTree,
  isolatedContext,
  mainFrameInfo,
  findInTree,
  recordFrame,
  sendTo,
  dropIsolatedContext,
  oopifSession,
} from './frames.js';
import { sleepWithSignal, throwIfAborted } from '../signal-utils.js';
import { checkFrameUrlAllowed } from '../url-guard.js';

export interface TargetSpec {
  ref?: string;
  selector?: string;
  framePath?: string[];
}

export interface ElementHandle {
  tabId: number;
  session: CdpSession;
  frame: FrameLoc;
  backendNodeId: number;
  /** Remote object in byob's isolated world. */
  objectId: string;
  ref: string;
  role: string;
  name: string;
  /** True when a stale ref was re-found by role/name after a re-render. */
  relocated?: boolean;
}

export function hasTarget(spec: TargetSpec): boolean {
  return spec.ref !== undefined || spec.selector !== undefined;
}

/** "button "Save" [ref=e7]" — how results describe the element they acted on. */
export function describeHandle(h: Pick<ElementHandle, 'role' | 'name' | 'ref'>): string {
  const name = h.name ? ` ${JSON.stringify(h.name.length > 80 ? h.name.slice(0, 80) + '…' : h.name)}` : '';
  return `${h.role || 'element'}${name} [ref=${h.ref}]`;
}

// ---------------------------------------------------------------------------
// Frame path (CSS selectors of nested iframes) → FrameLoc
// ---------------------------------------------------------------------------

export async function resolveFramePath(
  session: CdpSession,
  framePath: string[] | undefined,
  signal?: AbortSignal,
): Promise<FrameLoc> {
  const main = await mainFrameInfo(session, signal);
  let loc: FrameLoc = { frameId: main.frameId };
  recordFrame(session.tabId, { frameId: main.frameId });
  const path = framePath ?? [];
  for (let i = 0; i < path.length; i++) {
    const sel = path[i]!;
    const found = await evaluateIsolated(session, loc, `document.querySelector(${JSON.stringify(sel)})`, {
      returnByValue: false,
      signal,
    }).catch((e: unknown) => {
      throw new ByobError('frame_not_found', `framePath[${i}] ${JSON.stringify(sel)}: ${(e as Error).message}`,
        undefined, { framePathIndex: i });
    });
    if (!found.objectId) {
      throw new ByobError('frame_not_found', `framePath[${i}] selector ${JSON.stringify(sel)} matched no element`,
        undefined, { framePathIndex: i });
    }
    const d = await sendTo<{ node: { nodeName: string; frameId?: string; backendNodeId: number; contentDocument?: { frameId?: string } } }>(
      session, loc.sessionId, 'DOM.describeNode', { objectId: found.objectId }, signal,
    );
    const tag = d.node.nodeName.toLowerCase();
    if (tag !== 'iframe' && tag !== 'frame') {
      throw new ByobError('frame_not_found', `framePath[${i}] matched <${tag}>, expected <iframe>`,
        undefined, { framePathIndex: i, reason: 'not_an_iframe' });
    }
    const childFrameId = d.node.frameId ?? d.node.contentDocument?.frameId;
    if (!childFrameId) {
      throw new ByobError('frame_not_found', `framePath[${i}]: iframe has no loaded document`,
        undefined, { framePathIndex: i, reason: 'frame_blank' });
    }
    const childSession = oopifSession(session.tabId, childFrameId) ?? loc.sessionId;
    try {
      const t = await getFrameTree(session, childSession, signal);
      const url = findInTree(t, childFrameId)?.frame.url;
      const ok = checkFrameUrlAllowed(url);
      if (!ok.ok) throw new ByobError('url_forbidden', `framePath[${i}]: ${ok.reason}`, "This frame is blocked by the user's byob site policy.");
    } catch (e) {
      if (e instanceof ByobError) throw e;
    }
    recordFrame(session.tabId, {
      frameId: childFrameId,
      sessionId: childSession,
      parentFrameId: loc.frameId,
      ownerBackendNodeId: d.node.backendNodeId,
    });
    loc = { frameId: childFrameId, sessionId: childSession };
  }
  return loc;
}

// ---------------------------------------------------------------------------
// Target → ElementHandle
// ---------------------------------------------------------------------------

async function axRoleName(
  session: CdpSession,
  sessionId: string | undefined,
  backendNodeId: number,
  signal?: AbortSignal,
): Promise<{ role: string; name: string }> {
  try {
    const r = await sendTo<{ nodes: Array<{ role?: { value?: string }; name?: { value?: string }; ignored?: boolean }> }>(
      session, sessionId, 'Accessibility.getPartialAXTree',
      { backendNodeId, fetchRelatives: false }, signal,
    );
    const n = r.nodes.find((x) => !x.ignored) ?? r.nodes[0];
    return { role: n?.role?.value ?? '', name: (n?.name?.value ?? '').trim() };
  } catch (e) {
    if ((e as { name?: string }).name === 'AbortError') throw e;
    return { role: '', name: '' };
  }
}

async function resolveBackend(
  session: CdpSession,
  loc: FrameLoc,
  backendNodeId: number,
  signal?: AbortSignal,
): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const ctx = await isolatedContext(session, loc, signal);
    try {
      const r = await sendTo<{ object: { objectId?: string } }>(
        session, loc.sessionId, 'DOM.resolveNode',
        { backendNodeId, executionContextId: ctx }, signal,
      );
      if (!r.object.objectId) throw new Error('No node with given id found');
      return r.object.objectId;
    } catch (e) {
      if (attempt === 0 && isContextGoneError(e)) {
        dropIsolatedContext(session.tabId, loc);
        continue;
      }
      throw e;
    }
  }
}

/**
 * Re-find a vanished node (a framework re-rendered it) by role + accessible
 * name. Only when the page still has exactly the same set of such controls
 * as the whole-document snapshot that minted the ref — otherwise "the 3rd
 * Delete button" could now be a different row's button, and refusing is the
 * only safe answer.
 */
async function relocate(
  session: CdpSession,
  entry: RefEntry,
  signal?: AbortSignal,
): Promise<number | null> {
  if (!entry.role || !entry.name || entry.nth < 0 || entry.total === undefined) return null;
  try {
    // Only frames that are the root document of their session: a query from
    // the main document can't count duplicates inside a same-process iframe.
    const tree = await getFrameTree(session, entry.sessionId, signal);
    if (tree.frame.id !== entry.frameId) return null;
    const doc = await sendTo<{ root: { nodeId: number } }>(
      session, entry.sessionId, 'DOM.getDocument', { depth: 0 }, signal,
    );
    const q = await sendTo<{ nodes: Array<{ backendDOMNodeId?: number; ignored?: boolean }> }>(
      session, entry.sessionId, 'Accessibility.queryAXTree',
      { nodeId: doc.root.nodeId, accessibleName: entry.name, role: entry.role }, signal,
    );
    const hits = q.nodes.filter((n) => !n.ignored && typeof n.backendDOMNodeId === 'number');
    if (hits.length !== entry.total) return null;
    return hits[entry.nth]?.backendDOMNodeId ?? null;
  } catch (e) {
    if ((e as { name?: string }).name === 'AbortError') throw e;
    return null;
  }
}

const SNAPSHOT_HINT = 'Take a new browser_snapshot (or browser_find) and use the fresh ref.';

export async function resolveTarget(
  session: CdpSession,
  spec: TargetSpec,
  signal?: AbortSignal,
): Promise<ElementHandle> {
  const tabId = session.tabId;
  if (spec.ref !== undefined) {
    const ref = normalizeRef(spec.ref);
    if (!ref) {
      throw new ByobError('invalid_argument', `"${spec.ref}" is not a ref (expected e.g. "e12")`,
        'Refs come from browser_snapshot / browser_find output: [ref=e12].');
    }
    const entry = lookupRef(tabId, ref);
    if (!entry) {
      const other = tabOfRef(ref);
      throw new ByobError('stale_ref',
        other !== undefined
          ? `Ref ${ref} belongs to tab ${other}, not tab ${tabId}.`
          : `Unknown ref ${ref} (refs reset when the extension restarts).`,
        other !== undefined ? `Pass tabId: ${other}, or snapshot this tab.` : SNAPSHOT_HINT);
    }
    const loc: FrameLoc = { frameId: entry.frameId, sessionId: entry.sessionId };
    const loader = await currentLoaderId(session, loc, signal);
    if (!loader || (entry.loaderId && loader !== entry.loaderId)) {
      throw new ByobError('stale_ref',
        `Ref ${ref} is from a page that has since navigated or reloaded.`, SNAPSHOT_HINT);
    }
    try {
      const objectId = await resolveBackend(session, loc, entry.backendNodeId, signal);
      return {
        tabId, session, frame: loc, backendNodeId: entry.backendNodeId, objectId,
        ref, role: entry.role, name: entry.name,
      };
    } catch (e) {
      if (!isStaleNodeError(e)) throw e;
      const again = await relocate(session, entry, signal);
      if (again === null) {
        throw new ByobError('stale_ref',
          `Ref ${ref} (${entry.role} "${entry.name}") is no longer in the page.`, SNAPSHOT_HINT);
      }
      const objectId = await resolveBackend(session, loc, again, signal);
      const newRef = refFor(tabId, { ...entry, backendNodeId: again });
      return {
        tabId, session, frame: loc, backendNodeId: again, objectId,
        ref: newRef, role: entry.role, name: entry.name, relocated: true,
      };
    }
  }

  if (spec.selector !== undefined) {
    const loc = await resolveFramePath(session, spec.framePath, signal);
    let found;
    try {
      found = await evaluateIsolated(session, loc, `document.querySelector(${JSON.stringify(spec.selector)})`, {
        returnByValue: false, signal,
      });
    } catch (e) {
      if (e instanceof ByobError && e.code === 'eval_exception') {
        throw new ByobError('invalid_argument', `Invalid CSS selector ${JSON.stringify(spec.selector)}`);
      }
      throw e;
    }
    if (!found.objectId) {
      throw new ByobError('selector_not_found', `No element matches ${JSON.stringify(spec.selector)}`,
        'Check the selector, or use browser_snapshot / browser_find to get a ref.');
    }
    const d = await sendTo<{ node: { backendNodeId: number; nodeName: string } }>(
      session, loc.sessionId, 'DOM.describeNode', { objectId: found.objectId }, signal,
    );
    const rn = await axRoleName(session, loc.sessionId, d.node.backendNodeId, signal);
    const role = !rn.role || rn.role === 'generic' || rn.role === 'none' ? d.node.nodeName.toLowerCase() : rn.role;
    const name = rn.name;
    const loaderId = await currentLoaderId(session, loc, signal);
    const ref = refFor(tabId, {
      backendNodeId: d.node.backendNodeId, frameId: loc.frameId, sessionId: loc.sessionId,
      loaderId, role, name, nth: -1,
    }, { hints: false });
    return {
      tabId, session, frame: loc, backendNodeId: d.node.backendNodeId, objectId: found.objectId,
      ref, role, name,
    };
  }

  throw new ByobError('invalid_argument', 'No target given.', 'Pass ref (from browser_snapshot) or selector.');
}

/** Call a function on the element in byob's isolated world. */
export function callOnElement<T = unknown>(
  h: ElementHandle,
  fn: string,
  args: unknown[] = [],
  signal?: AbortSignal,
  opts: { awaitPromise?: boolean } = {},
): Promise<T> {
  return callFunctionOn<T>(h.session, h.frame.sessionId, h.objectId, fn, args, signal, opts);
}

// ---------------------------------------------------------------------------
// Actionability
// ---------------------------------------------------------------------------

export interface ActionabilityOpts {
  /** Element must receive the pointer at its centre (not covered). */
  hitTest?: boolean;
  enabled?: boolean;
  editable?: boolean;
  /** Skip every check except "has a box"; for deliberate click-through. */
  force?: boolean;
  timeoutMs?: number;
}

export interface ActionPoint {
  /** Tab-viewport coordinates, ready for Input.dispatchMouseEvent. */
  x: number;
  y: number;
  /** Frame-local centre. */
  local: { x: number; y: number };
}

interface ProbeState {
  detached?: boolean;
  visible: boolean;
  disabled: boolean;
  editable: boolean;
  inViewport: boolean;
  stable: boolean;
  hitOk: boolean;
  blocker?: string;
  cx: number;
  cy: number;
}

/** Runs in the isolated world with `this` = the element. */
export const PROBE_FN = `async function (checkHit) {
  const el = this;
  if (!el.isConnected) return { detached: true };
  const frame = () => new Promise((r) => { let d = false; const f = () => { if (!d) { d = true; r(); } };
    requestAnimationFrame(f); setTimeout(f, 50); });
  const box = () => { const r = el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; };
  const a = box();
  await frame();
  const b = box();
  const stable = a.every((v, i) => Math.abs(v - b[i]) < 0.5);
  const cs = getComputedStyle(el);
  const visible = b[2] > 0 && b[3] > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
  let disabled = false;
  if ('disabled' in el && el.disabled) disabled = true;
  const ariaDis = el.closest && el.closest('[aria-disabled="true"]');
  if (ariaDis) disabled = true;
  const fs = el.closest && el.closest('fieldset[disabled]');
  if (fs && !(fs.querySelector('legend') && fs.querySelector('legend').contains(el))) disabled = true;
  const tag = el.tagName;
  let editable = false;
  if (el.isContentEditable) editable = true;
  else if (tag === 'TEXTAREA') editable = !el.readOnly && !el.disabled;
  else if (tag === 'INPUT') {
    const t = (el.type || 'text').toLowerCase();
    const nonText = ['checkbox','radio','button','submit','reset','file','image','hidden','range','color'];
    editable = !nonText.includes(t) && !el.readOnly && !el.disabled;
  }
  const cx = b[0] + b[2] / 2;
  const cy = b[1] + b[3] / 2;
  const inViewport = cx >= 0 && cy >= 0 && cx < innerWidth && cy < innerHeight;
  let hitOk = true;
  let blocker;
  if (checkHit && visible && inViewport) {
    // elementFromPoint is retargeted to the outermost shadow host; drill
    // into open shadow roots to find what is really under the point.
    let top = document.elementFromPoint(cx, cy);
    for (let i = 0; top && top.shadowRoot && i < 32; i++) {
      const inner = top.shadowRoot.elementFromPoint(cx, cy);
      if (!inner || inner === top) break;
      top = inner;
    }
    const owns = (n) => {
      for (let cur = n; cur; cur = cur.parentNode || cur.host) { if (cur === el) return true; }
      return false;
    };
    // A closed shadow root stops the drill at its host, which then counts
    // as a hit if it hosts the element.
    const hostsEl = (n) => {
      for (let r = el.getRootNode(); r && r.host; r = r.host.getRootNode()) { if (r.host === n) return true; }
      return false;
    };
    hitOk = !!top && (owns(top) || hostsEl(top)
      || (top.tagName === 'LABEL' && top.control === el)
      || (el.tagName === 'LABEL' && el.control === top)
      || (el.labels && Array.from(el.labels).some((l) => l === top || l.contains(top))));
    if (!hitOk && top) {
      const cls = typeof top.className === 'string' ? top.className.trim().split(/\\s+/).filter(Boolean).slice(0, 3) : [];
      const text = (top.innerText || top.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 60);
      blocker = '<' + top.tagName.toLowerCase() + (top.id ? '#' + top.id : '') + (cls.length ? '.' + cls.join('.') : '') + '>'
        + (text ? ' "' + text + '"' : '');
    }
  }
  return { visible, disabled, editable, inViewport, stable, hitOk, blocker, cx, cy };
}`;

async function scrollIntoView(h: ElementHandle, signal?: AbortSignal): Promise<void> {
  try {
    await sendTo(h.session, h.frame.sessionId, 'DOM.scrollIntoViewIfNeeded',
      { backendNodeId: h.backendNodeId }, signal);
  } catch (e) {
    if ((e as { name?: string }).name === 'AbortError') throw e;
    if (isStaleNodeError(e)) {
      throw new ByobError('stale_ref', `${describeHandle(h)} was removed from the page.`, SNAPSHOT_HINT);
    }
    // Elements without a layout box (display:none) reject scrolling; the
    // probe below reports them as not visible, which is the useful message.
  }
}

export async function waitActionable(
  h: ElementHandle,
  opts: ActionabilityOpts,
  signal: AbortSignal,
): Promise<ActionPoint> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const deadline = Date.now() + timeoutMs;
  let last: ProbeState | null = null;
  for (let attempt = 0; ; attempt++) {
    throwIfAborted(signal);
    await scrollIntoView(h, signal);
    let st: ProbeState;
    try {
      st = await callOnElement<ProbeState>(h, PROBE_FN, [!opts.force && opts.hitTest !== false], signal, {
        awaitPromise: true,
      });
    } catch (e) {
      if (isStaleNodeError(e) || isContextGoneError(e)) {
        throw new ByobError('stale_ref', `${describeHandle(h)} is no longer in the page.`, SNAPSHOT_HINT);
      }
      throw e;
    }
    if (st.detached) {
      throw new ByobError('stale_ref', `${describeHandle(h)} was removed from the page.`, SNAPSHOT_HINT);
    }
    last = st;
    const ok = opts.force
      ? st.visible
      : st.visible && st.stable && st.inViewport
        && (!opts.enabled || !st.disabled)
        && (!opts.editable || st.editable)
        && (opts.hitTest === false || st.hitOk);
    if (ok) {
      const off = await frameOffset(h.session, h.frame.frameId, signal);
      return {
        x: Math.round(off.x + st.cx),
        y: Math.round(off.y + st.cy),
        local: { x: st.cx, y: st.cy },
      };
    }
    if (Date.now() >= deadline) break;
    await sleepWithSignal(attempt < 3 ? 50 : 150, signal);
  }
  const what = describeHandle(h);
  const s = last!;
  if (!s.visible) {
    throw new ByobError('element_not_visible', `${what} is not visible (zero size, display:none or visibility:hidden).`,
      'It may be inside a collapsed menu or another tab — open it first, or check browser_snapshot.');
  }
  if (opts.enabled && s.disabled) {
    throw new ByobError('element_disabled', `${what} is disabled.`,
      'Fill the required fields or wait for the page to enable it.');
  }
  if (opts.editable && !s.editable) {
    throw new ByobError('element_not_editable', `${what} is not an editable field.`,
      'Target an input, textarea or contenteditable element.');
  }
  if (!s.hitOk) {
    throw new ByobError('element_covered', `${what} is covered by ${s.blocker ?? 'another element'}.`,
      'Close the overlay (cookie banner, modal, sticky header) first, or pass force:true to click through.');
  }
  if (!s.inViewport) {
    throw new ByobError('element_not_visible', `${what} could not be scrolled into the viewport.`);
  }
  throw new ByobError('timeout', `${what} kept moving (animation) for ${timeoutMs}ms.`,
    'Wait for the animation to finish, or pass force:true.');
}

/** Resolve a ref/selector target to a handle, with frame + ref bookkeeping. */
export async function mainFrameLoc(session: CdpSession, signal?: AbortSignal): Promise<FrameLoc> {
  const t = await getFrameTree(session, undefined, signal);
  recordFrame(session.tabId, { frameId: t.frame.id });
  return { frameId: t.frame.id };
}
