import { StopRecordNetworkInput } from '@byob/shared';
import { getRecording, deleteRecording } from '../recording-registry.js';
import { endRecording } from './start-record-network.js';
import { recordsToHar } from '../har-converter.js';

const HAR_CREATOR = { name: 'byob', version: '0.2.0' };

export async function handleStopRecordNetwork(
  rawParams: unknown,
  _signal?: AbortSignal,
): Promise<unknown> {
  const params = StopRecordNetworkInput.parse(rawParams);
  const entry = getRecording(params.recordingId);
  if (!entry) {
    return {
      error: 'recording_not_found',
      message: `No recording with id ${params.recordingId}`,
      hint: 'Recording may have ended automatically (timeout/max_records/tab_closed) and been GCed, or never started.',
    };
  }

  if (entry.state === 'recording' && params.flushDelayMs > 0) {
    await new Promise((r) => setTimeout(r, params.flushDelayMs));
  }

  if (entry.state === 'recording') {
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
  };

  if (params.format === 'har') {
    out.har = recordsToHar(records, HAR_CREATOR);
  }

  deleteRecording(params.recordingId);

  return out;
}
