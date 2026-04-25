import { describe, expect, test } from 'bun:test';
import { recordsToHar } from '../har-converter.js';
import type { NetworkRecord } from '@byob/shared';

const baseRecord: NetworkRecord = {
  requestId: 'a',
  url: 'https://example.com/api/v2',
  method: 'POST',
  resourceType: 'fetch',
  requestHeaders: { 'Content-Type': 'application/json' },
  requestPostData: '{"k":1}',
  responseStatus: 200,
  responseStatusText: 'OK',
  responseHeaders: { 'content-type': 'application/json' },
  responseMimeType: 'application/json',
  responseBody: '{"ok":true}',
  responseBodyEncoding: 'utf8',
  timing: {
    startTime: 1700_000_000_000,
    endTime:   1700_000_000_500,
    durationMs: 500,
    dnsMs: 5,
    connectMs: 15,
    sslMs: 8,
    sendMs: 2,
    waitMs: 28,
    receiveMs: 442,
  },
  initiator: { type: 'script' },
};

describe('recordsToHar', () => {
  test('produces HAR 1.2 with creator + empty pages + entries array', () => {
    const har = recordsToHar([baseRecord], { name: 'byob', version: '0.2.0' });
    expect(har.log.version).toBe('1.2');
    expect(har.log.creator).toEqual({ name: 'byob', version: '0.2.0' });
    expect(har.log.pages).toEqual([]);
    expect(har.log.entries.length).toBe(1);
  });

  test('entry has request/response/timings/cache/time fields', () => {
    const har = recordsToHar([baseRecord], { name: 'byob', version: '0.2.0' });
    const e = har.log.entries[0]! as any;
    expect(e.startedDateTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(e.time).toBe(500);
    expect(e.request.method).toBe('POST');
    expect(e.request.url).toBe('https://example.com/api/v2');
    expect(e.request.httpVersion).toBe('HTTP/1.1');
    expect(e.request.headers).toEqual([
      { name: 'Content-Type', value: 'application/json' },
    ]);
    expect(e.request.postData).toEqual({
      mimeType: 'application/json',
      text: '{"k":1}',
    });
    expect(e.response.status).toBe(200);
    expect(e.response.statusText).toBe('OK');
    expect(e.response.content).toEqual({
      size: '{"ok":true}'.length,
      mimeType: 'application/json',
      text: '{"ok":true}',
    });
    expect(e.timings.dns).toBe(5);
    expect(e.timings.connect).toBe(15);
    expect(e.timings.ssl).toBe(8);
    expect(e.timings.send).toBe(2);
    expect(e.timings.wait).toBe(28);
    expect(e.timings.receive).toBe(442);
    expect(e.cache).toEqual({});
  });

  test('binary body: encoding=base64', () => {
    const har = recordsToHar(
      [{ ...baseRecord, responseBodyEncoding: 'base64', responseBody: 'AAEC' }],
      { name: 'byob', version: '0.2.0' },
    );
    const e = har.log.entries[0]! as any;
    expect(e.response.content.encoding).toBe('base64');
    expect(e.response.content.text).toBe('AAEC');
  });

  test('failed record sets response.status=0 and _error', () => {
    const har = recordsToHar(
      [{
        ...baseRecord,
        failed: true,
        errorText: 'net::ERR_FAILED',
        responseStatus: undefined,
        responseStatusText: undefined,
        responseHeaders: undefined,
        responseMimeType: undefined,
        responseBody: undefined,
        responseBodyEncoding: undefined,
      }],
      { name: 'byob', version: '0.2.0' },
    );
    const e = har.log.entries[0]! as any;
    expect(e.response.status).toBe(0);
    expect(e._error).toBe('net::ERR_FAILED');
  });

  test('websocket entry uses _webSocketMessages and _resourceType=websocket', () => {
    const har = recordsToHar(
      [{
        requestId: 'ws1',
        url: 'wss://echo.websocket.events/',
        method: 'GET',
        resourceType: 'websocket',
        timing: { startTime: 1700, endTime: 1900, durationMs: 200 },
        webSocketFrames: [
          { direction: 'sent',     timestamp: 1, opcode: 1, payload: 'hi' },
          { direction: 'received', timestamp: 2, opcode: 1, payload: 'hi back' },
        ],
      }],
      { name: 'byob', version: '0.2.0' },
    );
    const e = har.log.entries[0]! as any;
    expect(e._resourceType).toBe('websocket');
    expect(e._webSocketMessages).toEqual([
      { type: 'send',    time: 1, opcode: 1, data: 'hi' },
      { type: 'receive', time: 2, opcode: 1, data: 'hi back' },
    ]);
  });

  test('entries are sorted by startTime ascending', () => {
    const har = recordsToHar(
      [
        { ...baseRecord, requestId: 'b', timing: { startTime: 200 } },
        { ...baseRecord, requestId: 'a', timing: { startTime: 100 } },
        { ...baseRecord, requestId: 'c', timing: { startTime: 300 } },
      ],
      { name: 'byob', version: '0.2.0' },
    );
    expect((har.log.entries as any[]).map((e) => e._byobRequestId)).toEqual(['a', 'b', 'c']);
  });
});
