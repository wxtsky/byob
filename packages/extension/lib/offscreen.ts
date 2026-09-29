/**
 * The one offscreen document (an extension may have only one). It serves
 * clipboard access and the screen recorder (canvas + MediaRecorder → Blob),
 * so it is created with both reasons whichever feature needs it first.
 */
let creatingDocument: Promise<void> | null = null;

export async function ensureOffscreenDocument(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) return;
  if (!creatingDocument) {
    creatingDocument = chrome.offscreen
      .createDocument({
        url: 'offscreen.html',
        reasons: [chrome.offscreen.Reason.CLIPBOARD, chrome.offscreen.Reason.BLOBS],
        justification:
          'Clipboard text only after an explicit byob tool call; encode browser_record screen recordings (canvas + MediaRecorder).',
      })
      .finally(() => {
        creatingDocument = null;
      });
  }
  await creatingDocument;
}

/** Messages the offscreen document answers carry this target. */
export const OFFSCREEN_TARGET = 'byob-offscreen';

export async function offscreenRequest<T>(message: Record<string, unknown>): Promise<T> {
  await ensureOffscreenDocument();
  return chrome.runtime.sendMessage<Record<string, unknown>, T>({ target: OFFSCREEN_TARGET, ...message });
}
