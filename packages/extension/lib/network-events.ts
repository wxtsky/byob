import type { NetworkRecord, WebSocketFrame } from '@byob/shared';
import { compileUrlPattern, matchUrl, type CompiledPattern } from './url-pattern.js';
import type { CdpSession } from './cdp.js';
import type { RecordingEntry } from './recording-registry.js';

interface CDPRequestWillBeSent {
  requestId: string;
  type: string;
  request: {
    url: string;
    method: string;
    headers: Record<string, string>;
    postData?: string;
  };
  timestamp: number;
  wallTime: number;
  initiator?: {
    type: string;
    url?: string;
    lineNumber?: number;
  };
}

interface CDPResponseReceived {
  requestId: string;
  response: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    mimeType: string;
    fromDiskCache?: boolean;
    fromServiceWorker?: boolean;
    timing?: {
      requestTime: number;
      dnsStart: number;
      dnsEnd: number;
      connectStart: number;
      connectEnd: number;
      sslStart: number;
      sslEnd: number;
      sendStart: number;
      sendEnd: number;
      receiveHeadersEnd: number;
    };
  };
  timestamp: number;
}

interface CDPLoadingFinished {
  requestId: string;
  timestamp: number;
}

interface CDPLoadingFailed {
  requestId: string;
  timestamp: number;
  errorText: string;
}

interface CDPWebSocketCreated {
  requestId: string;
  url: string;
  initiator?: { type: string; url?: string; lineNumber?: number };
}

interface CDPWebSocketFrame {
  requestId: string;
  timestamp: number;
  direction: 'sent' | 'received';
  response: { opcode: number; mask: boolean; payloadData: string };
}

export interface AccumulatorContext {
  buffer: Map<string, NetworkRecord>;
  options: RecordingEntry['options'];
  wsBudgetUsed: number;
}

const RESOURCE_TYPE_MAP: Record<string, NetworkRecord['resourceType']> = {
  XHR: 'xhr',
  Fetch: 'fetch',
  Document: 'document',
  Script: 'script',
  Stylesheet: 'stylesheet',
  Image: 'image',
  Media: 'media',
  Font: 'font',
  WebSocket: 'websocket',
};

function mapResourceType(cdpType: string): NetworkRecord['resourceType'] {
  return RESOURCE_TYPE_MAP[cdpType] ?? 'other';
}

export function shouldRecordRequest(
  ctx: AccumulatorContext,
  ev: CDPRequestWillBeSent,
): boolean {
  const rt = mapResourceType(ev.type);
  const filter = ctx.options.resourceTypes;
  if (!(filter.length === 1 && filter[0] === '*') && !filter.includes(rt)) {
    return false;
  }
  const compiled: CompiledPattern = compileUrlPattern(ctx.options.urlPattern);
  if (!matchUrl(compiled, ev.request.url)) return false;
  if (ctx.buffer.size >= ctx.options.maxRecords) return false;
  return true;
}

export function applyRequestWillBeSent(
  ctx: AccumulatorContext,
  ev: CDPRequestWillBeSent,
): void {
  if (!shouldRecordRequest(ctx, ev)) return;
  const rt = mapResourceType(ev.type);
  let postData: string | undefined;
  let postDataTruncated: boolean | undefined;
  if (ctx.options.includeRequestBody && typeof ev.request.postData === 'string') {
    if (ev.request.postData.length > ctx.options.maxBodyBytes) {
      postData = ev.request.postData.slice(0, ctx.options.maxBodyBytes);
      postDataTruncated = true;
    } else {
      postData = ev.request.postData;
    }
  }
  const rec: NetworkRecord = {
    requestId: ev.requestId,
    url: ev.request.url,
    method: ev.request.method,
    resourceType: rt,
    requestHeaders: { ...ev.request.headers },
    requestPostData: postData,
    requestPostDataTruncated: postDataTruncated,
    timing: {
      startTime: ev.wallTime * 1000,
    },
    initiator: ev.initiator
      ? {
          type:
            ev.initiator.type === 'parser' ||
            ev.initiator.type === 'script' ||
            ev.initiator.type === 'preflight'
              ? ev.initiator.type
              : 'other',
          url: ev.initiator.url,
          lineno: ev.initiator.lineNumber,
        }
      : undefined,
    webSocketFrames: rt === 'websocket' ? [] : undefined,
  };
  ctx.buffer.set(ev.requestId, rec);
}

function pos(n: number): number | undefined {
  return n >= 0 ? n : undefined;
}

export function applyResponseReceived(
  ctx: AccumulatorContext,
  ev: CDPResponseReceived,
): void {
  const rec = ctx.buffer.get(ev.requestId);
  if (!rec) return;
  rec.responseStatus = ev.response.status;
  rec.responseStatusText = ev.response.statusText;
  rec.responseHeaders = { ...ev.response.headers };
  rec.responseMimeType = ev.response.mimeType;
  rec.fromCache = ev.response.fromDiskCache === true;
  rec.fromServiceWorker = ev.response.fromServiceWorker === true;
  const t = ev.response.timing;
  if (t) {
    rec.timing.dnsMs = pos(t.dnsEnd - t.dnsStart);
    rec.timing.connectMs = pos(t.connectEnd - t.connectStart);
    rec.timing.sslMs = pos(t.sslEnd - t.sslStart);
    rec.timing.sendMs = pos(t.sendEnd - t.sendStart);
    rec.timing.waitMs = pos(t.receiveHeadersEnd - t.sendEnd);
  }
}

export function applyLoadingFinished(
  ctx: AccumulatorContext,
  ev: CDPLoadingFinished,
): void {
  const rec = ctx.buffer.get(ev.requestId);
  if (!rec) return;
  void ev;
  const endTime = Date.now();
  rec.timing.endTime = endTime;
  rec.timing.durationMs = Math.max(0, endTime - rec.timing.startTime);
  if (
    rec.timing.durationMs !== undefined &&
    rec.timing.dnsMs !== undefined &&
    rec.timing.connectMs !== undefined &&
    rec.timing.sendMs !== undefined &&
    rec.timing.waitMs !== undefined
  ) {
    const used =
      (rec.timing.dnsMs ?? 0) +
      (rec.timing.connectMs ?? 0) +
      (rec.timing.sendMs ?? 0) +
      (rec.timing.waitMs ?? 0);
    const remain = rec.timing.durationMs - used;
    rec.timing.receiveMs = remain > 0 ? remain : 0;
  }
}

export function applyLoadingFailed(
  ctx: AccumulatorContext,
  ev: CDPLoadingFailed,
): void {
  const rec = ctx.buffer.get(ev.requestId);
  if (!rec) return;
  rec.failed = true;
  rec.errorText = ev.errorText;
  const endTime = Date.now();
  rec.timing.endTime = endTime;
  rec.timing.durationMs = Math.max(0, endTime - rec.timing.startTime);
}

export function applyWebSocketCreated(
  ctx: AccumulatorContext,
  ev: CDPWebSocketCreated,
): void {
  if (!ctx.options.captureWebSocketFrames) return;
  if (ctx.buffer.size >= ctx.options.maxRecords) return;
  if (!matchUrl(compileUrlPattern(ctx.options.urlPattern), ev.url)) return;
  const rec: NetworkRecord = {
    requestId: ev.requestId,
    url: ev.url,
    method: 'GET',
    resourceType: 'websocket',
    timing: { startTime: Date.now() },
    initiator: ev.initiator
      ? {
          type:
            ev.initiator.type === 'parser' ||
            ev.initiator.type === 'script' ||
            ev.initiator.type === 'preflight'
              ? ev.initiator.type
              : 'other',
          url: ev.initiator.url,
          lineno: ev.initiator.lineNumber,
        }
      : undefined,
    webSocketFrames: [],
  };
  ctx.buffer.set(ev.requestId, rec);
}

export function applyWebSocketFrame(
  ctx: AccumulatorContext,
  ev: CDPWebSocketFrame,
): void {
  const rec = ctx.buffer.get(ev.requestId);
  if (!rec || rec.resourceType !== 'websocket') return;
  if (!ctx.options.captureWebSocketFrames) return;
  const budget = ctx.options.maxRecords * 10 * ctx.options.maxFrameBytes;
  if (ctx.wsBudgetUsed >= budget) return;
  let payload = ev.response.payloadData;
  let truncated: boolean | undefined;
  if (payload.length > ctx.options.maxFrameBytes) {
    payload = payload.slice(0, ctx.options.maxFrameBytes);
    truncated = true;
  }
  ctx.wsBudgetUsed += payload.length;
  const frame: WebSocketFrame = {
    direction: ev.direction,
    timestamp: Date.now(),
    opcode: ev.response.opcode,
    payload,
    truncated,
  };
  if (!rec.webSocketFrames) rec.webSocketFrames = [];
  rec.webSocketFrames.push(frame);
}

export function installNetworkListeners(opts: {
  session: CdpSession;
  tabId: number;
  ctx: AccumulatorContext;
  onMaxRecords: () => void;
  onLoadingFinished: (requestId: string) => void;
}): Array<() => void> {
  const { session, tabId, ctx, onMaxRecords, onLoadingFinished } = opts;
  const cleanups: Array<() => void> = [];

  const handler = (
    source: chrome.debugger.Debuggee,
    method: string,
    params: unknown,
  ): void => {
    if (source.tabId !== tabId) return;
    try {
      if (method === 'Network.requestWillBeSent') {
        const before = ctx.buffer.size;
        applyRequestWillBeSent(ctx, params as CDPRequestWillBeSent);
        if (ctx.buffer.size >= ctx.options.maxRecords && before < ctx.options.maxRecords) {
          onMaxRecords();
        }
      } else if (method === 'Network.responseReceived') {
        applyResponseReceived(ctx, params as CDPResponseReceived);
      } else if (method === 'Network.loadingFinished') {
        applyLoadingFinished(ctx, params as CDPLoadingFinished);
        onLoadingFinished((params as CDPLoadingFinished).requestId);
      } else if (method === 'Network.loadingFailed') {
        applyLoadingFailed(ctx, params as CDPLoadingFailed);
      } else if (method === 'Network.webSocketCreated') {
        applyWebSocketCreated(ctx, params as CDPWebSocketCreated);
      } else if (
        method === 'Network.webSocketFrameSent' ||
        method === 'Network.webSocketFrameReceived'
      ) {
        const ev = params as CDPWebSocketFrame;
        const direction: 'sent' | 'received' =
          method === 'Network.webSocketFrameSent' ? 'sent' : 'received';
        applyWebSocketFrame(ctx, { ...ev, direction });
      }
    } catch (e) {
      console.warn('[byob/record-network] event handler threw', method, e);
    }
    void session;
  };

  chrome.debugger.onEvent.addListener(handler);
  cleanups.push(() => chrome.debugger.onEvent.removeListener(handler));

  return cleanups;
}

export async function fetchResponseBody(
  session: CdpSession,
  rec: NetworkRecord,
  maxBodyBytes: number,
): Promise<void> {
  if (rec.failed) return;
  if (rec.resourceType === 'websocket') return;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const resp = await Promise.race([
      session.send<{ body: string; base64Encoded: boolean }>(
        'Network.getResponseBody',
        { requestId: rec.requestId },
      ),
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error('getResponseBody timeout')), 5000);
      }),
    ]);
    let body = resp.body;
    let truncated: boolean | undefined;
    if (body.length > maxBodyBytes) {
      body = body.slice(0, maxBodyBytes);
      truncated = true;
    }
    rec.responseBody = body;
    rec.responseBodyEncoding = resp.base64Encoded ? 'base64' : 'utf8';
    rec.responseBodyTruncated = truncated;
  } catch (e) {
    if (e instanceof Error && /timeout/.test(e.message)) {
      console.warn('[byob/record-network] getResponseBody timed out for', rec.url);
    }
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
