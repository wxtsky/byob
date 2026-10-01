import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  applyLoadingFinished,
  applyRequestWillBeSent,
  applyResponseReceived,
  recordKey,
  type AccumulatorContext,
} from '../network-events.js';
import { addMirror, isMirroring, mirrorCommands, removeMirror } from '../session-mirror.js';
import { forgetTabOopifs, recordOopif } from '../dom/frames.js';
import type { NetworkRecord } from '@byob/shared';

function ctx(): AccumulatorContext {
  return {
    buffer: new Map<string, NetworkRecord>(),
    sessionOf: new Map(),
    options: {
      resourceTypes: ['xhr', 'fetch'], urlPattern: undefined, includeRequestBody: true, includeResponseBody: true,
      maxBodyBytes: 1000, maxRecords: 500, captureWebSocketFrames: true, maxFrameBytes: 100, timeoutMs: 60_000,
    },
    wsBudgetUsed: 0,
  };
}

const req = (requestId: string, url: string) => ({
  requestId, type: 'Fetch', request: { url, method: 'GET', headers: {} }, timestamp: 1, wallTime: 1_700_000, initiator: { type: 'script' },
});

describe('records from several CDP sessions', () => {
  test('the same request id on the tab and in an OOPIF stays two records', () => {
    const c = ctx();
    applyRequestWillBeSent(c, req('7.1', 'https://a.test/api'));
    applyRequestWillBeSent(c, req('7.1', 'https://pay.test/api'), 'CHILD');
    expect(c.buffer.size).toBe(2);
    applyResponseReceived(c, { requestId: '7.1', timestamp: 2, response: { status: 201, statusText: '', headers: {}, mimeType: 'application/json' } }, 'CHILD');
    applyLoadingFinished(c, { requestId: '7.1', timestamp: 3 }, 'CHILD');
    const child = c.buffer.get(recordKey('CHILD', '7.1'))!;
    expect(child.url).toBe('https://pay.test/api');
    expect(child.responseStatus).toBe(201);
    expect(child.requestId).toBe('7.1');
    expect(c.buffer.get('7.1')!.responseStatus).toBeUndefined();
    expect(c.sessionOf!.get(recordKey('CHILD', '7.1'))).toBe('CHILD');
  });
});

describe('session mirror', () => {
  const sent: Array<{ sessionId?: string; method: string }> = [];
  const g = globalThis as { chrome?: unknown };
  let saved: unknown;
  beforeEach(() => {
    sent.length = 0;
    saved = g.chrome;
    g.chrome = {
      runtime: { lastError: undefined },
      debugger: {
        sendCommand: (t: { sessionId?: string }, method: string, _p: unknown, cb: () => void) => {
          sent.push({ sessionId: t.sessionId, method });
          cb();
        },
      },
    };
    recordOopif(5, 'F1', 'S1');
  });
  afterEach(() => {
    removeMirror(5, 'record:a');
    removeMirror(5, 'record:b');
    removeMirror(5, 'intercept:x');
    forgetTabOopifs(5);
    g.chrome = saved;
  });

  test('enables on existing children, pauses new ones, and hands late children the same enables', () => {
    addMirror(5, 'record:a', 'Network', { maxPostDataSize: 1 });
    expect(sent).toContainEqual({ sessionId: 'S1', method: 'Network.enable' });
    expect(sent).toContainEqual({ sessionId: undefined, method: 'Target.setAutoAttach' });
    expect(isMirroring(5)).toBe(true);
    addMirror(5, 'intercept:x', 'Fetch', { patterns: [] });
    expect(mirrorCommands(5).map(([m]) => m).sort()).toEqual(['Fetch.enable', 'Network.enable']);
  });

  test('disables a domain on the children only when its last owner leaves', () => {
    addMirror(5, 'record:a', 'Network');
    addMirror(5, 'record:b', 'Network');
    sent.length = 0;
    removeMirror(5, 'record:a');
    expect(sent.some((s) => s.method === 'Network.disable')).toBe(false);
    removeMirror(5, 'record:b');
    expect(sent).toContainEqual({ sessionId: 'S1', method: 'Network.disable' });
    expect(isMirroring(5)).toBe(false);
  });
});
