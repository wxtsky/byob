import { ClipboardWriteTextInput, ErrorCode } from '@byob/shared';
import { writeClipboardText } from '../clipboard.js';
import { throwIfAborted } from '../signal-utils.js';
import { checkTabAccess } from '../tab-access.js';

export async function handleClipboardWriteText(
  rawParams: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const params = ClipboardWriteTextInput.parse(rawParams);
  throwIfAborted(signal);
  const access = await checkTabAccess(params.tabId);
  if (!access.ok) return access.error;
  try {
    await writeClipboardText(params.text);
    return { success: true as const };
  } catch (error) {
    return {
      error: ErrorCode.CLIPBOARD_FAILED,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
