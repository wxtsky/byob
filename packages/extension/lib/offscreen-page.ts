/**
 * The offscreen document's message handler: clipboard access and the
 * screen recorder (see offscreen-recorder.ts). Requests come from the
 * service worker via offscreen.ts and carry `target: 'byob-offscreen'`.
 */
import { handleRecorderMessage, type RecorderMessage } from './offscreen-recorder.js';

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

async function handle(request: ClipboardMessage | RecorderMessage): Promise<Record<string, unknown>> {
  if (request.action === 'clipboard-read-text') return { ok: true, text: await clipboard.readText() };
  if (request.action === 'clipboard-write-text') {
    await clipboard.writeText(request.text);
    return { ok: true };
  }
  return handleRecorderMessage(request);
}

chrome.runtime.onMessage.addListener(
  (message: unknown, _sender, sendResponse: (response: Record<string, unknown>) => void) => {
    if (!message || typeof message !== 'object' || (message as { target?: unknown }).target !== 'byob-offscreen') {
      return false;
    }
    handle(message as ClipboardMessage | RecorderMessage).then(sendResponse, (error: unknown) =>
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
    return true;
  },
);
