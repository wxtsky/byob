/**
 * Pure accessibility-snapshot renderer (no chrome.* / CDP — unit tested).
 *
 * Input: raw AX trees for the main frame and any expanded iframes, plus the
 * backend ids of "clickable" DOM nodes that the AX tree calls generic (divs
 * with click handlers or cursor:pointer). Output: a compact indented outline
 *
 *   - navigation "Primary":
 *     - link "Home" [ref=e1]
 *   - heading "Checkout" [level=1]
 *   - textbox "Email" [ref=e2, required]
 *   - clickable "Continue" [ref=e3]
 *   - iframe "Payment" [ref=e4]:
 *     - textbox "Card number" [ref=e5]
 *
 * Interactive nodes get a ref via the `assignRef` callback, which is where
 * the caller binds refs to backend node ids.
 */

export interface RawAXNode {
  nodeId: string;
  ignored?: boolean;
  role?: { value?: unknown };
  name?: { value?: unknown };
  value?: { value?: unknown };
  properties?: Array<{ name: string; value: { value?: unknown } }>;
  childIds?: string[];
  backendDOMNodeId?: number;
}

export interface FrameAX {
  /** Opaque id of this frame for the ref callback. */
  key: string;
  nodes: RawAXNode[];
  /** Backend ids of DOM-clickable elements (see collect.ts). */
  clickable: Set<number>;
  /** Backend ids of credential-like inputs whose value must not be shown. */
  sensitive: Set<number>;
  /** Backend ids of contenteditable roots (rendered as textboxes). */
  editable?: Set<number>;
  /** Iframe backend id → the expanded child frame. */
  children: Map<number, FrameAX>;
}

export interface BuildOptions {
  /** Only interactive elements, headings and the containers around them. */
  interactive?: boolean;
  /** Semantic container nesting limit. */
  maxDepth?: number;
  /** Character budget for the rendered text. */
  maxChars?: number;
  /** Render only the subtree rooted at this backend node (main frame). */
  scopeBackendId?: number;
}

export interface BuildResult {
  text: string;
  lines: string[];
  nodeCount: number;
  refCount: number;
  truncated: boolean;
}

export type AssignRef = (
  frame: FrameAX,
  node: RawAXNode,
  role: string,
  name: string,
  nth: number,
) => string | undefined;

export const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'option', 'treeitem', 'combobox', 'textbox', 'searchbox', 'slider',
  'spinbutton', 'listbox', 'gridcell', 'columnheader', 'rowheader', 'Iframe', 'DisclosureTriangle',
  'ToggleButton', 'PopUpButton', 'MenuListPopup', 'textField', 'SearchBox',
]);

/** Purely structural — never rendered; their children are hoisted. */
const STRUCTURAL = new Set([
  'generic', 'none', 'presentation', 'LayoutTable', 'LayoutTableCell', 'LayoutTableRow',
  'InlineTextBox', 'LineBreak', 'RootWebArea', 'WebArea', 'Section', 'group', 'Pre',
  'LabelText', 'Canvas', 'Div', 'Unknown', 'Abbr', 'Ruby', 'strong', 'emphasis', 'Mark',
  'subscript', 'superscript', 'time', 'code', 'deletion', 'insertion', 'Legend',
]);

/** Only these consume depth budget. */
const CONTAINERS = new Set([
  'article', 'section', 'navigation', 'region', 'main', 'complementary', 'banner', 'contentinfo',
  'form', 'list', 'tablist', 'tabpanel', 'menu', 'menubar', 'toolbar', 'dialog', 'alertdialog',
  'table', 'tree', 'treegrid', 'grid', 'search', 'listitem', 'row', 'figure', 'Iframe',
]);

/** Kept in interactive mode when they contain something interactive. */
const LANDMARKS = new Set([
  'navigation', 'main', 'banner', 'contentinfo', 'complementary', 'form', 'search', 'region',
  'dialog', 'alertdialog', 'menu', 'menubar', 'tablist', 'toolbar', 'Iframe', 'table', 'grid',
  'tree', 'listbox',
]);

const DISPLAY_ROLE: Record<string, string> = { Iframe: 'iframe' };
const TEXT_ROLES = new Set(['StaticText', 'text']);
const VALUE_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider', 'textField', 'SearchBox']);

const USEFUL_PROPS = new Set([
  'checked', 'disabled', 'expanded', 'pressed', 'selected', 'required', 'invalid', 'readonly',
  'level', 'valuemin', 'valuemax', 'haspopup', 'modal', 'multiselectable', 'focused',
]);
const OMIT_FALSE = new Set([
  'disabled', 'expanded', 'pressed', 'selected', 'required', 'invalid', 'readonly', 'modal',
  'multiselectable', 'haspopup', 'focused',
]);

const NAME_CAP = 150;
const TEXT_CAP = 300;
const MAX_REFS = 800;

function str(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object' && 'value' in (v as object)) return str((v as { value: unknown }).value);
  return null;
}

function clean(s: string, cap: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > cap ? t.slice(0, cap) + '…' : t;
}

function q(s: string): string {
  return JSON.stringify(s);
}

interface Item {
  role: string;
  name: string;
  ref?: string;
  attrs: string[];
  /** Plain text line (StaticText) — rendered as `- text: "…"`. */
  text?: boolean;
  interactive: boolean;
  children: Item[];
}

export function buildSnapshot(root: FrameAX, assignRef: AssignRef, opts: BuildOptions = {}): BuildResult {
  const maxDepth = opts.maxDepth ?? 12;
  const maxChars = opts.maxChars ?? 24_000;
  let truncated = false;
  let refCount = 0;

  function walkFrame(frame: FrameAX, startBackendId: number | undefined, depth: number): Item[] {
    const byId = new Map<string, RawAXNode>();
    const child = new Set<string>();
    for (const n of frame.nodes) {
      byId.set(n.nodeId, n);
      for (const c of n.childIds ?? []) child.add(c);
    }
    const byBackend = new Map<number, RawAXNode>();
    for (const n of frame.nodes) if (n.backendDOMNodeId !== undefined) byBackend.set(n.backendDOMNodeId, n);

    const seen = new Map<string, number>();
    const visited = new Set<string>();

    const collectText = (n: RawAXNode, out: string[], guard = 0): void => {
      if (guard > 50 || out.join(' ').length > NAME_CAP) return;
      const r = str(n.role?.value);
      if (r && TEXT_ROLES.has(r)) {
        const t = str(n.name?.value);
        if (t) out.push(t);
        return;
      }
      for (const c of n.childIds ?? []) {
        const cn = byId.get(c);
        if (cn) collectText(cn, out, guard + 1);
      }
    };

    const textOf = (n: RawAXNode): string | null => {
      const parts: string[] = [];
      collectText(n, parts);
      return parts.length ? parts.join(' ') : null;
    };

    const walk = (n: RawAXNode, d: number, noRef = false): Item[] => {
      if (visited.has(n.nodeId)) return [];
      visited.add(n.nodeId);
      const kids = (dd: number, nr = noRef): Item[] => {
        const out: Item[] = [];
        for (const c of n.childIds ?? []) {
          const cn = byId.get(c);
          if (cn) out.push(...walk(cn, dd, nr));
        }
        return out;
      };

      const backend = n.backendDOMNodeId;
      const domClickable = backend !== undefined && frame.clickable.has(backend);
      let role = str(n.role?.value) ?? '';
      if (n.ignored && !domClickable) return kids(d);
      // A native <select>'s popup: list the options (so the agent knows the
      // choices) but without refs — they are chosen with browser_select.
      if (role === 'MenuListPopup') return kids(d, true);
      // A label's text is already the name of its control.
      if (role === 'LabelText') return kids(d).filter((c) => !c.text);
      if (backend !== undefined && frame.editable?.has(backend)) role = 'textbox';

      if (TEXT_ROLES.has(role)) {
        const t = str(n.name?.value);
        if (!t || !t.trim()) return [];
        return [{ role: 'text', name: clean(t, TEXT_CAP), attrs: [], text: true, interactive: false, children: [] }];
      }

      let isInteractive = INTERACTIVE_ROLES.has(role) && !noRef;
      if (!isInteractive && domClickable && !noRef) {
        isInteractive = true;
        if (STRUCTURAL.has(role) || role === '' || role === 'paragraph' || role === 'image' || role === 'img' || role === 'listitem') {
          role = STRUCTURAL.has(role) || role === '' ? 'clickable' : role;
        }
      }
      if (!isInteractive && STRUCTURAL.has(role)) return kids(d);

      const isContainer = CONTAINERS.has(role);
      if (isContainer && d >= maxDepth) {
        truncated = true;
        return [];
      }

      let name = str(n.name?.value) ?? '';
      let childItems: Item[];
      if (role === 'Iframe' && backend !== undefined && frame.children.has(backend)) {
        childItems = walkFrame(frame.children.get(backend)!, undefined, d + 1);
      } else {
        childItems = kids(isContainer ? d + 1 : d);
      }
      if (!name && role === 'clickable') {
        const parts: string[] = [];
        collectText(n, parts);
        name = parts.join(' ');
      }
      name = clean(name, NAME_CAP);

      // A field's text children are its value, already shown as value=.
      if (VALUE_ROLES.has(role)) childItems = childItems.filter((c) => !c.text);
      // Drop text children that just repeat the element's own name.
      if (name) {
        childItems = childItems.filter((c) => !(c.text && name.includes(c.name.slice(0, 40))));
      }

      const attrs: string[] = [];
      let ref: string | undefined;
      if (isInteractive && refCount < MAX_REFS) {
        const key = `${role}\u0000${name}`;
        const nth = seen.get(key) ?? 0;
        seen.set(key, nth + 1);
        ref = assignRef(frame, n, role, name, nth);
        if (ref) refCount++;
      }
      for (const p of n.properties ?? []) {
        if (!USEFUL_PROPS.has(p.name)) continue;
        const v = str(p.value?.value);
        if (v == null || v === '') continue;
        if (v === 'false' && OMIT_FALSE.has(p.name)) continue;
        if (p.name === 'checked' && v === 'false') {
          attrs.push('unchecked');
          continue;
        }
        attrs.push(v === 'true' ? p.name : `${p.name}=${v}`);
      }
      if (VALUE_ROLES.has(role)) {
        const v = str(n.value?.value) ?? (backend !== undefined && frame.editable?.has(backend) ? textOf(n) : null);
        if (v) attrs.push(`value=${q(backend !== undefined && frame.sensitive.has(backend) ? '[redacted]' : clean(v, 80))}`);
      }

      if (!name && !ref && childItems.length === 0 && attrs.length === 0) return [];
      if (!name && !ref && !isContainer && attrs.length === 0) return childItems;
      return [{ role, name, ref, attrs, interactive: isInteractive, children: childItems }];
    };

    let start: RawAXNode[] = frame.nodes.filter((n) => !child.has(n.nodeId));
    if (startBackendId !== undefined) {
      const s = byBackend.get(startBackendId);
      if (s) start = [s];
    }
    const out: Item[] = [];
    for (const r of start) out.push(...walk(r, depth));
    return out;
  }

  let items = walkFrame(root, opts.scopeBackendId, 0);

  if (opts.interactive) {
    const prune = (list: Item[]): Item[] => {
      const out: Item[] = [];
      for (const it of list) {
        const kids = prune(it.children);
        if (it.interactive) out.push({ ...it, children: kids });
        else if (it.role === 'heading') out.push({ ...it, children: [] });
        else if (kids.length && LANDMARKS.has(it.role)) out.push({ ...it, children: kids });
        else out.push(...kids);
      }
      return out;
    };
    items = prune(items);
  }

  const lines: string[] = [];
  let chars = 0;
  let nodeCount = 0;
  let skipped = 0;

  const render = (list: Item[], indent: string): void => {
    for (const it of list) {
      if (chars >= maxChars) {
        truncated = true;
        skipped++;
        render(it.children, indent);
        continue;
      }
      let line: string;
      if (it.text) {
        line = `${indent}- text: ${q(it.name)}`;
      } else {
        const bits = [it.ref ? `ref=${it.ref}` : '', ...it.attrs].filter(Boolean);
        const tag = bits.length ? ` [${bits.join(', ')}]` : '';
        const nm = it.name ? ` ${q(it.name)}` : '';
        // A node whose only children are short text lines reads better inline.
        const inline =
          it.children.length > 0 &&
          it.children.length <= 3 &&
          it.children.every((c) => c.text) &&
          it.children.reduce((a, c) => a + c.name.length, 0) <= 160;
        if (inline) {
          line = `${indent}- ${it.role}${nm}${tag}: ${it.children.map((c) => c.name).join(' ')}`;
          lines.push(line);
          chars += line.length + 1;
          nodeCount++;
          continue;
        }
        line = `${indent}- ${DISPLAY_ROLE[it.role] ?? it.role}${nm}${tag}${it.children.length ? ":" : ""}`;
      }
      lines.push(line);
      chars += line.length + 1;
      nodeCount++;
      render(it.children, indent + '  ');
    }
  };
  render(items, '');
  if (nodeCount === 0) lines.push('(no accessible content)');
  if (skipped > 0) {
    lines.push(`[… ${skipped} more nodes not shown — use interactive:true, scope with selector/ref, or raise maxChars]`);
  }
  return { text: lines.join('\n'), lines, nodeCount, refCount, truncated };
}
