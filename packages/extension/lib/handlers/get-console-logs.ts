import { GetConsoleLogsInput } from '@byob/shared';
import { tryAttachToTab } from '../cdp.js';
import { openOrReuse } from '../tab.js';
import { checkUrlAllowed, urlForbiddenError } from '../url-guard.js';

// Heuristic threshold: if Runtime.enable replays >= 1000 events we mark the
// snapshot as truncated. CDP's default in-memory console buffer is 1000.
const HISTORY_REPLAY_BUFFER_HINT = 1000;

type ConsoleApiLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';
type OutputLevel = ConsoleApiLevel | 'exception';

interface RemoteObject {
  type: string;
  subtype?: string;
  className?: string;
  description?: string;
  value?: unknown;
}

interface ConsoleApiCalledParams {
  type: string;
  args: RemoteObject[];
  executionContextId: number;
  timestamp: number;
  stackTrace?: { callFrames: { url: string; lineNumber: number; columnNumber: number }[] };
}

interface ExceptionThrownParams {
  timestamp: number;
  exceptionDetails: {
    text?: string;
    url?: string;
    lineNumber?: number;
    columnNumber?: number;
    exception?: RemoteObject;
    stackTrace?: { callFrames: { url: string; lineNumber: number; columnNumber: number }[] };
  };
}

interface LogEntryAddedParams {
  entry: {
    source: string;
    level: 'verbose' | 'info' | 'warning' | 'error';
    text: string;
    timestamp: number;
    url?: string;
    lineNumber?: number;
    stackTrace?: { callFrames: { url: string; lineNumber: number; columnNumber: number }[] };
  };
}

interface CollectedLog {
  level: OutputLevel;
  text: string;
  source?: string;
  lineno?: number;
  colno?: number;
  timestamp: number;
  stackTrace?: string;
}

function stringifyArg(arg: RemoteObject): string {
  if (arg.type === 'string') return String(arg.value);
  if (arg.type === 'number' || arg.type === 'boolean' || arg.type === 'undefined') {
    return String(arg.value);
  }
  if (arg.type === 'symbol') return arg.description ?? 'Symbol()';
  if (arg.value !== undefined && (arg.type === 'bigint' || typeof arg.value !== 'object')) {
    return String(arg.value);
  }
  return arg.description ?? arg.className ?? arg.type;
}

function flattenStack(
  st?: { callFrames: { url: string; lineNumber: number; columnNumber: number }[] },
): string | undefined {
  if (!st || !st.callFrames || st.callFrames.length === 0) return undefined;
  return st.callFrames
    .map((f) => `    at ${f.url}:${f.lineNumber + 1}:${f.columnNumber + 1}`)
    .join('\n');
}

function mapApiTypeToLevel(t: string): ConsoleApiLevel | null {
  switch (t) {
    case 'log':
    case 'info':
    case 'debug':
    case 'error':
      return t;
    case 'warning':
      return 'warn';
    default:
      return null;
  }
}

function mapLogEntryLevel(l: LogEntryAddedParams['entry']['level']): ConsoleApiLevel {
  switch (l) {
    case 'verbose':
      return 'debug';
    case 'info':
      return 'info';
    case 'warning':
      return 'warn';
    case 'error':
      return 'error';
  }
}

export async function handleGetConsoleLogs(rawParams: unknown): Promise<unknown> {
  const params = GetConsoleLogsInput.parse(rawParams);

  if (params.url) {
    const guard = checkUrlAllowed(params.url);
    if (!guard.ok) return urlForbiddenError(guard.reason);
  }
  const tab = await openOrReuse({ url: params.url, tabId: params.tabId });

  const collected: CollectedLog[] = [];
  let consoleApiHistoryCount = 0;
  const wantedLevels = new Set<ConsoleApiLevel>(params.level);

  // Register the listener BEFORE attach. tryAttachToTab() calls Runtime.enable
  // internally, which is when CDP replays buffered consoleAPICalled events from
  // the in-memory message storage. A listener added afterwards would miss them.
  const onEvent = (
    source: chrome.debugger.Debuggee,
    method: string,
    cdpParams?: unknown,
  ): void => {
    if (source.tabId !== tab.tabId) return;
    if (method === 'Runtime.consoleAPICalled') {
      const p = cdpParams as ConsoleApiCalledParams;
      consoleApiHistoryCount += 1;
      const lvl = mapApiTypeToLevel(p.type);
      if (lvl === null) return;
      if (!wantedLevels.has(lvl)) return;
      const text = (p.args ?? []).map(stringifyArg).join(' ');
      const frame0 = p.stackTrace?.callFrames?.[0];
      collected.push({
        level: lvl,
        text,
        source: frame0?.url,
        lineno: frame0 ? frame0.lineNumber + 1 : undefined,
        colno: frame0 ? frame0.columnNumber + 1 : undefined,
        timestamp: Math.round(p.timestamp),
        stackTrace: lvl === 'error' ? flattenStack(p.stackTrace) : undefined,
      });
    } else if (method === 'Runtime.exceptionThrown' && params.includeExceptions) {
      const p = cdpParams as ExceptionThrownParams;
      const d = p.exceptionDetails;
      const text =
        d.text ?? (d.exception ? stringifyArg(d.exception) : 'Uncaught exception');
      collected.push({
        level: 'exception',
        text,
        source: d.url,
        lineno: typeof d.lineNumber === 'number' ? d.lineNumber + 1 : undefined,
        colno: typeof d.columnNumber === 'number' ? d.columnNumber + 1 : undefined,
        timestamp: Math.round(p.timestamp),
        stackTrace: flattenStack(d.stackTrace),
      });
    } else if (method === 'Log.entryAdded') {
      const p = cdpParams as LogEntryAddedParams;
      const lvl = mapLogEntryLevel(p.entry.level);
      if (!wantedLevels.has(lvl)) return;
      collected.push({
        level: lvl,
        text: p.entry.text,
        source: p.entry.url,
        lineno: typeof p.entry.lineNumber === 'number' ? p.entry.lineNumber + 1 : undefined,
        colno: undefined,
        timestamp: Math.round(p.entry.timestamp),
        stackTrace: lvl === 'error' ? flattenStack(p.entry.stackTrace) : undefined,
      });
    }
  };
  chrome.debugger.onEvent.addListener(onEvent);

  let session: Awaited<ReturnType<typeof tryAttachToTab>>['session'] = null;
  try {
    const attach = await tryAttachToTab(tab.tabId);
    session = attach.session;
    if (!session) {
      chrome.debugger.onEvent.removeListener(onEvent);
      if (!tab.reused) await tab.cleanup();
      if (attach.reason === 'special_page') {
        return {
          error: 'url_forbidden',
          message: 'Cannot read console on special pages (chrome://, devtools://, etc.).',
          hint: 'Pass a regular http(s):// url, or switch to a non-special tab.',
        };
      }
      if (attach.reason === 'tab_gone') {
        return {
          error: 'tab_closed',
          message: 'Tab was closed before console snapshot could attach.',
        };
      }
      return {
        error: 'cdp_attach_failed',
        message: 'Could not attach Chrome debugger after 3 retries.',
        hint: 'Close DevTools (F12) on the target tab and retry.',
      };
    }

    // Runtime.enable has already been called inside tryAttachToTab(); the call
    // here is a defensive no-op so the snapshot still works if cdp.ts ever
    // stops doing that. Log.enable is fresh — it triggers replay of the
    // browser's Log entry buffer.
    await session.send('Runtime.enable', {});
    try {
      await session.send('Log.enable', {});
    } catch (e) {
      console.warn('[byob/get-console-logs] Log.enable failed (best-effort):', e);
    }

    await new Promise((r) => setTimeout(r, params.flushDelayMs));

    const tabInfo = await chrome.tabs.get(tab.tabId);
    collected.sort((a, b) => a.timestamp - b.timestamp);

    return {
      logs: collected,
      truncated: consoleApiHistoryCount >= HISTORY_REPLAY_BUFFER_HINT,
      tabId: tab.tabId,
      url: tabInfo.url ?? params.url ?? '',
    };
  } finally {
    chrome.debugger.onEvent.removeListener(onEvent);
    if (session && !tab.reused) {
      await session.detach();
      await tab.cleanup();
    }
  }
}
