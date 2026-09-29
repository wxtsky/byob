/**
 * browser_record — a video of one tab.
 *
 * Frames: CDP Page.startScreencast (every frame acked). A hidden tab — the
 * agent's background tabs, a minimised window — stops producing screencast
 * frames, so a pump falls back to Page.captureScreenshot whenever the
 * screencast has been silent for two frame intervals. Frames go to the
 * offscreen document, which encodes them (canvas → MediaRecorder → WebM).
 * No chrome.tabCapture: it needs a user gesture.
 *
 * Ends on stop, tab close, debugger detach (DevTools, "cancel" on Chrome's
 * debugging bar, wake recovery), the size cap or the duration cap; stop
 * then returns what was recorded plus why it ended early. Recording carries
 * on across navigations (the screencast is re-armed on each).
 */
import { Tools } from '@byob/shared';
import type { CdpSession } from '../cdp.js';
import { ByobError } from '../errors.js';
import { observe } from '../event-hub.js';
import { keepAwakeEnd, keepAwakeStart } from '../keepalive.js';
import { offscreenRequest } from '../offscreen.js';
import { throwIfAborted } from '../signal-utils.js';
import { attach, pickTab, tabSummary } from './_common.js';

/** Base64 of the result travels in one Native Messaging frame (64 MiB max). */
const MAX_BYTES = 40 * 1024 * 1024;
const MAX_MS = 10 * 60 * 1000;
const BITRATE = 2_000_000;
/** Multiple of 3, so base64 chunks concatenate into valid base64. */
const CHUNK = 3 * 1024 * 1024;

type EndReason = 'stopped' | 'tab_closed' | 'detached' | 'size_cap' | 'max_duration' | 'error';

interface ScreenRec {
  id: string;
  tabId: number;
  session: CdpSession;
  fps: number;
  startedAt: number;
  frames: number;
  /** Last frame handed to the encoder (rate limit). */
  lastFrameAt: number;
  /** Last screencast frame; the pump takes over while it's silent. */
  lastCastAt: number;
  bytes: number;
  /** A frame is on its way to the encoder. */
  sending: boolean;
  /** The pump's captureScreenshot is in flight. */
  capturing: boolean;
  state: 'recording' | 'ended';
  endReason?: EndReason;
  endError?: string;
  video?: { bytes: number; durationMs: number };
  ending?: Promise<void>;
  cleanups: Array<() => void>;
}

const recs = new Map<string, ScreenRec>();

type Reply = { ok: boolean; error?: string; bytes?: number; durationMs?: number; data?: string; total?: number };

async function offscreen(message: Record<string, unknown>): Promise<Reply> {
  const r = await offscreenRequest<Reply | undefined>(message);
  if (!r) throw new ByobError('unknown', 'The offscreen recorder did not answer.');
  if (!r.ok) throw new ByobError('unknown', `Recorder: ${r.error ?? 'failed'}`);
  return r;
}

/** Hand one JPEG to the encoder; drops frames while the previous is in flight. */
function push(rec: ScreenRec, data: string): void {
  if (rec.state !== 'recording' || rec.sending) return;
  rec.sending = true;
  rec.lastFrameAt = Date.now();
  offscreen({ action: 'record-frame', id: rec.id, data })
    .then((r) => {
      rec.frames++;
      rec.bytes = r.bytes ?? rec.bytes;
      if (rec.bytes >= MAX_BYTES) void end(rec, 'size_cap');
    })
    .catch((e: unknown) => void end(rec, 'error', e instanceof Error ? e.message : String(e)))
    .finally(() => { rec.sending = false; });
}

function startScreencast(rec: ScreenRec): void {
  rec.session
    .send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: 1280, maxHeight: 1280 })
    .catch(() => { /* the pump covers it */ });
}

function end(rec: ScreenRec, reason: EndReason, detail?: string): Promise<void> {
  if (!rec.ending) {
    rec.state = 'ended';
    rec.endReason = reason;
    if (detail) rec.endError = detail;
    for (const c of rec.cleanups.splice(0)) {
      try { c(); } catch { /* ignore */ }
    }
    keepAwakeEnd();
    rec.ending = (async () => {
      if (reason !== 'tab_closed' && reason !== 'detached') {
        await rec.session.send('Page.stopScreencast').catch(() => {});
      }
      // Let an in-flight frame land before the encoder is closed.
      for (let i = 0; i < 20 && rec.sending; i++) await new Promise((r) => setTimeout(r, 25));
      try {
        const r = await offscreen({ action: 'record-stop', id: rec.id });
        rec.video = { bytes: r.bytes ?? 0, durationMs: r.durationMs ?? 0 };
      } catch (e) {
        rec.endError = e instanceof Error ? e.message : String(e);
        rec.video = { bytes: 0, durationMs: 0 };
      }
    })();
  }
  return rec.ending;
}

async function start(p: Tools.RecordInputT, signal: AbortSignal): Promise<unknown> {
  const tabId = await pickTab(p);
  for (const r of recs.values()) {
    if (r.tabId === tabId && r.state === 'recording') {
      throw new ByobError('invalid_argument', `Tab ${tabId} is already being recorded (id ${r.id}).`,
        `Stop it first: browser_record {action:"stop", id:"${r.id}"}.`);
    }
  }
  const session = await attach(tabId, signal, 'record');
  const id = `rec-${crypto.randomUUID().slice(0, 8)}`;
  await offscreen({ action: 'record-start', id, fps: p.fps, bitrate: BITRATE });
  const rec: ScreenRec = {
    id, tabId, session, fps: p.fps, startedAt: Date.now(), frames: 0, lastFrameAt: 0, lastCastAt: 0, bytes: 0,
    sending: false, capturing: false, state: 'recording', cleanups: [],
  };
  recs.set(id, rec);
  keepAwakeStart();
  const interval = 1000 / p.fps;

  rec.cleanups.push(observe((e) => {
    if (e.tabId !== tabId || e.sessionId) return;
    if (e.method === 'Page.screencastFrame') {
      // Ack every frame, or Chrome stops sending them.
      session.send('Page.screencastFrameAck', { sessionId: e.params.sessionId }).catch(() => {});
      rec.lastCastAt = Date.now();
      if (Date.now() - rec.lastFrameAt >= interval * 0.8) push(rec, e.params.data as string);
    } else if (e.method === 'Page.frameNavigated' && !e.params.frame?.parentId) {
      startScreencast(rec);
    }
  }));
  const onRemoved = (closed: number): void => {
    if (closed === tabId) void end(rec, 'tab_closed');
  };
  chrome.tabs.onRemoved.addListener(onRemoved);
  rec.cleanups.push(() => chrome.tabs.onRemoved.removeListener(onRemoved));
  const onDetach = (source: chrome.debugger.Debuggee): void => {
    if (source.tabId === tabId) void end(rec, 'detached');
  };
  chrome.debugger.onDetach.addListener(onDetach);
  rec.cleanups.push(() => chrome.debugger.onDetach.removeListener(onDetach));

  // Screencast is silent when the tab is hidden (or simply unchanged):
  // capture directly instead.
  const pump = setInterval(() => {
    // byob itself detached (wake recovery, another tool's cleanup): no
    // onDetach event for that, so notice it here.
    if (!session.isAttached) return void end(rec, 'detached');
    if (rec.sending || rec.capturing || Date.now() - rec.lastCastAt < interval * 2) return;
    rec.capturing = true;
    session
      .send<{ data: string }>('Page.captureScreenshot', { format: 'jpeg', quality: 70, fromSurface: true, optimizeForSpeed: true })
      .then((shot) => { if (shot?.data) push(rec, shot.data); })
      .catch(() => { /* navigating / crashed: try again next tick */ })
      .finally(() => { rec.capturing = false; });
  }, interval);
  rec.cleanups.push(() => clearInterval(pump));
  const cap = setTimeout(() => void end(rec, 'max_duration'), MAX_MS);
  rec.cleanups.push(() => clearTimeout(cap));

  startScreencast(rec);
  // Cancelled while starting: don't leave a recording nobody knows about.
  if (signal.aborted) {
    await end(rec, 'stopped');
    await offscreen({ action: 'record-free', id }).catch(() => {});
    recs.delete(id);
    throwIfAborted(signal);
  }
  return { ...(await tabSummary(tabId)), id, fps: p.fps, recording: true };
}

async function stop(p: Tools.RecordInputT, signal: AbortSignal): Promise<unknown> {
  let rec = p.id ? recs.get(p.id) : undefined;
  if (!rec && !p.id) {
    const candidates = [...recs.values()].filter((r) => p.tabId === undefined || r.tabId === p.tabId);
    rec = candidates.length === 1 ? candidates[0] : candidates.find((r) => r.state === 'recording' && r.tabId === p.tabId);
  }
  if (!rec) {
    const ids = [...recs.keys()];
    throw new ByobError('invalid_argument', p.id ? `No recording ${p.id}.` : 'No recording to stop.',
      ids.length ? `Running: ${ids.join(', ')} — pass id.` : 'Start one with browser_record {action:"start"}.');
  }
  await end(rec, 'stopped');
  const total = rec.video?.bytes ?? 0;
  if (!total) {
    recs.delete(rec.id);
    await offscreen({ action: 'record-free', id: rec.id }).catch(() => {});
    throw new ByobError('unknown', `Recording ${rec.id} captured no video${rec.endError ? `: ${rec.endError}` : '.'}`,
      'Was the tab closed right away? Try again and keep the tab open while recording.');
  }
  const parts: string[] = [];
  for (let offset = 0; offset < total; offset += CHUNK) {
    throwIfAborted(signal);
    parts.push((await offscreen({ action: 'record-chunk', id: rec.id, offset, size: CHUNK })).data ?? '');
  }
  recs.delete(rec.id);
  await offscreen({ action: 'record-free', id: rec.id }).catch(() => {});
  return {
    ...(await tabSummary(rec.tabId)),
    id: rec.id,
    _b64Data: parts.join(''),
    mimeType: 'video/webm',
    bytes: total,
    durationMs: rec.video?.durationMs ?? 0,
    frames: rec.frames,
    ...(rec.endReason !== 'stopped' ? { endedEarly: rec.endReason } : {}),
  };
}

export async function handleRecord(raw: unknown, signal: AbortSignal): Promise<unknown> {
  const p = Tools.RecordInput.parse(raw);
  return p.action === 'start' ? start(p, signal) : stop(p, signal);
}
