import { describe, expect, it } from 'bun:test';
import { buildSnapshot, type FrameAX, type RawAXNode } from './build.js';

const n = (nodeId: string, role: string, name?: string, extra: Partial<RawAXNode> = {}): RawAXNode => ({
  nodeId,
  role: { value: role },
  ...(name !== undefined ? { name: { value: name } } : {}),
  ...extra,
});

function frame(nodes: RawAXNode[], over: Partial<FrameAX> = {}): FrameAX {
  return { key: 'f', nodes, clickable: new Set(), sensitive: new Set(), children: new Map(), ...over };
}

let counter = 0;
const assign = () => `e${++counter}`;

describe('buildSnapshot', () => {
  it('renders containment and assigns refs to interactive nodes only', () => {
    counter = 0;
    const f = frame([
      n('r', 'RootWebArea', 'Inbox', { childIds: ['nav', 'h'] }),
      n('nav', 'navigation', 'Primary', { childIds: ['a'] }),
      n('a', 'link', 'Home', { backendDOMNodeId: 1 }),
      n('h', 'heading', 'Mail', { properties: [{ name: 'level', value: { value: 1 } }] }),
    ]);
    const out = buildSnapshot(f, assign);
    expect(out.text).toBe('- navigation "Primary":\n  - link "Home" [ref=e1]\n- heading "Mail" [level=1]');
    expect(out.refCount).toBe(1);
  });

  it('turns DOM-clickable generics into refs named by their text', () => {
    counter = 0;
    const f = frame(
      [
        n('r', 'RootWebArea', '', { childIds: ['card'] }),
        n('card', 'generic', undefined, { backendDOMNodeId: 7, childIds: ['t1', 't2'] }),
        n('t1', 'StaticText', 'Open details'),
        n('t2', 'StaticText', 'more'),
      ],
      { clickable: new Set([7]) },
    );
    expect(buildSnapshot(f, assign).text).toBe('- clickable "Open details more" [ref=e1]');
  });

  it('ignores event-delegating containers that wrap real controls', () => {
    counter = 0;
    const f = frame(
      [
        n('r', 'RootWebArea', '', { childIds: ['root'] }),
        n('root', 'generic', undefined, { backendDOMNodeId: 1, childIds: ['b', 't'] }),
        n('b', 'button', 'Save', { backendDOMNodeId: 2 }),
        n('t', 'StaticText', 'Some text'),
      ],
      { clickable: new Set([1]) },
    );
    expect(buildSnapshot(f, assign).text).toBe('- button "Save" [ref=e1]\n- text: "Some text"');
  });

  it('redacts sensitive values and drops the duplicated value text', () => {
    counter = 0;
    const f = frame(
      [
        n('r', 'RootWebArea', '', { childIds: ['pw', 'q'] }),
        n('pw', 'textbox', 'Password', { backendDOMNodeId: 1, value: { value: 'hunter2' }, childIds: ['pt'] }),
        n('pt', 'StaticText', 'hunter2'),
        n('q', 'textbox', 'Search', { backendDOMNodeId: 2, value: { value: 'cats' } }),
      ],
      { sensitive: new Set([1]) },
    );
    const text = buildSnapshot(f, assign).text;
    expect(text).toContain('textbox "Password" [ref=e1, value="[redacted]"]');
    expect(text).not.toContain('hunter2');
    expect(text).toContain('textbox "Search" [ref=e2, value="cats"]');
  });

  it('lists native <select> options without refs', () => {
    counter = 0;
    const f = frame([
      n('r', 'RootWebArea', '', { childIds: ['c'] }),
      n('c', 'combobox', 'Color', { backendDOMNodeId: 1, childIds: ['p'] }),
      n('p', 'MenuListPopup', '', { childIds: ['o1'] }),
      n('o1', 'option', 'Red', { backendDOMNodeId: 2 }),
    ]);
    expect(buildSnapshot(f, assign).text).toBe('- combobox "Color" [ref=e1]:\n  - option "Red"');
  });

  it('interactive mode keeps controls, headings and landmarks only', () => {
    counter = 0;
    const f = frame([
      n('r', 'RootWebArea', '', { childIds: ['m', 'p'] }),
      n('m', 'main', '', { childIds: ['h', 'b', 'x'] }),
      n('h', 'heading', 'Title'),
      n('b', 'button', 'Go', { backendDOMNodeId: 1 }),
      n('x', 'paragraph', '', { childIds: ['t'] }),
      n('t', 'StaticText', 'lots of prose'),
      n('p', 'paragraph', '', { childIds: ['t2'] }),
      n('t2', 'StaticText', 'more prose'),
    ]);
    expect(buildSnapshot(f, assign, { interactive: true }).text).toBe('- main:\n  - heading "Title"\n  - button "Go" [ref=e1]');
  });

  it('splices expanded iframes under their owner node', () => {
    counter = 0;
    const child = frame([n('cr', 'RootWebArea', '', { childIds: ['cb'] }), n('cb', 'button', 'Pay', { backendDOMNodeId: 9 })]);
    const f = frame([n('r', 'RootWebArea', '', { childIds: ['if'] }), n('if', 'Iframe', '', { backendDOMNodeId: 5 })], {
      children: new Map([[5, child]]),
    });
    expect(buildSnapshot(f, assign).text).toBe('- iframe [ref=e2]:\n  - button "Pay" [ref=e1]');
  });

  it('stops at the character budget and says so', () => {
    counter = 0;
    const nodes = [n('r', 'RootWebArea', '', { childIds: Array.from({ length: 50 }, (_, i) => `b${i}`) })];
    for (let i = 0; i < 50; i++) nodes.push(n(`b${i}`, 'button', `Button number ${i}`, { backendDOMNodeId: i + 1 }));
    const out = buildSnapshot(frame(nodes), assign, { maxChars: 200 });
    expect(out.truncated).toBe(true);
    expect(out.text).toContain('more nodes not shown');
    expect(out.text.length).toBeLessThan(400);
  });
});
