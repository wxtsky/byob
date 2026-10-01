/**
 * The offscreen document's message handler: clipboard access, the screen
 * recorder (offscreen-recorder.ts) and PDF text extraction (pdf-text.ts).
 * Requests come from the service worker via offscreen.ts and carry
 * `target: 'byob-offscreen'`.
 */
import { handleRecorderMessage, type RecorderMessage } from './offscreen-recorder.js';
import { handlePdfMessage, type PdfMessage } from './pdf-text.js';

type ClipboardMessage =
  | { action: 'clipboard-read-text' }
  | { action: 'clipboard-write-text'; text: string };

const clipboard = (
  globalThis as unknown as {
    navigator: {
      clipboard: {
        readText(): Promise<string>;
        writeText(text: string): Promise<void>;
      };
    };
  }
).navigator.clipboard;

type OffscreenMessage = ClipboardMessage | RecorderMessage | PdfMessage;

async function handle(request: OffscreenMessage): Promise<Record<string, unknown>> {
  if (request.action === 'clipboard-read-text') return { ok: true, text: await clipboard.readText() };
  if (request.action === 'clipboard-write-text') {
    await clipboard.writeText(request.text);
    return { ok: true };
  }
  if (request.action.startsWith('pdf-')) return handlePdfMessage(request as PdfMessage);
  return handleRecorderMessage(request as RecorderMessage);
}

chrome.runtime.onMessage.addListener(
  (message: unknown, _sender, sendResponse: (response: Record<string, unknown>) => void) => {
    if (!message || typeof message !== 'object' || (message as { target?: unknown }).target !== 'byob-offscreen') {
      return false;
    }
    handle(message as OffscreenMessage).then(sendResponse, (error: unknown) =>
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
    return true;
  },
);
