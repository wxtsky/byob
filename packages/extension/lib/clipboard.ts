type ClipboardRequest =
  | { target: 'byob-offscreen'; action: 'clipboard-read-text' }
  | { target: 'byob-offscreen'; action: 'clipboard-write-text'; text: string };

type ClipboardResponse =
  | { ok: true; text?: string }
  | { ok: false; error: string };

let creatingDocument: Promise<void> | null = null;

async function ensureOffscreenDocument(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) return;
  if (!creatingDocument) {
    creatingDocument = chrome.offscreen
      .createDocument({
        url: 'offscreen.html',
        reasons: [chrome.offscreen.Reason.CLIPBOARD],
        justification: 'Read or write clipboard text only after an explicit byob tool call.',
      })
      .finally(() => {
        creatingDocument = null;
      });
  }
  await creatingDocument;
}

async function sendClipboardRequest(request: ClipboardRequest): Promise<ClipboardResponse> {
  await ensureOffscreenDocument();
  return chrome.runtime.sendMessage<ClipboardRequest, ClipboardResponse>(request);
}

export async function readClipboardText(): Promise<string> {
  const response = await sendClipboardRequest({
    target: 'byob-offscreen',
    action: 'clipboard-read-text',
  });
  if (!response.ok) throw new Error(response.error);
  return response.text ?? '';
}

export async function writeClipboardText(text: string): Promise<void> {
  const response = await sendClipboardRequest({
    target: 'byob-offscreen',
    action: 'clipboard-write-text',
    text,
  });
  if (!response.ok) throw new Error(response.error);
}
