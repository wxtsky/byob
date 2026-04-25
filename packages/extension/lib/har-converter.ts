import type { NetworkRecord, Har, WebSocketFrame } from '@byob/shared';

interface HarCreator {
  name: string;
  version: string;
}

interface HarHeader { name: string; value: string }

/**
 * Convert NetworkRecord[] to a HAR 1.2 archive.
 *
 * WebSocket entries get two custom fields:
 *   _resourceType: 'websocket'
 *   _webSocketMessages: [{ type: 'send'|'receive', time, opcode, data }]
 *
 * The naming matches Chrome DevTools' "Save all as HAR with content" export
 * so existing tooling that already understands the DevTools dialect can read
 * our output. Strict HAR 1.2 validators may flag the `_*` prefix — that's
 * acceptable; HAR 1.2 explicitly reserves underscore-prefixed fields for
 * vendor extensions.
 */
export function recordsToHar(records: NetworkRecord[], creator: HarCreator): Har {
  const sorted = [...records].sort(
    (a, b) => a.timing.startTime - b.timing.startTime,
  );
  return {
    log: {
      version: '1.2',
      creator,
      pages: [],
      entries: sorted.map(toHarEntry),
    },
  };
}

function toHarEntry(r: NetworkRecord): Record<string, unknown> {
  const startedDateTime = new Date(r.timing.startTime).toISOString();
  const time = r.timing.durationMs ?? 0;

  const requestHeaders: HarHeader[] = headersToArray(r.requestHeaders);
  const responseHeaders: HarHeader[] = headersToArray(r.responseHeaders);

  const request: Record<string, unknown> = {
    method: r.method,
    url: r.url,
    httpVersion: 'HTTP/1.1',
    cookies: [],
    headers: requestHeaders,
    queryString: parseQueryString(r.url),
    headersSize: -1,
    bodySize: r.requestPostData?.length ?? -1,
  };
  if (r.requestPostData !== undefined) {
    request.postData = {
      mimeType: r.requestHeaders?.['Content-Type'] ?? r.requestHeaders?.['content-type'] ?? '',
      text: r.requestPostData,
    };
  }

  const responseContent: Record<string, unknown> = {
    size: r.responseBody?.length ?? 0,
    mimeType: r.responseMimeType ?? '',
  };
  if (r.responseBody !== undefined) {
    responseContent.text = r.responseBody;
    if (r.responseBodyEncoding === 'base64') responseContent.encoding = 'base64';
  }

  const response: Record<string, unknown> = {
    status: r.failed ? 0 : (r.responseStatus ?? 0),
    statusText: r.responseStatusText ?? '',
    httpVersion: 'HTTP/1.1',
    cookies: [],
    headers: responseHeaders,
    content: responseContent,
    redirectURL: '',
    headersSize: -1,
    bodySize: r.responseBody?.length ?? -1,
  };

  const timings = {
    blocked: -1,
    dns: r.timing.dnsMs ?? -1,
    connect: r.timing.connectMs ?? -1,
    ssl: r.timing.sslMs ?? -1,
    send: r.timing.sendMs ?? 0,
    wait: r.timing.waitMs ?? 0,
    receive: r.timing.receiveMs ?? 0,
  };

  const entry: Record<string, unknown> = {
    startedDateTime,
    time,
    request,
    response,
    cache: {},
    timings,
    serverIPAddress: '',
    connection: '',
    _byobRequestId: r.requestId,
    _resourceType: r.resourceType,
  };

  if (r.failed && r.errorText) entry._error = r.errorText;
  if (r.fromCache) entry._fromCache = true;
  if (r.fromServiceWorker) entry._fromServiceWorker = true;

  if (r.resourceType === 'websocket' && r.webSocketFrames && r.webSocketFrames.length > 0) {
    entry._webSocketMessages = r.webSocketFrames.map(frameToWsMessage);
  }

  if (r.initiator) entry._initiator = r.initiator;

  return entry;
}

function headersToArray(h: Record<string, string> | undefined): HarHeader[] {
  if (!h) return [];
  return Object.entries(h).map(([name, value]) => ({ name, value }));
}

function parseQueryString(url: string): Array<{ name: string; value: string }> {
  try {
    const u = new URL(url);
    const out: Array<{ name: string; value: string }> = [];
    u.searchParams.forEach((v, k) => out.push({ name: k, value: v }));
    return out;
  } catch {
    return [];
  }
}

function frameToWsMessage(f: WebSocketFrame): {
  type: 'send' | 'receive';
  time: number;
  opcode: number;
  data: string;
} {
  return {
    type: f.direction === 'sent' ? 'send' : 'receive',
    time: f.timestamp,
    opcode: f.opcode,
    data: f.payload,
  };
}
