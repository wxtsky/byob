import { ClipboardReadTextInput, ErrorCode } from '@byob/shared';
import { readClipboardText } from '../clipboard.js';
import { throwIfAborted } from '../signal-utils.js';
import { checkTabAccess } from '../tab-access.js';

export async function handleClipboardReadText(
  rawParams: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const params = ClipboardReadTextInput.parse(rawParams);
  throwIfAborted(signal);
  const access = await checkTabAccess(params.tabId);
  if (!access.ok) return access.error;
  try {
    return { text: await readClipboardText() };
  } catch (error) {
    return {
      error: ErrorCode.CLIPBOARD_FAILED,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
