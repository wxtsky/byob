import { describe, expect, test } from 'bun:test';
import {
  applyRequestWillBeSent,
  applyResponseReceived,
  applyLoadingFinished,
  applyLoadingFailed,
  applyWebSocketFrame,
  shouldRecordRequest,
  type AccumulatorContext,
} from '../network-events.js';
import type { NetworkRecord } from '@byob/shared';

function ctx(opts: Partial<AccumulatorContext['options']> = {}): AccumulatorContext {
  return {
    buffer: new Map<string, NetworkRecord>(),
    options: {
      resourceTypes: ['xhr', 'fetch'],
      urlPattern: undefined,
      includeRequestBody: true,
      includeResponseBody: true,
      maxBodyBytes: 1000,
      maxRecords: 500,
      captureWebSocketFrames: true,
      maxFrameBytes: 100,
      timeoutMs: 60_000,
      ...opts,
    },
    wsBudgetUsed: 0,
  };
}

describe('shouldRecordRequest', () => {
  test('passes when resourceType matches and no urlPattern', () => {
    const c = ctx();
    const event = {
      requestId: 'a',
      type: 'XHR',
      request: { url: 'https://example.com/x', method: 'GET', headers: {} },
      timestamp: 1,
      wallTime: 1700000,
      initiator: { type: 'parser' },
    };
    expect(shouldRecordRequest(c, event)).toBe(true);
  });

  test('rejects when resourceType not in filter', () => {
    const c = ctx({ resourceTypes: ['xhr'] });
    const event = {
      requestId: 'a',
      type: 'Image',
      request: { url: 'https://x.com/img.png', method: 'GET', headers: {} },
      timestamp: 1, wallTime: 1, initiator: { type: 'parser' },
    };
    expect(shouldRecordRequest(c, event)).toBe(false);
  });

  test("['*'] resourceType means all", () => {
    const c = ctx({ resourceTypes: ['*'] });
    const event = {
      requestId: 'a',
      type: 'Media',
      request: { url: 'https://x.com/v.mp4', method: 'GET', headers: {} },
      timestamp: 1, wallTime: 1, initiator: { type: 'parser' },
    };
    expect(shouldRecordRequest(c, event)).toBe(true);
  });

  test('urlPattern glob filter applies', () => {
    const c = ctx({ resourceTypes: ['*'], urlPattern: '*api*' });
    const apiEvent = {
      requestId: 'a', type: 'XHR',
      request: { url: 'https://x.com/api/v2', method: 'GET', headers: {} },
      timestamp: 1, wallTime: 1, initiator: { type: 'parser' },
    };
    const staticEvent = { ...apiEvent, request: { ...apiEvent.request, url: 'https://x.com/main.js' } };
    expect(shouldRecordRequest(c, apiEvent)).toBe(true);
    expect(shouldRecordRequest(c, staticEvent)).toBe(false);
  });
});

describe('applyRequestWillBeSent', () => {
  test('creates a record with method/url/headers/postData', () => {
    const c = ctx();
    applyRequestWillBeSent(c, {
      requestId: 'a',
      type: 'XHR',
      request: {
        url: 'https://x.com/api',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        postData: '{"k":1}',
      },
      timestamp: 100,
      wallTime: 1700000.5,
      initiator: { type: 'script', url: 'app.js', lineNumber: 12 },
    });
    const rec = c.buffer.get('a')!;
    expect(rec).toBeDefined();
    expect(rec.url).toBe('https://x.com/api');
    expect(rec.method).toBe('POST');
    expect(rec.requestHeaders).toEqual({ 'Content-Type': 'application/json' });
    expect(rec.requestPostData).toBe('{"k":1}');
    expect(rec.resourceType).toBe('xhr');
    expect(rec.timing.startTime).toBeCloseTo(1700000.5 * 1000, 1);
    expect(rec.initiator).toEqual({ type: 'script', url: 'app.js', lineno: 12 });
  });

  test('truncates postData over maxBodyBytes', () => {
    const c = ctx({ maxBodyBytes: 4 });
    applyRequestWillBeSent(c, {
      requestId: 'a',
      type: 'XHR',
      request: { url: 'https://x.com/x', method: 'POST', headers: {}, postData: '12345678' },
      timestamp: 1, wallTime: 1, initiator: { type: 'parser' },
    });
    const rec = c.buffer.get('a')!;
    expect(rec.requestPostData).toBe('1234');
    expect(rec.requestPostDataTruncated).toBe(true);
  });

  test('omits requestPostData when includeRequestBody=false', () => {
    const c = ctx({ includeRequestBody: false });
    applyRequestWillBeSent(c, {
      requestId: 'a',
      type: 'XHR',
      request: { url: 'https://x.com/x', method: 'POST', headers: {}, postData: 'body' },
      timestamp: 1, wallTime: 1, initiator: { type: 'parser' },
    });
    const rec = c.buffer.get('a')!;
    expect(rec.requestPostData).toBeUndefined();
  });
});

describe('applyResponseReceived', () => {
  test('fills status / responseHeaders / mimeType / fromCache', () => {
    const c = ctx();
    applyRequestWillBeSent(c, {
      requestId: 'a', type: 'XHR',
      request: { url: 'https://x.com', method: 'GET', headers: {} },
      timestamp: 1, wallTime: 1, initiator: { type: 'parser' },
    });
    applyResponseReceived(c, {
      requestId: 'a',
      response: {
        status: 200, statusText: 'OK',
        headers: { 'content-type': 'application/json' },
        mimeType: 'application/json',
        fromDiskCache: true,
        fromServiceWorker: false,
        timing: {
          requestTime: 0,
          dnsStart: 0, dnsEnd: 5,
          connectStart: 5, connectEnd: 20,
          sslStart: 10, sslEnd: 18,
          sendStart: 20, sendEnd: 22,
          receiveHeadersEnd: 50,
        },
      },
      timestamp: 1.05,
    });
    const rec = c.buffer.get('a')!;
    expect(rec.responseStatus).toBe(200);
    expect(rec.responseStatusText).toBe('OK');
    expect(rec.responseHeaders).toEqual({ 'content-type': 'application/json' });
    expect(rec.responseMimeType).toBe('application/json');
    expect(rec.fromCache).toBe(true);
    expect(rec.timing.dnsMs).toBe(5);
    expect(rec.timing.connectMs).toBe(15);
    expect(rec.timing.sslMs).toBe(8);
    expect(rec.timing.sendMs).toBe(2);
    expect(rec.timing.waitMs).toBe(28);
  });

  test('is a no-op if requestId never created (filtered out)', () => {
    const c = ctx();
    applyResponseReceived(c, {
      requestId: 'ghost',
      response: { status: 200, statusText: 'OK', headers: {}, mimeType: 'text/html' },
      timestamp: 1,
    });
    expect(c.buffer.has('ghost')).toBe(false);
  });
});

describe('applyLoadingFinished + applyLoadingFailed', () => {
  test('finished sets endTime and durationMs', () => {
    const c = ctx();
    applyRequestWillBeSent(c, {
      requestId: 'a', type: 'XHR',
      request: { url: 'https://x.com', method: 'GET', headers: {} },
      timestamp: 100, wallTime: 1700, initiator: { type: 'parser' },
    });
    applyLoadingFinished(c, { requestId: 'a', timestamp: 100.5 });
    const rec = c.buffer.get('a')!;
    expect(rec.timing.endTime).toBeGreaterThan(0);
    expect(rec.timing.durationMs).toBeGreaterThan(0);
  });

  test('failed sets failed=true + errorText', () => {
    const c = ctx();
    applyRequestWillBeSent(c, {
      requestId: 'a', type: 'XHR',
      request: { url: 'https://x.com', method: 'GET', headers: {} },
      timestamp: 100, wallTime: 1700, initiator: { type: 'parser' },
    });
    applyLoadingFailed(c, { requestId: 'a', timestamp: 100.5, errorText: 'net::ERR_FAILED' });
    const rec = c.buffer.get('a')!;
    expect(rec.failed).toBe(true);
    expect(rec.errorText).toBe('net::ERR_FAILED');
  });
});

describe('applyWebSocketFrame', () => {
  test('appends a sent text frame to record.webSocketFrames', () => {
    const c = ctx();
    c.buffer.set('a', {
      requestId: 'a', url: 'wss://x.com/ws', method: 'GET',
      resourceType: 'websocket',
      timing: { startTime: Date.now() },
      webSocketFrames: [],
    });
    applyWebSocketFrame(c, {
      requestId: 'a',
      timestamp: 12345,
      direction: 'sent',
      response: { opcode: 1, mask: false, payloadData: 'hello' },
    });
    const rec = c.buffer.get('a')!;
    expect(rec.webSocketFrames!.length).toBe(1);
    expect(rec.webSocketFrames![0]!.direction).toBe('sent');
    expect(rec.webSocketFrames![0]!.opcode).toBe(1);
    expect(rec.webSocketFrames![0]!.payload).toBe('hello');
  });

  test('truncates frame payload over maxFrameBytes', () => {
    const c = ctx({ maxFrameBytes: 3 });
    c.buffer.set('a', {
      requestId: 'a', url: 'wss://x.com/ws', method: 'GET',
      resourceType: 'websocket',
      timing: { startTime: 0 }, webSocketFrames: [],
    });
    applyWebSocketFrame(c, {
      requestId: 'a', timestamp: 1, direction: 'received',
      response: { opcode: 1, mask: false, payloadData: 'abcdefg' },
    });
    const f = c.buffer.get('a')!.webSocketFrames![0]!;
    expect(f.payload).toBe('abc');
    expect(f.truncated).toBe(true);
  });
});
