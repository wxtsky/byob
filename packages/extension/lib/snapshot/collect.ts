/**
 * Collect everything buildSnapshot needs from a live tab:
 *   - the AX tree of the main frame (or a scoped frame) and of iframes,
 *     following out-of-process iframes onto their own CDP sessions;
 *   - DOM-level "clickable" elements the AX tree calls generic, from one
 *     DOMSnapshot.captureSnapshot per session: Chrome's own isClickable flag
 *     (it sees addEventListener('click') handlers, which page JS can't) plus
 *     non-inherited cursor:pointer, tabindex ≥ 0 and contenteditable;
 *   - credential-like inputs whose values must be redacted.
 * Nothing is written to the page.
 */
import type { CdpSession } from '../cdp.js';
import { SENSITIVE_FIELD_RE } from '../sensitive.js';
import { type FrameLoc, getFrameTree, findInTree, oopifSession, recordFrame, sendTo } from '../dom/frames.js';
import type { FrameAX, RawAXNode } from './build.js';

export interface CollectedFrame extends FrameAX {
  loc: FrameLoc;
  loaderId?: string;
}

interface DomSnapshotDoc {
  frameId: number;
  nodes: {
    parentIndex?: number[];
    nodeType?: number[];
    nodeName?: number[];
    backendNodeId?: number[];
    attributes?: number[][];
    isClickable?: { index: number[] };
  };
  layout: {
    nodeIndex: number[];
    styles: number[][];
    bounds: number[][];
  };
}

interface DomSnapshot {
  documents: DomSnapshotDoc[];
  strings: string[];
}

interface DomSignals {
  clickable: Set<number>;
  sensitive: Set<number>;
  editable: Set<number>;
}

const MAX_FRAMES = 12;
const MAX_FRAME_DEPTH = 3;
const SKIP_TAGS = new Set(['HTML', 'BODY', 'svg', 'SVG', 'path', 'PATH']);

/** Per-session DOMSnapshot, keyed by frameId string → sets. */
async function domSignals(
  session: CdpSession,
  sessionId: string | undefined,
  signal?: AbortSignal,
): Promise<Map<string, DomSignals>> {
  const out = new Map<string, DomSignals>();
  let snap: DomSnapshot;
  try {
    snap = await sendTo<DomSnapshot>(session, sessionId, 'DOMSnapshot.captureSnapshot', {
      computedStyles: ['cursor', 'visibility', 'opacity', 'pointer-events'],
      includeDOMRects: false,
      includePaintOrder: false,
    }, signal);
  } catch (e) {
    if ((e as { name?: string }).name === 'AbortError') throw e;
    return out; // DOMSnapshot unavailable → AX-only snapshot, still useful
  }
  const S = snap.strings;
  for (const doc of snap.documents) {
    const frameId = S[doc.frameId] ?? '';
    const nodes = doc.nodes;
    const count = nodes.backendNodeId?.length ?? 0;
    const parent = nodes.parentIndex ?? [];
    const pointer = new Uint8Array(count);
    const hasBox = new Uint8Array(count);
    for (let li = 0; li < doc.layout.nodeIndex.length; li++) {
      const ni = doc.layout.nodeIndex[li]!;
      const b = doc.layout.bounds[li];
      const st = doc.layout.styles[li] ?? [];
      const style = (k: number): string => (st[k] !== undefined ? S[st[k]!] ?? '' : '');
      // Laid out but not actually usable: hidden dropdowns, faded-out
      // menus, click-through overlays.
      const usable = style(1) !== 'hidden' && style(1) !== 'collapse' && style(2) !== '0' && style(3) !== 'none';
      if (b && b[2]! > 0 && b[3]! > 0 && usable) hasBox[ni] = 1;
      if (style(0) === 'pointer') pointer[ni] = 1;
    }
    const clickableIdx = new Set(nodes.isClickable?.index ?? []);
    const clickable = new Set<number>();
    const sensitive = new Set<number>();
    const editable = new Set<number>();
    for (let i = 0; i < count; i++) {
      if (nodes.nodeType?.[i] !== 1) continue;
      const tag = S[nodes.nodeName?.[i] ?? -1] ?? '';
      const attrs = nodes.attributes?.[i] ?? [];
      const attr = (name: string): string | undefined => {
        for (let k = 0; k + 1 < attrs.length; k += 2) if (S[attrs[k]!] === name) return S[attrs[k + 1]!];
        return undefined;
      };
      const backend = nodes.backendNodeId![i]!;
      if (tag === 'INPUT' || tag === 'TEXTAREA') {
        const type = (attr('type') ?? '').toLowerCase();
        const probe = ['name', 'id', 'autocomplete', 'aria-label', 'placeholder', 'title']
          .map(attr).filter(Boolean).join(' ');
        if (type === 'password' || type === 'email' || type === 'tel' || attr('autocomplete') === 'one-time-code'
          || SENSITIVE_FIELD_RE.test(probe)) {
          sensitive.add(backend);
        }
      }
      if (!hasBox[i] || SKIP_TAGS.has(tag)) continue;
      // Labels forward clicks to their control, which is listed itself.
      if (tag === 'LABEL') continue;
      const p = parent[i] ?? -1;
      const inheritedPointer = p >= 0 && pointer[p] === 1;
      const ti = attr('tabindex');
      const ce = attr('contenteditable');
      if (ce !== undefined && ce !== 'false') editable.add(backend);
      if (
        clickableIdx.has(i) ||
        (pointer[i] && !inheritedPointer) ||
        (ti !== undefined && Number(ti) >= 0) ||
        (ce !== undefined && ce !== 'false')
      ) {
        clickable.add(backend);
      }
    }
    out.set(frameId, { clickable, sensitive, editable });
  }
  return out;
}

async function axTree(
  session: CdpSession,
  loc: FrameLoc,
  signal?: AbortSignal,
): Promise<RawAXNode[]> {
  await sendTo(session, loc.sessionId, 'Accessibility.enable', {}, signal).catch(() => {});
  const r = await sendTo<{ nodes: RawAXNode[] }>(
    session, loc.sessionId, 'Accessibility.getFullAXTree', { frameId: loc.frameId }, signal,
  );
  return r.nodes ?? [];
}

export async function collectSnapshot(
  session: CdpSession,
  start: FrameLoc,
  signal?: AbortSignal,
): Promise<CollectedFrame> {
  const tabId = session.tabId;
  const signalsBySession = new Map<string, Map<string, DomSignals>>();
  let frames = 0;

  const signalsFor = async (loc: FrameLoc) => {
    const key = loc.sessionId ?? '';
    let m = signalsBySession.get(key);
    if (!m) {
      m = await domSignals(session, loc.sessionId, signal);
      signalsBySession.set(key, m);
    }
    return m.get(loc.frameId) ?? { clickable: new Set<number>(), sensitive: new Set<number>(), editable: new Set<number>() };
  };

  const loaderOf = async (loc: FrameLoc): Promise<string | undefined> => {
    try {
      const t = await getFrameTree(session, loc.sessionId, signal);
      return findInTree(t, loc.frameId)?.frame.loaderId;
    } catch {
      return undefined;
    }
  };

  const collectFrame = async (loc: FrameLoc, depth: number): Promise<CollectedFrame> => {
    frames++;
    const [nodes, sig, loaderId] = await Promise.all([axTree(session, loc, signal), signalsFor(loc), loaderOf(loc)]);
    const frame: CollectedFrame = {
      key: `${loc.sessionId ?? ''}|${loc.frameId}`,
      loc,
      loaderId,
      nodes,
      clickable: sig.clickable,
      sensitive: sig.sensitive,
      editable: sig.editable,
      children: new Map(),
    };
    if (depth >= MAX_FRAME_DEPTH) return frame;
    // Same-process iframe content is not part of the parent's AX tree; each
    // iframe is fetched separately and spliced in under its <iframe> node.
    for (const n of nodes) {
      if (frames >= MAX_FRAMES) break;
      const role = (n.role?.value as string | undefined) ?? '';
      if (role !== 'Iframe' || n.ignored || n.backendDOMNodeId === undefined) continue;
      if ((n.childIds?.length ?? 0) > 0) continue; // content already inline
      try {
        const d = await sendTo<{ node: { frameId?: string; contentDocument?: { frameId?: string } } }>(
          session, loc.sessionId, 'DOM.describeNode', { backendNodeId: n.backendDOMNodeId }, signal,
        );
        const childFrameId = d.node.frameId ?? d.node.contentDocument?.frameId;
        if (!childFrameId) continue;
        const childLoc: FrameLoc = {
          frameId: childFrameId,
          sessionId: oopifSession(tabId, childFrameId) ?? loc.sessionId,
        };
        recordFrame(tabId, {
          ...childLoc,
          parentFrameId: loc.frameId,
          ownerBackendNodeId: n.backendDOMNodeId,
        });
        const child = await collectFrame(childLoc, depth + 1);
        frame.children.set(n.backendDOMNodeId, child);
      } catch (e) {
        if ((e as { name?: string }).name === 'AbortError') throw e;
        // Cross-origin iframe still loading, or detached mid-walk — skip it.
      }
    }
    return frame;
  };

  return collectFrame(start, 0);
}

/** Flatten for ref minting: key → CollectedFrame. */
export function framesByKey(root: CollectedFrame): Map<string, CollectedFrame> {
  const out = new Map<string, CollectedFrame>();
  const visit = (f: CollectedFrame): void => {
    out.set(f.key, f);
    for (const c of f.children.values()) visit(c as CollectedFrame);
  };
  visit(root);
  return out;
}
