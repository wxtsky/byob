import { describe, it, expect, beforeEach } from 'bun:test';
import { resolveFrame, _resetContextRegistryForTests } from '../frame-resolver.js';

type Call = { method: string; params: Record<string, unknown> };
function makeStubSession(scripts: Record<string, unknown[]>) {
  const calls: Call[] = [];
  const queue = new Map<string, unknown[]>(Object.entries(scripts));
  return {
    calls,
    send: async <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
      calls.push({ method, params });
      const q = queue.get(method);
      if (!q || q.length === 0) throw new Error(`stub missing for ${method}`);
      return q.shift() as T;
    },
    sendOnSession: async <T>(_sessionId: string, method: string, params: Record<string, unknown> = {}): Promise<T> => {
      calls.push({ method: `[${_sessionId}]${method}`, params });
      const q = queue.get(`[${_sessionId}]${method}`);
      if (!q || q.length === 0) throw new Error(`stub missing for [${_sessionId}]${method}`);
      return q.shift() as T;
    },
  };
}

beforeEach(() => {
  _resetContextRegistryForTests();
});

describe('resolveFrame', () => {
  it('returns main frame identity for empty framePath', async () => {
    const session = makeStubSession({
      'Page.getFrameTree': [{
        frameTree: { frame: { id: 'main-frame', url: 'https://a.test/' }, childFrames: [] },
      }],
    });
    const { _seedContextForTests } = await import('../frame-resolver.js');
    _seedContextForTests('main-frame', { contextId: 1, sessionId: undefined });

    const out = await resolveFrame(session as never, []);
    expect(out).toEqual({ frameId: 'main-frame', contextId: 1, sessionId: undefined });
  });

  it('resolves single-level same-origin iframe', async () => {
    const session = makeStubSession({
      'Runtime.evaluate': [
        { result: { objectId: 'iframe-obj-1', subtype: 'node' } },
      ],
      'DOM.describeNode': [
        { node: { nodeName: 'IFRAME', frameId: 'child-frame', nodeId: 100 } },
      ],
      'Page.getFrameTree': [
        {
          frameTree: {
            frame: { id: 'main-frame', url: 'https://a.test/' },
            childFrames: [
              { frame: { id: 'child-frame', url: 'https://a.test/embed' }, childFrames: [] },
            ],
          },
        },
        {
          frameTree: {
            frame: { id: 'main-frame', url: 'https://a.test/' },
            childFrames: [
              { frame: { id: 'child-frame', url: 'https://a.test/embed' }, childFrames: [] },
            ],
          },
        },
      ],
    });
    const { _seedContextForTests } = await import('../frame-resolver.js');
    _seedContextForTests('main-frame', { contextId: 1, sessionId: undefined });
    _seedContextForTests('child-frame', { contextId: 2, sessionId: undefined });

    const out = await resolveFrame(session as never, ['iframe[name="x"]']);
    expect(out).toEqual({ frameId: 'child-frame', contextId: 2, sessionId: undefined });
  });

  it('rejects when selector matches a non-iframe element', async () => {
    const session = makeStubSession({
      'Runtime.evaluate': [{ result: { objectId: 'div-obj' } }],
      'DOM.describeNode': [{ node: { nodeName: 'DIV', nodeId: 5 } }],
      'Page.getFrameTree': [{
        frameTree: { frame: { id: 'main-frame', url: 'https://a.test/' }, childFrames: [] },
      }],
    });
    const { _seedContextForTests } = await import('../frame-resolver.js');
    _seedContextForTests('main-frame', { contextId: 1, sessionId: undefined });

    await expect(resolveFrame(session as never, ['div.foo'])).rejects.toMatchObject({
      error: 'frame_not_found',
      framePathIndex: 0,
      reason: 'not_an_iframe',
    });
  });

  it('rejects when selector matches nothing (frame_not_found, index 0)', async () => {
    const session = makeStubSession({
      'Runtime.evaluate': [{ result: { value: null, type: 'object' } }],
      'Page.getFrameTree': [{
        frameTree: { frame: { id: 'main-frame', url: 'https://a.test/' }, childFrames: [] },
      }],
    });
    const { _seedContextForTests } = await import('../frame-resolver.js');
    _seedContextForTests('main-frame', { contextId: 1, sessionId: undefined });

    await expect(resolveFrame(session as never, ['#nope'])).rejects.toMatchObject({
      error: 'frame_not_found',
      framePathIndex: 0,
    });
  });

  it('reports correct index when nested step fails', async () => {
    const session = makeStubSession({
      'Runtime.evaluate': [
        { result: { objectId: 'iframe-outer' } },
        { result: { value: null, type: 'object' } },
      ],
      'DOM.describeNode': [
        { node: { nodeName: 'IFRAME', frameId: 'outer-frame', nodeId: 10 } },
      ],
      'Page.getFrameTree': [
        {
          frameTree: {
            frame: { id: 'main-frame', url: 'https://a.test/' },
            childFrames: [{ frame: { id: 'outer-frame', url: 'https://a.test/o' }, childFrames: [] }],
          },
        },
        {
          frameTree: {
            frame: { id: 'main-frame', url: 'https://a.test/' },
            childFrames: [{ frame: { id: 'outer-frame', url: 'https://a.test/o' }, childFrames: [] }],
          },
        },
      ],
    });
    const { _seedContextForTests } = await import('../frame-resolver.js');
    _seedContextForTests('main-frame', { contextId: 1, sessionId: undefined });
    _seedContextForTests('outer-frame', { contextId: 2, sessionId: undefined });

    await expect(resolveFrame(session as never, ['iframe.outer', 'iframe.inner'])).rejects.toMatchObject({
      error: 'frame_not_found',
      framePathIndex: 1,
    });
  });

  it('routes via sessionId for OOPIF targets', async () => {
    const session = makeStubSession({
      'Runtime.evaluate': [{ result: { objectId: 'iframe-x' } }],
      'DOM.describeNode': [{ node: { nodeName: 'IFRAME', frameId: 'oopif-frame', nodeId: 7 } }],
      'Page.getFrameTree': [
        {
          frameTree: {
            frame: { id: 'main-frame', url: 'https://a.test/' },
            childFrames: [{ frame: { id: 'oopif-frame', url: 'https://other.test/' }, childFrames: [] }],
          },
        },
        {
          frameTree: {
            frame: { id: 'main-frame', url: 'https://a.test/' },
            childFrames: [{ frame: { id: 'oopif-frame', url: 'https://other.test/' }, childFrames: [] }],
          },
        },
      ],
    });
    const { _seedContextForTests } = await import('../frame-resolver.js');
    _seedContextForTests('main-frame', { contextId: 1, sessionId: undefined });
    _seedContextForTests('oopif-frame', { contextId: 99, sessionId: 'sess-oopif' });

    const out = await resolveFrame(session as never, ['iframe[src*="other"]']);
    expect(out).toEqual({ frameId: 'oopif-frame', contextId: 99, sessionId: 'sess-oopif' });
  });
});
