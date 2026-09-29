/**
 * Screen-recorder half that runs in the offscreen document (a hidden page,
 * so it has canvas + MediaRecorder, which the service worker lacks).
 *
 * The service worker forwards JPEG frames of the tab; each is drawn onto a
 * canvas whose captureStream() feeds a MediaRecorder (WebM). A 1 s heartbeat
 * redraws the last frame so static stretches still advance the video's
 * timeline. On stop the WebM gets its Duration patched in (MediaRecorder
 * writes live-style files without one, which breaks seeking) and is handed
 * back to the service worker in base64 chunks.
 */
import fixWebmDuration from 'fix-webm-duration';

// Window APIs; the extension's tsconfig has no DOM lib.
interface Bitmap { width: number; height: number; close(): void }
interface Ctx2D {
  fillStyle: string;
  fillRect(x: number, y: number, w: number, h: number): void;
  drawImage(img: Bitmap, x: number, y: number, w: number, h: number): void;
}
interface Canvas { width: number; height: number; getContext(k: '2d'): Ctx2D | null; captureStream(fps: number): unknown }
interface Recorder {
  state: string;
  ondataavailable: ((e: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  start(timeslice: number): void;
  stop(): void;
}
const W = globalThis as unknown as {
  document: { createElement(tag: 'canvas'): Canvas };
  createImageBitmap(b: Blob): Promise<Bitmap>;
  MediaRecorder: { new (stream: unknown, o: { mimeType: string; videoBitsPerSecond: number }): Recorder; isTypeSupported(t: string): boolean };
};

const MAX_SIDE = 1280;
const ORPHAN_MS = 120_000;

interface Rec {
  fps: number;
  bitrate: number;
  canvas?: Canvas;
  ctx?: Ctx2D;
  recorder?: Recorder;
  chunks: Blob[];
  bytes: number;
  last?: Bitmap;
  heartbeat?: ReturnType<typeof setInterval>;
  firstFrameAt?: number;
  lastMsgAt: number;
  stopped?: Promise<{ blob: Blob; durationMs: number }>;
  blob?: Blob;
}

const recs = new Map<string, Rec>();

function mimeType(): string {
  for (const t of ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm']) {
    if (W.MediaRecorder.isTypeSupported(t)) return t;
  }
  return 'video/webm';
}

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(buf: Uint8Array): string {
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Letterbox the frame into the fixed-size canvas (the page may resize). */
function draw(r: Rec, bmp: Bitmap): void {
  const { canvas, ctx } = r;
  if (!canvas || !ctx) return;
  const s = Math.min(canvas.width / bmp.width, canvas.height / bmp.height);
  const w = bmp.width * s;
  const h = bmp.height * s;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
}

/** The recorder starts on the first frame, sized to it (even dimensions for VP8). */
function begin(r: Rec, bmp: Bitmap): void {
  const s = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const canvas = W.document.createElement('canvas');
  canvas.width = Math.max(2, Math.round((bmp.width * s) / 2) * 2);
  canvas.height = Math.max(2, Math.round((bmp.height * s) / 2) * 2);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d canvas context');
  r.canvas = canvas;
  r.ctx = ctx;
  const recorder = new W.MediaRecorder(canvas.captureStream(r.fps), { mimeType: mimeType(), videoBitsPerSecond: r.bitrate });
  recorder.ondataavailable = (e) => {
    if (e.data.size) {
      r.chunks.push(e.data);
      r.bytes += e.data.size;
    }
  };
  r.recorder = recorder;
  r.firstFrameAt = Date.now();
  draw(r, bmp);
  recorder.start(1000);
  r.heartbeat = setInterval(() => {
    if (r.last && recorder.state === 'recording') draw(r, r.last);
  }, 1000);
}

function stop(r: Rec): Promise<{ blob: Blob; durationMs: number }> {
  if (!r.stopped) {
    if (r.heartbeat) clearInterval(r.heartbeat);
    const recorder = r.recorder;
    r.stopped = !recorder
      ? Promise.resolve({ blob: new Blob([], { type: 'video/webm' }), durationMs: 0 })
      : new Promise((resolve) => {
          const durationMs = Date.now() - (r.firstFrameAt ?? Date.now());
          recorder.onstop = () => {
            const raw = new Blob(r.chunks, { type: 'video/webm' });
            r.chunks = [];
            fixWebmDuration(raw, durationMs, { logger: false })
              .catch(() => raw)
              .then((blob) => resolve({ blob, durationMs }));
          };
          if (r.last) draw(r, r.last); // one last frame so the timeline reaches "now"
          recorder.stop();
        });
  }
  return r.stopped;
}

function free(id: string): void {
  const r = recs.get(id);
  if (!r) return;
  if (r.heartbeat) clearInterval(r.heartbeat);
  if (r.recorder && r.recorder.state !== 'inactive') r.recorder.stop();
  r.last?.close();
  recs.delete(id);
}

// The service worker keeps the recording state; if it died, nobody will
// ever collect these — drop them.
setInterval(() => {
  for (const [id, r] of recs) if (Date.now() - r.lastMsgAt > ORPHAN_MS) free(id);
}, 30_000);

export type RecorderMessage =
  | { action: 'record-start'; id: string; fps: number; bitrate: number }
  | { action: 'record-frame'; id: string; data: string }
  | { action: 'record-stop'; id: string }
  | { action: 'record-chunk'; id: string; offset: number; size: number }
  | { action: 'record-free'; id: string };

export async function handleRecorderMessage(m: RecorderMessage): Promise<Record<string, unknown>> {
  if (m.action === 'record-start') {
    recs.set(m.id, { fps: m.fps, bitrate: m.bitrate, chunks: [], bytes: 0, lastMsgAt: Date.now() });
    return { ok: true };
  }
  if (m.action === 'record-free') {
    free(m.id);
    return { ok: true };
  }
  const r = recs.get(m.id);
  if (!r) return { ok: false, error: `unknown recording ${m.id}` };
  r.lastMsgAt = Date.now();
  switch (m.action) {
    case 'record-frame': {
      if (r.stopped) return { ok: true, bytes: r.bytes };
      const bmp = await W.createImageBitmap(new Blob([b64ToBytes(m.data)], { type: 'image/jpeg' }));
      if (!r.recorder) begin(r, bmp);
      else draw(r, bmp);
      r.last?.close();
      r.last = bmp;
      return { ok: true, bytes: r.bytes };
    }
    case 'record-stop': {
      const { blob, durationMs } = await stop(r);
      r.blob = blob;
      return { ok: true, bytes: blob.size, durationMs };
    }
    case 'record-chunk': {
      if (!r.blob) return { ok: false, error: 'recording not stopped' };
      const part = new Uint8Array(await r.blob.slice(m.offset, m.offset + m.size).arrayBuffer());
      return { ok: true, data: bytesToB64(part), total: r.blob.size };
    }
  }
}
