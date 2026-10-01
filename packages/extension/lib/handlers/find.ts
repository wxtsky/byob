/**
 * browser_find — semantic locators (role/name, text, label, placeholder, alt,
 * title, test id). Matches get refs, so the next call can act on them; with
 * `action`, the nth match is acted on immediately (one round trip instead of
 * snapshot → read → click).
 */
import { Tools } from '@byob/shared';
import type { CdpSession } from '../cdp.js';
import { ByobError } from '../errors.js';
import { refFor } from '../refs.js';
import { callOnElement, mainFrameLoc, resolveFramePath, resolveTarget, type ElementHandle } from '../dom/element.js';
import {
  currentLoaderId,
  evaluateIsolated,
  findInTree,
  getFrameTree,
  oopifSession,
  recordFrame,
  sendTo,
  type FrameLoc,
} from '../dom/frames.js';
import { sleepWithSignal } from '../signal-utils.js';
import { checkFrameUrlAllowed } from '../url-guard.js';
import { attach, pickTab } from './_common.js';
import { handleClick, handleHover } from './click.js';
import { handleType } from './type.js';
import { snapshotAfter } from './snapshot.js';

interface Match {
  ref: string;
  role: string;
  name: string;
  backendNodeId: number;
}

export const DOM_FIND_FN = `function (kind, needle, exact, limit) {
  const root = this && this.nodeType ? this : document;
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const eq = (hay) => {
    const h = norm(hay);
    if (!h) return false;
    return exact ? h === needle : h.toLowerCase().includes(needle.toLowerCase());
  };
  const visible = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const roots = [root];
  const collectRoots = (r) => {
    const all = r.querySelectorAll ? r.querySelectorAll('*') : [];
    for (const el of all) if (el.shadowRoot) { roots.push(el.shadowRoot); collectRoots(el.shadowRoot); }
  };
  collectRoots(root);
  const out = [];
  const push = (el) => { if (el && !out.includes(el) && visible(el)) out.push(el); };
  const byAttr = (attr) => {
    for (const r of roots) for (const el of r.querySelectorAll('[' + attr + ']')) {
      if (eq(el.getAttribute(attr))) push(el);
      if (out.length >= limit) return;
    }
  };
  const promote = (el) => {
    // Text usually sits in a <span> inside the control; act on the control.
    const c = el.closest('a,button,summary,label,[role=button],[role=link],[role=menuitem],[role=tab],[role=option],[role=checkbox],[role=radio],[role=switch],[onclick]');
    if (c) {
      let depth = 0;
      for (let n = el; n && n !== c; n = n.parentElement) depth++;
      if (depth <= 4) return c;
    }
    // Otherwise the outermost cursor:pointer box within a few levels (a card
    // div with a click listener).
    for (let n = el, i = 0; n && n !== document.body && i <= 4; n = n.parentElement, i++) {
      const pe = n.parentElement;
      if (getComputedStyle(n).cursor === 'pointer' && (!pe || getComputedStyle(pe).cursor !== 'pointer')) return n;
    }
    return el;
  };
  if (kind === 'text') {
    for (const r of roots) {
      const w = document.createTreeWalker(r, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n && out.length < limit; n = w.nextNode()) {
        const own = norm(n.nodeValue);
        if (!own) continue;
        const p = n.parentElement;
        if (!p || p.closest('script,style,noscript,template')) continue;
        if (eq(own)) { push(promote(p)); continue; }
        // The phrase may span several text nodes ("Hello <b>world</b>"):
        // climb a few levels to the smallest element that contains it all.
        if (!needle.toLowerCase().includes(own.toLowerCase())) continue;
        let a = p;
        for (let i = 0; i < 4 && a && a !== document.body; i++, a = a.parentElement) {
          if (eq(a.innerText)) { push(promote(a)); break; }
        }
      }
    }
  } else if (kind === 'label') {
    for (const r of roots) for (const l of r.querySelectorAll('label')) {
      if (eq(l.innerText)) push(l.control || l);
    }
    byAttr('aria-label');
    for (const r of roots) for (const el of r.querySelectorAll('[aria-labelledby]')) {
      const txt = el.getAttribute('aria-labelledby').split(/\\s+/).map((id) => { const x = document.getElementById(id); return x ? x.innerText : ''; }).join(' ');
      if (eq(txt)) push(el);
    }
  } else if (kind === 'testId') {
    for (const a of ['data-testid', 'data-test-id', 'data-test', 'data-qa']) byAttr(a);
  } else {
    byAttr(kind);
  }
  return out.slice(0, limit);
}`;

async function backendIdsOf(session: CdpSession, loc: FrameLoc, arrayObjectId: string, signal: AbortSignal): Promise<Array<{ id: number; tag: string }>> {
  const props = await sendTo<{ result: Array<{ name: string; value?: { objectId?: string } }> }>(
    session, loc.sessionId, 'Runtime.getProperties', { objectId: arrayObjectId, ownProperties: true }, signal,
  );
  const ids: Array<{ id: number; tag: string }> = [];
  for (const pr of props.result) {
    if (!/^\d+$/.test(pr.name) || !pr.value?.objectId) continue;
    const d = await sendTo<{ node: { backendNodeId: number; nodeName: string } }>(
      session, loc.sessionId, 'DOM.describeNode', { objectId: pr.value.objectId }, signal,
    );
    ids.push({ id: d.node.backendNodeId, tag: d.node.nodeName.toLowerCase() });
  }
  return ids;
}

async function roleName(session: CdpSession, loc: FrameLoc, backendNodeId: number, signal: AbortSignal): Promise<{ role: string; name: string }> {
  try {
    const r = await sendTo<{ nodes: Array<{ ignored?: boolean; role?: { value?: string }; name?: { value?: string } }> }>(
      session, loc.sessionId, 'Accessibility.getPartialAXTree', { backendNodeId, fetchRelatives: false }, signal,
    );
    const n = r.nodes.find((x) => !x.ignored) ?? r.nodes[0];
    return { role: n?.role?.value ?? '', name: (n?.name?.value ?? '').replace(/\s+/g, ' ').trim() };
  } catch {
    return { role: '', name: '' };
  }
}

/** `within` names an <iframe>: search that frame's document instead. */
async function enterIframe(session: CdpSession, el: ElementHandle, signal: AbortSignal): Promise<FrameLoc | null> {
  const d = await sendTo<{ node: { nodeName: string; frameId?: string; contentDocument?: { frameId?: string } } }>(
    session, el.frame.sessionId, 'DOM.describeNode', { backendNodeId: el.backendNodeId }, signal,
  );
  const tag = d.node.nodeName.toLowerCase();
  if (tag !== 'iframe' && tag !== 'frame') return null;
  const frameId = d.node.frameId ?? d.node.contentDocument?.frameId;
  if (!frameId) throw new ByobError('frame_not_found', `${el.ref} is an iframe with no loaded document.`, undefined, { reason: 'frame_blank' });
  const sessionId = oopifSession(session.tabId, frameId) ?? el.frame.sessionId;
  const tree = await getFrameTree(session, sessionId, signal).catch(() => null);
  const ok = checkFrameUrlAllowed(tree ? findInTree(tree, frameId)?.frame.url : undefined);
  if (!ok.ok) throw new ByobError('url_forbidden', `${el.ref}: ${ok.reason}`, "This frame is blocked by the user's byob site policy.");
  recordFrame(session.tabId, { frameId, sessionId, parentFrameId: el.frame.frameId, ownerBackendNodeId: el.backendNodeId });
  return { frameId, sessionId };
}

/** Reads the checked state of a checkbox / radio / switch, looking through
 *  a <label> or wrapper to the control it stands for. */
export const CHECKED_STATE_FN = `function () {
  let el = this;
  const isBox = (n) => 'checked' in n && (n.type === 'checkbox' || n.type === 'radio');
  const hasAria = (n) => n.getAttribute('aria-checked') !== null || n.getAttribute('aria-pressed') !== null;
  if (el.tagName === 'LABEL' && el.control) el = el.control;
  else if (!isBox(el) && !hasAria(el)) {
    const inner = el.querySelector('input[type=checkbox],input[type=radio],[role=checkbox],[role=radio],[role=switch],[aria-checked]');
    if (inner) el = inner;
  }
  if (isBox(el)) return el.checked;
  const a = el.getAttribute('aria-checked') ?? el.getAttribute('aria-pressed');
  return a === null ? null : a === 'true';
}`;

export async function handleFind(raw: unknown, signal: AbortSignal): Promise<unknown> {
  const p = Tools.FindInput.parse(raw);
  if (p.within !== undefined && p.framePath !== undefined) {
    throw new ByobError('invalid_argument', 'browser_find: pass within or framePath, not both.');
  }
  const tabId = await pickTab({ tabId: p.tabId, ref: p.within });
  const session = await attach(tabId, signal, 'find');
  // Acting on match #nth needs at least nth+1 matches, whatever limit says.
  const limit = p.action ? Math.max(p.limit, p.nth + 1) : p.limit;

  let loc: FrameLoc;
  let within: ElementHandle | undefined;
  /** The searched frame is not its session's root document. */
  let subframe = false;
  if (p.within) {
    within = await resolveTarget(session, { ref: p.within }, signal);
    loc = within.frame;
    const inner = await enterIframe(session, within, signal);
    if (inner) {
      loc = inner;
      within = undefined;
      subframe = true;
    }
  } else if (p.framePath?.length) {
    loc = await resolveFramePath(session, p.framePath, signal);
    subframe = true;
  } else {
    loc = await mainFrameLoc(session, signal);
  }
  const loaderId = await currentLoaderId(session, loc, signal);
  // find counts duplicates only among its own matches, so it never supplies
  // relocation hints (see refs.ts).
  const mint = (backendNodeId: number, role: string, name: string, nth: number): string =>
    refFor(tabId, { backendNodeId, frameId: loc.frameId, sessionId: loc.sessionId, loaderId, role, name, nth }, { hints: false });

  const kinds = (['text', 'label', 'placeholder', 'alt', 'title', 'testId'] as const).filter((k) => p[k] !== undefined);
  if (!p.role && kinds.length === 0) {
    throw new ByobError('invalid_argument', 'browser_find: pass role (+name), text, label, placeholder, alt, title or testId.');
  }
  if (kinds.length > 1 || (p.role && kinds.length)) {
    throw new ByobError('invalid_argument', 'browser_find: use one locator kind per call (role+name counts as one).');
  }

  const matches: Match[] = [];
  if (p.role) {
    const params: Record<string, unknown> = { role: p.role };
    if (within) params.backendNodeId = within.backendNodeId;
    else if (subframe) {
      // DOM.getDocument would return the session's top document; query from
      // this frame's own document node instead.
      const doc = await evaluateIsolated(session, loc, 'document', { returnByValue: false, signal });
      if (!doc.objectId) throw new ByobError('frame_not_found', 'The frame has no document.');
      params.objectId = doc.objectId;
    } else {
      const doc = await sendTo<{ root: { nodeId: number } }>(session, loc.sessionId, 'DOM.getDocument', { depth: 0 }, signal);
      params.nodeId = doc.root.nodeId;
    }
    if (p.name !== undefined && p.exact) params.accessibleName = p.name;
    const q = await sendTo<{ nodes: Array<{ ignored?: boolean; backendDOMNodeId?: number; name?: { value?: string }; role?: { value?: string } }> }>(
      session, loc.sessionId, 'Accessibility.queryAXTree', params, signal,
    );
    const needle = (p.name ?? '').toLowerCase();
    const seen = new Map<string, number>();
    for (const n of q.nodes) {
      if (n.ignored || n.backendDOMNodeId === undefined) continue;
      const name = (n.name?.value ?? '').replace(/\s+/g, ' ').trim();
      if (p.name !== undefined && !p.exact && !name.toLowerCase().includes(needle)) continue;
      const role = n.role?.value ?? p.role;
      const key = `${role}\u0000${name}`;
      const nth = seen.get(key) ?? 0;
      seen.set(key, nth + 1);
      matches.push({ ref: mint(n.backendDOMNodeId, role, name, nth), role, name, backendNodeId: n.backendDOMNodeId });
      if (matches.length >= limit) break;
    }
  } else {
    const kind = kinds[0]!;
    const needle = String(p[kind]).replace(/\s+/g, ' ').trim();
    const args = [kind === 'testId' ? 'testId' : kind, needle, p.exact, limit];
    let arr: { objectId?: string };
    if (within) {
      const r = await sendTo<{ result: { objectId?: string } }>(session, loc.sessionId, 'Runtime.callFunctionOn', {
        objectId: within.objectId, functionDeclaration: DOM_FIND_FN, arguments: args.map((value) => ({ value })), returnByValue: false,
      }, signal);
      arr = r.result;
    } else {
      arr = await evaluateIsolated(session, loc, `(${DOM_FIND_FN}).call(document, ${args.map((a) => JSON.stringify(a)).join(', ')})`, {
        returnByValue: false, signal,
      });
    }
    const ids = arr.objectId ? await backendIdsOf(session, loc, arr.objectId, signal) : [];
    const seen = new Map<string, number>();
    for (const { id, tag } of ids) {
      const rn = await roleName(session, loc, id, signal);
      const role = !rn.role || rn.role === 'none' || rn.role === 'generic' ? tag : rn.role;
      const name = rn.name;
      const key = `${role}\u0000${name}`;
      const nth = seen.get(key) ?? 0;
      seen.set(key, nth + 1);
      matches.push({ ref: mint(id, role, name, nth), role, name, backendNodeId: id });
    }
  }

  const base = { tabId, matches: matches.map(({ ref, role, name }) => ({ ref, role, name })) };
  if (!p.action) return base;
  const target = matches[p.nth];
  if (!target) {
    throw new ByobError('selector_not_found',
      matches.length ? `Only ${matches.length} match(es); nth=${p.nth} is out of range.` : 'No element matched.',
      'Loosen the locator (exact:false), or use browser_snapshot to see what is on the page.');
  }
  const common = { tabId, ref: target.ref, snapshot: p.snapshot };
  let acted: Record<string, unknown>;
  switch (p.action) {
    case 'click':
      acted = (await handleClick(common, signal)) as Record<string, unknown>;
      break;
    case 'hover':
      acted = (await handleHover(common, signal)) as Record<string, unknown>;
      break;
    case 'fill':
      if (p.value === undefined) throw new ByobError('invalid_argument', 'browser_find action "fill" needs value.');
      acted = (await handleType({ ...common, text: p.value }, signal)) as Record<string, unknown>;
      break;
    case 'focus': {
      const el = await resolveTarget(session, { ref: target.ref }, signal);
      await callOnElement(el, 'function () { this.focus(); }', [], signal);
      acted = { tabId, summary: `Focused ${target.role} "${target.name}" [ref=${target.ref}]`, effects: {} };
      break;
    }
    case 'check':
    case 'uncheck': {
      const el = await resolveTarget(session, { ref: target.ref }, signal);
      const state = await callOnElement<boolean | null>(el, CHECKED_STATE_FN, [], signal);
      const want = p.action === 'check';
      const label = `${target.role} "${target.name}" [ref=${target.ref}]`;
      if (state === want) {
        acted = { tabId, summary: `${label} was already ${want ? 'checked' : 'unchecked'}`, effects: {} };
        break;
      }
      acted = (await handleClick(common, signal)) as Record<string, unknown>;
      // Verify: a click toggles, so a wrong guess about the starting state
      // (or a radio, which a click never unchecks) would do the opposite.
      let now: boolean | null = null;
      for (let i = 0; i < 10; i++) {
        now = await callOnElement<boolean | null>(el, CHECKED_STATE_FN, [], signal).catch(() => null);
        if (now === null || now === want) break;
        await sleepWithSignal(50, signal);
      }
      if (now !== null && now !== want) {
        throw new ByobError('invalid_argument', `Clicked ${label}, but it is still ${now ? 'checked' : 'unchecked'}.`,
          want ? 'The page may toggle it some other way — check with browser_snapshot.'
            : 'A radio button cannot be unchecked by clicking it; select another option instead.');
      }
      break;
    }
  }
  return { ...acted!, matches: base.matches };
}

export { snapshotAfter };
