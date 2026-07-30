type ClipboardMessage =
  | { target: 'byob-offscreen'; action: 'clipboard-read-text' }
  | { target: 'byob-offscreen'; action: 'clipboard-write-text'; text: string };

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

chrome.runtime.onMessage.addListener(
  (
    message: unknown,
    _sender,
    sendResponse: (response: { ok: boolean; text?: string; error?: string }) => void,
  ) => {
    if (
      !message ||
      typeof message !== 'object' ||
      (message as { target?: unknown }).target !== 'byob-offscreen'
    ) {
      return false;
    }

    void (async () => {
      try {
        const request = message as ClipboardMessage;
        if (request.action === 'clipboard-read-text') {
          sendResponse({ ok: true, text: await clipboard.readText() });
        } else {
          await clipboard.writeText(request.text);
          sendResponse({ ok: true });
        }
      } catch (error) {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    return true;
  },
);
