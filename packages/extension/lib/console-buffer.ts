/**
 * Per-tab console ring buffer.
 *
 * Fed continuously by the event hub from the moment byob attaches to a tab,
 * so `browser_console` can be called any number of times and still see
 * earlier messages (CDP only replays console history once, on Runtime.enable).
 * Log.enable *does* replay what the browser collected before we attached —
 * uncaught errors, failed requests, CSP / deprecation warnings.
 */

export type ConsoleLevel = 'debug' | 'log' | 'info' | 'warn' | 'error';

export interface ConsoleEntry {
  seq: number;
  ts: number;
  level: ConsoleLevel;
  /** console | exception | network | violation | … (CDP Log source) */
  source: string;
  text: string;
  location?: string;
}

interface RemoteObject {
  type: string;
  subtype?: string;
  className?: string;
  description?: string;
  value?: unknown;
  unserializableValue?: string;
}
type StackTrace = { callFrames: Array<{ url: string; lineNumber: number; columnNumber: number }> };

const MAX_PER_TAB = 1000;
const MAX_TEXT = 2000;
let seq = 0;
const buffers = new Map<number, ConsoleEntry[]>();

function push(tabId: number, e: Omit<ConsoleEntry, 'seq'>): void {
  let b = buffers.get(tabId);
  if (!b) {
    b = [];
    buffers.set(tabId, b);
  }
  // Log.enable replays history on every attach; skip exact repeats of what
  // we already hold so a reattach doesn't duplicate the buffer.
  if (e.source !== 'console' && b.some((x) => x.ts === e.ts && x.text === e.text)) return;
  b.push({ ...e, text: e.text.length > MAX_TEXT ? e.text.slice(0, MAX_TEXT) + '…' : e.text, seq: ++seq });
  if (b.length > MAX_PER_TAB) b.splice(0, b.length - MAX_PER_TAB);
}

export function stringifyArg(arg: RemoteObject): string {
  if (arg.type === 'string') return String(arg.value);
  if (arg.unserializableValue !== undefined) return arg.unserializableValue;
  if (arg.type === 'number' || arg.type === 'boolean' || arg.type === 'undefined') return String(arg.value);
  if (arg.subtype === 'null') return 'null';
  if (arg.type === 'symbol') return arg.description ?? 'Symbol()';
  if (arg.value !== undefined && typeof arg.value !== 'object') return String(arg.value);
  return arg.description ?? arg.className ?? arg.type;
}

function topFrame(st?: StackTrace, url?: string, line?: number): string | undefined {
  const f = st?.callFrames?.[0];
  if (f?.url) return `${f.url}:${f.lineNumber + 1}`;
  if (url) return line !== undefined ? `${url}:${line + 1}` : url;
  return undefined;
}

const API_LEVEL: Record<string, ConsoleLevel> = {
  log: 'log', info: 'info', debug: 'debug', error: 'error', warning: 'warn',
  assert: 'error', trace: 'log', dir: 'log', table: 'log',
};

export function onConsoleEvent(tabId: number, method: string, params: unknown): void {
  if (method === 'Runtime.consoleAPICalled') {
    const p = params as { type: string; args: RemoteObject[]; timestamp: number; stackTrace?: StackTrace };
    const level = API_LEVEL[p.type];
    if (!level) return;
    push(tabId, {
      ts: p.timestamp,
      level,
      source: 'console',
      text: p.args.map(stringifyArg).join(' '),
      location: topFrame(p.stackTrace),
    });
  } else if (method === 'Runtime.exceptionThrown') {
    const p = params as {
      timestamp: number;
      exceptionDetails: { text?: string; url?: string; lineNumber?: number; exception?: RemoteObject; stackTrace?: StackTrace };
    };
    const d = p.exceptionDetails;
    push(tabId, {
      ts: p.timestamp,
      level: 'error',
      source: 'exception',
      text: d.exception?.description ?? d.text ?? 'Uncaught exception',
      location: topFrame(d.stackTrace, d.url, d.lineNumber),
    });
  } else if (method === 'Log.entryAdded') {
    const e = (params as {
      entry: { source: string; level: string; text: string; timestamp: number; url?: string; lineNumber?: number; stackTrace?: StackTrace };
    }).entry;
    const level: ConsoleLevel =
      e.level === 'error' ? 'error' : e.level === 'warning' ? 'warn' : e.level === 'verbose' ? 'debug' : 'info';
    push(tabId, {
      ts: e.timestamp,
      level,
      source: e.source,
      text: e.text,
      location: topFrame(e.stackTrace, e.url, e.lineNumber),
    });
  }
}

const RANK: Record<ConsoleLevel, number> = { debug: 0, log: 1, info: 1, warn: 2, error: 3 };

export function readConsole(
  tabId: number,
  opts: { since?: number; minLevel?: ConsoleLevel; limit?: number; clear?: boolean } = {},
): { entries: ConsoleEntry[]; lastSeq: number; dropped: number } {
  const all = buffers.get(tabId) ?? [];
  const min = RANK[opts.minLevel ?? 'debug'];
  let entries = all.filter((e) => e.seq > (opts.since ?? 0) && RANK[e.level] >= min);
  const limit = opts.limit ?? 200;
  const dropped = Math.max(0, entries.length - limit);
  if (dropped) entries = entries.slice(-limit);
  const lastSeq = all.length ? all[all.length - 1]!.seq : opts.since ?? 0;
  if (opts.clear) buffers.delete(tabId);
  return { entries, lastSeq, dropped };
}

export function forgetTabConsole(tabId: number): void {
  buffers.delete(tabId);
}
