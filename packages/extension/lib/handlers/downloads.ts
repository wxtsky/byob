import { Tools } from '@byob/shared';
import { listDownloads, waitDownload, displayName, type TrackedDownload } from '../downloads.js';

/** What the agent sees of a download. */
function view(d: TrackedDownload): Record<string, unknown> {
  return {
    id: d.id,
    tabId: d.tabId,
    name: displayName(d),
    url: d.url,
    state: d.state,
    ...(d.filename ? { path: d.filename } : {}),
    ...(d.bytes !== undefined ? { bytes: d.bytes } : {}),
    ...(d.totalBytes !== undefined ? { totalBytes: d.totalBytes } : {}),
    ...(d.mime ? { mime: d.mime } : {}),
    ...(d.error ? { error: d.error } : {}),
  };
}

/** browser_downloads: only downloads byob's own actions started. */
export async function handleDownloads(raw: unknown, signal: AbortSignal): Promise<unknown> {
  const p = Tools.DownloadsInput.parse(raw);
  if (p.action === 'list') return { action: 'list', downloads: listDownloads().map(view) };
  const r = await waitDownload(p.id, p.timeoutSec * 1000, signal);
  return { action: 'wait', download: view(r.download), ...(r.inProgress ? { inProgress: true } : {}) };
}
