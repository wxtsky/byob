import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

let originalChrome: unknown;
let helpers: typeof import('./snapshot.js');

beforeAll(async () => {
  // cdp.ts registers chrome listeners at import time, so anything that pulls
  // in a handler needs a stand-in global before the import.
  originalChrome = (globalThis as { chrome?: unknown }).chrome;
  (globalThis as { chrome: unknown }).chrome = {
    tabs: {
      onRemoved: { hasListener: () => false, addListener: () => {} },
    },
    debugger: {
      onDetach: { hasListener: () => false, addListener: () => {} },
    },
  };
  helpers = await import('./snapshot.js');
});

afterAll(() => {
  (globalThis as { chrome?: unknown }).chrome = originalChrome;
});

/** Resolve an index for one fixture node only — the production resolver keys
 *  off backendDOMNodeId, so containers must stay untagged. */
const idxFor = (nodeId: string, n: number) =>
  (node: { nodeId: string }) => (node.nodeId === nodeId ? n : undefined);

describe('buildSnapshotText', () => {
  it('marks output truncated when maxDepth cuts off nested containers', () => {
    const built = helpers.buildSnapshotText(
      [
        {
          nodeId: 'root',
          role: { value: 'RootWebArea' },
          name: { value: 'Root' },
          childIds: ['main'],
        },
        {
          nodeId: 'main',
          role: { value: 'main' },
          name: { value: 'Main' },
          childIds: ['button'],
        },
        {
          nodeId: 'button',
          role: { value: 'button' },
          name: { value: 'Save' },
        },
      ],
      idxFor('button', 4),
      1,
    );

    expect(built.truncated).toBe(true);
    expect(built.nodeCount).toBe(1);
    expect(built.text).toContain('Root');
    expect(built.text).not.toContain('Main');
    expect(built.text).not.toContain('Save');
  });

  it('renders containment as an indented tree', () => {
    const built = helpers.buildSnapshotText(
      [
        {
          nodeId: 'root',
          role: { value: 'RootWebArea' },
          name: { value: 'Inbox' },
          childIds: ['dialog'],
        },
        {
          nodeId: 'dialog',
          role: { value: 'dialog' },
          name: { value: 'Confirm' },
          childIds: ['button'],
          properties: [{ name: 'modal', value: { value: true } }],
        },
        {
          nodeId: 'button',
          role: { value: 'button' },
          name: { value: 'Delete' },
        },
      ],
      idxFor('button', 11),
      8,
    );

    expect(built.text).toBe(
      [
        '- RootWebArea "Inbox":',
        '  - dialog "Confirm" modal:',
        '    - button "Delete" [byob:11]',
      ].join('\n'),
    );
    expect(built.nodeCount).toBe(3);
    expect(built.truncated).toBe(false);
  });

  it('drops noisy AX properties and false-valued boolean states', () => {
    const built = helpers.buildSnapshotText(
      [
        {
          nodeId: 'root',
          role: { value: 'RootWebArea' },
          childIds: ['button'],
        },
        {
          nodeId: 'button',
          role: { value: 'button' },
          name: { value: 'Submit' },
          properties: [
            { name: 'focusable', value: { value: true } },
            { name: 'disabled', value: { value: false } },
            { name: 'expanded', value: { value: true } },
          ],
        },
      ],
      idxFor('button', 9),
      8,
    );

    expect(built.text).toContain('- button "Submit" [byob:9] expanded');
    expect(built.text).not.toContain('focusable');
    expect(built.text).not.toContain('disabled');
  });

  it('hoists structural wrappers instead of nesting them', () => {
    const built = helpers.buildSnapshotText(
      [
        { nodeId: 'root', role: { value: 'RootWebArea' }, childIds: ['g1'] },
        { nodeId: 'g1', role: { value: 'generic' }, childIds: ['g2'] },
        { nodeId: 'g2', role: { value: 'generic' }, childIds: ['link'] },
        { nodeId: 'link', role: { value: 'link' }, name: { value: 'Home' } },
      ],
      idxFor('link', 1),
      8,
    );

    expect(built.text).toBe(
      ['- RootWebArea:', '  - link "Home" [byob:1]'].join('\n'),
    );
  });

  it('distinguishes duplicate role/name pairs by backendDOMNodeId', () => {
    const built = helpers.buildSnapshotText(
      [
        {
          nodeId: 'root',
          role: { value: 'RootWebArea' },
          childIds: ['first', 'second'],
        },
        {
          nodeId: 'first',
          role: { value: 'button' },
          name: { value: 'Edit' },
          backendDOMNodeId: 101,
        },
        {
          nodeId: 'second',
          role: { value: 'button' },
          name: { value: 'Edit' },
          backendDOMNodeId: 202,
        },
      ],
      (node) => (node.backendDOMNodeId === 101 ? 3 : node.backendDOMNodeId === 202 ? 8 : undefined),
      8,
    );

    expect(built.text).toContain('- button "Edit" [byob:3]');
    expect(built.text).toContain('- button "Edit" [byob:8]');
  });

  it('keeps an actionable index for an unlabelled control', () => {
    const built = helpers.buildSnapshotText(
      [
        {
          nodeId: 'root',
          role: { value: 'RootWebArea' },
          childIds: ['button'],
        },
        {
          nodeId: 'button',
          role: { value: 'button' },
          backendDOMNodeId: 101,
        },
      ],
      (node) => (node.backendDOMNodeId === 101 ? 6 : undefined),
      8,
    );

    expect(built.text).toContain('- button [byob:6]');
  });

  it('stops at the character budget instead of returning the whole page', () => {
    // 4000 sibling links, each line well over 6 characters, so the 24k budget
    // has to bite long before the last one.
    const nodes = [
      {
        nodeId: 'root',
        role: { value: 'RootWebArea' },
        childIds: Array.from({ length: 4000 }, (_, i) => `n${i}`),
      },
      ...Array.from({ length: 4000 }, (_, i) => ({
        nodeId: `n${i}`,
        role: { value: 'link' },
        name: { value: `Item number ${i} with a reasonably long label` },
      })),
    ];
    const built = helpers.buildSnapshotText(nodes, () => undefined, 8);

    expect(built.truncated).toBe(true);
    expect(built.text.length).toBeLessThan(25_000);
    expect(built.nodeCount).toBeLessThan(4000);
  });
});
