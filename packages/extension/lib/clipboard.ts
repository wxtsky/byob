import { offscreenRequest } from './offscreen.js';

type ClipboardResponse =
  | { ok: true; text?: string }
  | { ok: false; error: string };

export async function readClipboardText(): Promise<string> {
  const response = await offscreenRequest<ClipboardResponse>({ action: 'clipboard-read-text' });
  if (!response.ok) throw new Error(response.error);
  return response.text ?? '';
}

export async function writeClipboardText(text: string): Promise<void> {
  const response = await offscreenRequest<ClipboardResponse>({ action: 'clipboard-write-text', text });
  if (!response.ok) throw new Error(response.error);
}
