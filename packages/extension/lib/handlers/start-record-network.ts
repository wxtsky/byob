import { StartRecordNetworkInput } from '@byob/shared';
import { tryAttachToTab } from '../cdp.js';
import { attachErrorEnvelope } from '../attach-error.js';
import { openOrReuse } from '../tab.js';
import { checkUrlAllowed, urlForbiddenError } from '../url-guard.js';
import { keepAwakeStart, keepAwakeEnd } from '../keepalive.js';
import {
  addRecording,
  getRecording,
  type RecordingEntry,
  type RecordingOptions,
  type EndedReason,
} from '../recording-registry.js';
import {
  installNetworkListeners,
  fetchResponseBody,
  type AccumulatorContext,
} from '../network-events.js';
import { throwIfAborted } from '../signal-utils.js';

/**
 * Signal is honored only on the start-up critical path (URL check, openOrReuse,
 * attach, Network.enable). Once recording is registered we hand back to the
 * client; subsequent CDP traffic (Network.* events, fetchResponseBody) lives in
 * its own lifetime governed by stop_record_network / timeout / tab_closed.
 */
export async function handleStartRecordNetwork(
  rawParams: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const params = StartRecordNetworkInput.parse(rawParams);

  if (params.url) {
    const guard = checkUrlAllowed(params.url);
    if (!guard.ok) return urlForbiddenError(guard.reason);
  }
  throwIfAborted(signal);

  const tab = await openOrReuse({
    url: params.url,
    tabId: params.tabId,
    signal,
  });

  const attachResult = await tryAttachToTab(tab.tabId, signal);
  const { session } = attachResult;
  if (!session) {
    if (!tab.reused) await tab.cleanup();
    return attachErrorEnvelope(attachResult, { what: 'recording' });
  }

  try {
    await session.send(
      'Network.enable',
      {
        maxTotalBufferSize: 16 * 1024 * 1024,
        maxResourceBufferSize: 4 * 1024 * 1024,
        maxPostDataSize: params.maxBodyBytes,
      },
      signal,
    );
  } catch (e) {
    if (!tab.reused) {
      try { await session.detach(); } catch { /* already detached */ }
      await tab.cleanup();
    }
    return {
      error: 'recording_failed_to_attach',
      message: `Network.enable failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const recordingId = crypto.randomUUID();
  const startedAt = Date.now();

  const options: RecordingOptions = {
    resourceTypes: params.resourceTypes,
    urlPattern: params.urlPattern,
    includeRequestBody: params.includeRequestBody,
    includeResponseBody: params.includeResponseBody,
    maxBodyBytes: params.maxBodyBytes,
    maxRecords: params.maxRecords,
    captureWebSocketFrames: params.captureWebSocketFrames,
    maxFrameBytes: params.maxFrameBytes,
    timeoutMs: params.timeoutMs,
  };

  const ctx: AccumulatorContext = {
    buffer: new Map(),
    options,
    wsBudgetUsed: 0,
  };

  const cleanups = installNetworkListeners({
    session,
    tabId: tab.tabId,
    ctx,
    onMaxRecords: () => endRecording(recordingId, 'max_records'),
    onLoadingFinished: (requestId) => {
      if (!params.includeResponseBody) return;
      const rec = ctx.buffer.get(requestId);
      if (!rec) return;
      void fetchResponseBody(session, rec, params.maxBodyBytes);
    },
  });

  const tabRemovedListener = (closedId: number): void => {
    if (closedId !== tab.tabId) return;
    void endRecording(recordingId, 'tab_closed');
  };
  chrome.tabs.onRemoved.addListener(tabRemovedListener);

  const timeoutId = setTimeout(
    () => void endRecording(recordingId, 'timeout'),
    params.timeoutMs,
  );

  keepAwakeStart();
  const entry: RecordingEntry = {
    recordingId,
    tabId: tab.tabId,
    session,
    buffer: ctx.buffer,
    wsBudgetUsed: ctx.wsBudgetUsed,
    options,
    startedAt,
    listenerCleanups: cleanups,
    state: 'recording',
    timeoutId,
    tabRemovedListener,
    keepaliveHeld: true,
  };
  addRecording(entry);

  let currentUrl = params.url ?? '';
  try {
    const t = await chrome.tabs.get(tab.tabId);
    currentUrl = t.url ?? currentUrl;
  } catch {
    // tab may have just closed; use whatever we have
  }

  return {
    recordingId,
    tabId: tab.tabId,
    url: currentUrl,
    startedAt,
  };
}

/**
 * Mark a recording entry as ended and tear down listeners + Network domain +
 * keepalive. Idempotent — safe to call multiple times. Does NOT delete the
 * registry entry; stop_record_network drains and deletes.
 */
export async function endRecording(
  recordingId: string,
  reason: EndedReason,
): Promise<void> {
  const entry = getRecording(recordingId);
  if (!entry) return;
  if (entry.state === 'ended') return;

  entry.state = 'ended';
  entry.endedReason = reason;
  entry.endedAt = Date.now();

  if (entry.timeoutId !== null) {
    clearTimeout(entry.timeoutId);
    entry.timeoutId = null;
  }
  if (entry.tabRemovedListener) {
    chrome.tabs.onRemoved.removeListener(entry.tabRemovedListener);
    entry.tabRemovedListener = null;
  }
  for (const c of entry.listenerCleanups) {
    try { c(); } catch { /* ignore */ }
  }
  entry.listenerCleanups = [];

  try {
    if (entry.session.isAttached && reason !== 'tab_closed') {
      await entry.session.send('Network.disable', {});
    }
  } catch {
    // ignore
  }

  if (entry.session.isAttached) {
    let othersUsingTab = false;
    const { getRegistry } = await import('../recording-registry.js');
    for (const e of getRegistry().values()) {
      if (e.recordingId !== recordingId && e.tabId === entry.tabId && e.state === 'recording') {
        othersUsingTab = true;
        break;
      }
    }
    if (!othersUsingTab) {
      try { await entry.session.detach(); } catch { /* ignore */ }
    }
  }

  if (entry.keepaliveHeld) {
    keepAwakeEnd();
    entry.keepaliveHeld = false;
  }
}
