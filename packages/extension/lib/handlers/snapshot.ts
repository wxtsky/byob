import { SnapshotInput } from '@byob/shared';
import type { CdpSession } from '../cdp.js';
import { tryAttachToTab } from '../cdp.js';
import { openOrReuse } from '../tab.js';
import { keepAwakeStart, keepAwakeEnd } from '../keepalive.js';
import { isAbortError, throwIfAborted } from '../signal-utils.js';
import { checkUrlAllowed, urlForbiddenError } from '../url-guard.js';
import { attachErrorEnvelope } from '../attach-error.js';
import { COLLECT_INTERACTIVE_SCRIPT, INTERACTIVE_ROLES } from '../clickable-detector.js';
import {
  type ResolvedFrame,
  resolveFrame,
  evaluateInResolvedFrame,
  sendInResolvedFrame,
  frameErrorToEnvelope,
} from '../frame-resolver.js';

function extractAXString(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v || null;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.value === 'string') return o.value || null;
    if (o.value != null && typeof o.value === 'object') {
      const inner = o.value as Record<string, unknown>;
      if (typeof inner.value === 'string') return inner.value || null;
    }
  }
  return null;
}

/** AX property values are `{type, value}`; booleans/numbers arrive unwrapped
 *  in `value`. Render them as a flat scalar string. */
function extractAXScalar(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v || null;
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (o.value === undefined) return null;
    return extractAXScalar(o.value);
  }
  return null;
}

interface RawAXNode {
  nodeId: string;
  ignored?: boolean;
  role?: unknown;
  name?: unknown;
  description?: unknown;
  properties?: Array<{ name: string; value: unknown }>;
  childIds?: string[];
  backendDOMNodeId?: number;
  frameId?: string;
}

// Only roles the in-page collector actually stamps can be resolved back to a
// `[byob:N]`, so the set is imported rather than restated here.
const INTERACTIVE_ROLE_SET = new Set(INTERACTIVE_ROLES);

// Skip — purely structural, never surface and never consume depth. Their
// children are hoisted into the parent so the tree stays shallow.
const STRUCTURAL_ROLES = new Set([
  'generic', 'none', 'presentation', 'LayoutTable', 'LayoutTableCell',
  'LayoutTableRow', 'group', 'InlineTextBox', 'LineBreak',
]);

// Semantic containers — only these consume depth budget. Everything else
// (generic, group, etc.) is transparent so SPA nesting doesn't silently
// truncate the walk.
const CONTAINER_ROLES = new Set([
  'RootWebArea', 'WebArea', 'article', 'section', 'navigation',
  'region', 'main', 'complementary', 'banner', 'contentinfo',
  'form', 'list', 'tablist', 'tabpanel', 'menu', 'menubar',
  'toolbar', 'dialog', 'alertdialog', 'table', 'tree', 'treegrid', 'grid',
]);

// AX exposes ~40 properties per node, most of them constant noise
// (`focusable=true` on every control, `live`/`atomic`/`relevant` on every
// container). Only these change what an agent would do next, so only these
// are rendered. Everything else is dropped — on a busy page this is the
// difference between a 4k-token and a 25k-token snapshot.
const USEFUL_PROPERTIES = new Set([
  'checked', 'disabled', 'expanded', 'pressed', 'selected', 'required',
  'invalid', 'readonly', 'level', 'valuemin', 'valuemax', 'valuetext',
  'haspopup', 'modal', 'multiselectable', 'placeholder', 'roledescription',
  'keyshortcuts', 'url',
]);

// Properties whose default is "off" — rendering `checked=false` on every
// checkbox is noise, so only the truthy state is emitted.
const OMIT_WHEN_FALSE = new Set([
  'disabled', 'expanded', 'pressed', 'selected', 'required',
  'invalid', 'readonly', 'modal', 'multiselectable', 'haspopup',
]);

const NAME_CAP = 200;
/** Total character budget for the rendered tree. Roughly 6k tokens — enough
 *  for any real page view, small enough that a runaway SPA can't blow up the
 *  agent's context. Overflow flips `truncated`. */
const TEXT_BUDGET = 24_000;
/** Cap on how many interactive nodes get a `[byob:N]` tag. Beyond this the
 *  page is a list virtualiser and the agent should scroll/filter instead. */
const MAX_MAPPED_ELEMENTS = 500;
/** Parallel `DOM.getAttributes` calls in flight. Chrome's debugger pipe
 *  handles this comfortably; higher gains little and risks starving other
 *  handlers sharing the session. */
const ATTR_FETCH_CONCURRENCY = 24;

interface SnapshotBuildResult {
  text: string;
  nodeCount: number;
  truncated: boolean;
}

/** One rendered line, before indentation is applied. The raw AX node is kept
 *  rather than its formatted properties because the character budget drops
 *  most of the tree on a big page — formatting eagerly would price thousands
 *  of nodes that never reach the output. */
interface SnapshotNode {
  role: string;
  name: string | null;
  idx: number | undefined;
  raw: RawAXNode;
  children: SnapshotNode[];
}

function quoteName(name: string): string {
  const capped = name.length > NAME_CAP ? name.slice(0, NAME_CAP) + '…' : name;
  return JSON.stringify(capped.replace(/\s+/g, ' ').trim());
}

function renderProps(node: RawAXNode, name: string | null): string {
  if (!node.properties) return '';
  const out: string[] = [];
  for (const p of node.properties) {
    if (!USEFUL_PROPERTIES.has(p.name)) continue;
    const v = extractAXScalar(p.value);
    if (v == null || v === '') continue;
    if (v === 'false' && OMIT_WHEN_FALSE.has(p.name)) continue;
    if (name && v === name) continue;
    if (v.length > 80) continue;
    // Booleans read better bare: `disabled` beats `disabled=true`.
    out.push(v === 'true' ? p.name : `${p.name}=${v}`);
  }
  return out.length > 0 ? ' ' + out.join(' ') : '';
}

/**
 * Build a hierarchical, Playwright-style ARIA snapshot from a raw AX tree.
 *
 * Output is an indented list that preserves containment, which a flat
 * role-grouped listing cannot express — "which of the six `Delete` buttons
 * is inside the confirmation dialog" is answerable here and guesswork there:
 *
 *   - RootWebArea "Inbox":
 *     - navigation:
 *       - link "Archive" [byob:3]
 *     - dialog "Confirm" modal:
 *       - button "Delete" [byob:11]
 *
 * A node is emitted when it has an accessible name, an actionable index, or
 * emitted descendants; everything else collapses away.
 */
export function buildSnapshotText(
  nodes: RawAXNode[],
  idxForNode: (node: RawAXNode) => number | undefined,
  maxDepth: number,
): SnapshotBuildResult {
  const nodeMap = new Map<string, RawAXNode>();
  for (const n of nodes) nodeMap.set(n.nodeId, n);

  const childIdSet = new Set<string>();
  for (const n of nodes) {
    for (const cid of n.childIds ?? []) childIdSet.add(cid);
  }
  const roots = nodes.filter((n) => !childIdSet.has(n.nodeId));

  let truncated = false;
  const visited = new Set<string>();

  // Returns the emitted nodes contributed by this subtree. Structural and
  // unnamed nodes contribute their children directly, which is what keeps
  // deeply-wrapped SPA markup from turning into an indentation staircase.
  function walk(node: RawAXNode, depth: number): SnapshotNode[] {
    if (visited.has(node.nodeId)) return [];
    visited.add(node.nodeId);

    const childrenOf = (d: number): SnapshotNode[] => {
      const out: SnapshotNode[] = [];
      for (const cid of node.childIds ?? []) {
        const c = nodeMap.get(cid);
        if (c) out.push(...walk(c, d));
      }
      return out;
    };

    if (node.ignored) return childrenOf(depth);

    const role = extractAXString(node.role) ?? '?';
    if (STRUCTURAL_ROLES.has(role)) return childrenOf(depth);

    const isContainer = CONTAINER_ROLES.has(role);
    if (isContainer && depth >= maxDepth) {
      truncated = true;
      return [];
    }

    const name = extractAXString(node.name);
    // Unlabelled controls are still actionable. Dropping their index makes a
    // visible icon-only button impossible to target even though the in-page
    // collector resolved the exact DOM node.
    const idx = idxForNode(node);
    const children = childrenOf(isContainer ? depth + 1 : depth);

    // Nothing to say about this node and nothing underneath it.
    if (name == null && idx === undefined && children.length === 0) return [];
    // An anonymous wrapper that only groups children adds an indent level
    // without adding information — hoist its children instead.
    if (name == null && idx === undefined && !isContainer) return children;

    return [{ role, name, idx, raw: node, children }];
  }

  const tree: SnapshotNode[] = [];
  for (const r of roots) tree.push(...walk(r, 0));

  const lines: string[] = [];
  let chars = 0;
  let nodeCount = 0;

  function render(items: SnapshotNode[], indent: string): void {
    for (const item of items) {
      if (chars >= TEXT_BUDGET) {
        truncated = true;
        return;
      }
      const idxTag = item.idx !== undefined ? ` [byob:${item.idx}]` : '';
      const namePart = item.name ? ` ${quoteName(item.name)}` : '';
      const suffix = item.children.length > 0 ? ':' : '';
      const props = renderProps(item.raw, item.name);
      const line = `${indent}- ${item.role}${namePart}${idxTag}${props}${suffix}`;
      lines.push(line);
      chars += line.length + 1;
      nodeCount++;
      render(item.children, indent + '  ');
    }
  }
  render(tree, '');

  if (nodeCount === 0) lines.push('(empty page — no accessible content found)');

  return { text: lines.join('\n'), nodeCount, truncated };
}

/**
 * Map AX `backendDOMNodeId` → the `data-byob-idx` stamped by the in-page
 * collector, so `[byob:N]` tags point at the exact DOM node the AX node came
 * from rather than a role/name guess (pages routinely carry six identical
 * "Edit" buttons).
 *
 * Cost matters here: the obvious per-node `DOM.resolveNode` →
 * `Runtime.callFunctionOn` → `Runtime.releaseObject` sequence is three
 * serial CDP round-trips per element, which on a 300-control page is ~900
 * round-trips and tens of seconds. Instead: one batched
 * `DOM.pushNodesByBackendIdsToFrontend` for every backend id, then
 * `DOM.getAttributes` fanned out in bounded-concurrency chunks.
 */
async function buildBackendIdxMap(
  session: CdpSession,
  frame: ResolvedFrame,
  nodes: RawAXNode[],
  signal: AbortSignal,
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  const backendIds = [...new Set(
    nodes
      .filter((n) => {
        const role = extractAXString(n.role) ?? '';
        return INTERACTIVE_ROLE_SET.has(role);
      })
      .map((n) => n.backendDOMNodeId)
      .filter((v): v is number => typeof v === 'number'),
  )].slice(0, MAX_MAPPED_ELEMENTS);
  if (backendIds.length === 0) return out;

  const send = <T>(method: string, params: Record<string, unknown>): Promise<T> =>
    sendInResolvedFrame<T>(session, frame, method, params, signal);

  // pushNodesByBackendIdsToFrontend only works once the frontend has pulled a
  // document; depth 0 establishes the node-id space without serialising the
  // DOM. `DOM.enable` is deliberately skipped — we consume no DOM events, and
  // enabling would stream them for the life of a session other handlers share.
  await send('DOM.getDocument', { depth: 0 });

  const pushed = await send<{ nodeIds?: number[] }>(
    'DOM.pushNodesByBackendIdsToFrontend',
    { backendNodeIds: backendIds },
  );
  const nodeIds = pushed.nodeIds ?? [];

  for (let i = 0; i < nodeIds.length; i += ATTR_FETCH_CONCURRENCY) {
    throwIfAborted(signal);
    const chunk = nodeIds.slice(i, i + ATTR_FETCH_CONCURRENCY);
    await Promise.all(
      chunk.map(async (nodeId, j) => {
        if (!nodeId) return; // 0 = the node is gone since the AX walk
        try {
          const res = await send<{ attributes?: string[] }>('DOM.getAttributes', { nodeId });
          const attrs = res.attributes ?? [];
          // Flat [name, value, name, value, ...] pairs.
          for (let k = 0; k + 1 < attrs.length; k += 2) {
            if (attrs[k] !== 'data-byob-idx') continue;
            const idx = Number(attrs[k + 1]);
            if (Number.isInteger(idx)) out.set(backendIds[i + j]!, idx);
            break;
          }
        } catch (e) {
          if (isAbortError(e)) throw e;
          // DOM shifts between AX collection and attribute read; skip stale nodes.
        }
      }),
    );
  }
  return out;
}

export async function handleSnapshot(
  rawParams: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const params = SnapshotInput.parse(rawParams);
  if (params.url) {
    const guard = checkUrlAllowed(params.url);
    if (!guard.ok) return urlForbiddenError(guard.reason);
  }
  throwIfAborted(signal);

  const tab = await openOrReuse({
    url: params.url,
    tabId: params.tabId,
    reuseActive: !params.url && params.tabId === undefined,
    signal,
  });

  const attachResult = await tryAttachToTab(tab.tabId, signal);
  const { session } = attachResult;
  if (!session) {
    if (!tab.reused) await tab.cleanup();
    return attachErrorEnvelope(attachResult);
  }

  let frame: ResolvedFrame;
  try {
    frame = await resolveFrame(session, params.framePath, signal);
  } catch (e) {
    if (!tab.reused) await tab.cleanup();
    const env = frameErrorToEnvelope(e);
    if (env) return env;
    throw e;
  }

  keepAwakeStart();
  try {
    await sendInResolvedFrame(session, frame, 'Accessibility.enable', {}, signal);

    // `frameId` is important for framePath; CDP otherwise scopes the result
    // to the root frame. `depth` is deliberately NOT passed: CDP counts every
    // raw AX level, and real pages nest 20-40 of them, so forwarding our
    // semantic maxDepth here would cut the tree off inside the page chrome.
    // Depth is applied in the walker, where only semantic containers count.
    const raw = await sendInResolvedFrame<{ nodes: RawAXNode[] }>(
      session,
      frame,
      'Accessibility.getFullAXTree',
      { frameId: frame.frameId },
      signal,
    );
    const nodes = raw.nodes ?? [];

    // Run the collector purely for its side effect: it stamps matching DOM
    // nodes with data-byob-idx. We then resolve AX backendDOMNodeId → real
    // DOM node, avoiding role/name guesses that break on duplicate labels.
    // Only the session tag is pulled back across the debugger pipe — the
    // element array would be ~56k characters on a page like a GitHub repo,
    // and the tags are already inline in the snapshot text.
    let interactiveSessionTag: string | undefined;

    try {
      const tag = await evaluateInResolvedFrame<unknown>(
        session,
        frame,
        `(${COLLECT_INTERACTIVE_SCRIPT}).sessionTag`,
        { awaitPromise: false, signal },
      );
      if (typeof tag === 'string') interactiveSessionTag = tag;
    } catch { /* collector failure is non-fatal */ }

    let idxByBackend = new Map<number, number>();
    try {
      idxByBackend = await buildBackendIdxMap(session, frame, nodes, signal);
    } catch (e) {
      if (isAbortError(e)) throw e;
      // Backend mapping is an enhancement; snapshot text still works without it.
    }

    const built = buildSnapshotText(
      nodes,
      (node) =>
        typeof node.backendDOMNodeId === 'number'
          ? idxByBackend.get(node.backendDOMNodeId)
          : undefined,
      params.maxDepth,
    );

    const tabInfo = await chrome.tabs.get(tab.tabId);

    return {
      text: built.text,
      tabId: tab.tabId,
      url: tabInfo.url ?? params.url ?? '',
      title: tabInfo.title ?? '',
      nodeCount: built.nodeCount,
      truncated: built.truncated,
      ...(interactiveSessionTag ? { interactiveSessionTag } : {}),
    };
  } finally {
    try {
      await sendInResolvedFrame(session, frame, 'Accessibility.disable', {});
    } catch {
      // Never enabled, already detached, or tab closed — all best-effort.
    }
    keepAwakeEnd();
    if (!tab.reused) {
      await session.detach();
      await tab.cleanup();
    }
  }
}
