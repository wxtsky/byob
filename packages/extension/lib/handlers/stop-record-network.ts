import { StopRecordNetworkInput } from '@byob/shared';
import { getRecording, deleteRecording, type RecordingEntry } from '../recording-registry.js';
import { endRecording } from './start-record-network.js';
import { recordsToHar } from '../har-converter.js';
import { sleepWithSignal, throwIfAborted } from '../signal-utils.js';

const HAR_CREATOR = { name: 'byob', version: '0.4.1' };

export async function handleStopRecordNetwork(
  rawParams: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const params = StopRecordNetworkInput.parse(rawParams);
  throwIfAborted(signal);
  const entry = getRecording(params.recordingId);
  if (!entry) {
    return {
      error: 'recording_not_found',
      message: `No recording with id ${params.recordingId}`,
      hint: 'Recording may have ended automatically (timeout/max_records/tab_closed) and been GCed, or never started.',
    };
  }

  let waited: { wanted: number; got: number; timedOut: boolean } | undefined;
  if (entry.state === 'recording' && params.waitFor) {
    waited = await waitForFinished(entry, params.waitFor, params.waitTimeoutMs, signal);
  } else if (entry.state === 'recording' && params.flushDelayMs > 0) {
    await sleepWithSignal(params.flushDelayMs, signal);
  }

  if (entry.state === 'recording') {
    // Bodies are fetched as requests finish; Network.disable would cut off
    // the ones still in flight (each gives up after 5 s on its own).
    if (entry.pendingBodies?.size) await Promise.allSettled([...entry.pendingBodies]);
    await endRecording(params.recordingId, 'user_stop');
  }

  const records = Array.from(entry.buffer.values()).sort(
    (a, b) => a.timing.startTime - b.timing.startTime,
  );
  const truncated = records.length >= entry.options.maxRecords;
  const durationMs = (entry.endedAt ?? Date.now()) - entry.startedAt;
  const endedReason = entry.endedReason ?? 'user_stop';

  const out: Record<string, unknown> = {
    records,
    truncated,
    durationMs,
    recordCount: records.length,
    endedReason,
    tabId: entry.tabId,
    ...(waited ? { waited } : {}),
  };

  if (params.format === 'har') {
    out.har = recordsToHar(records, HAR_CREATOR);
  }

  deleteRecording(params.recordingId);

  return out;
}

/** Requests that are over: finished or failed (WebSockets never are). */
function finishedCount(entry: RecordingEntry): number {
  let n = 0;
  for (const r of entry.buffer.values()) if (r.resourceType !== 'websocket' && r.timing.endTime !== undefined) n++;
  return n;
}

/**
 * Wait until `wanted` recorded requests are over, the recording ends on its
 * own (timeout / max records / tab closed), or `timeoutMs` passes. Never
 * throws on timeout: the caller reports what did arrive.
 */
async function waitForFinished(
  entry: RecordingEntry,
  wanted: number,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<{ wanted: number; got: number; timedOut: boolean }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const got = finishedCount(entry);
    if (got >= wanted || entry.state !== 'recording') return { wanted, got, timedOut: false };
    if (Date.now() >= deadline) return { wanted, got, timedOut: true };
    await sleepWithSignal(Math.min(100, deadline - Date.now()), signal);
  }
}
