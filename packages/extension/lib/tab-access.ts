import { checkUrlAllowed, urlForbiddenError } from './url-guard.js';

export type TabAccessError =
  | {
      error: 'tab_closed';
      message: string;
    }
  | ReturnType<typeof urlForbiddenError>;

export type TabAccessResult =
  | {
      ok: true;
      tab: chrome.tabs.Tab;
    }
  | {
      ok: false;
      error: TabAccessError;
    };

/**
 * Guard an already-open tab before any operation that does not pass through
 * CDP (switch, close, navigate-in-place). Most content handlers are protected
 * centrally by tryAttachToTab; these chrome.tabs-only paths need the same URL
 * policy explicitly or a caller can bypass the allow/deny lists with tabId.
 */
export async function checkTabAccess(
  tabId: number,
  options: { allowForbiddenProtocol?: boolean } = {},
): Promise<TabAccessResult> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (error) {
    return {
      ok: false,
      error: {
        error: 'tab_closed',
        message: error instanceof Error ? error.message : `tab ${tabId} not found`,
      },
    };
  }

  if (tab.url) {
    const guard = checkUrlAllowed(tab.url);
    const protocolOnly =
      !guard.ok && guard.reason.startsWith('protocol ');
    if (!guard.ok && !(options.allowForbiddenProtocol && protocolOnly)) {
      return { ok: false, error: urlForbiddenError(guard.reason) };
    }
  }

  return { ok: true, tab };
}

export type AttachUrlDecision =
  | { ok: true }
  | {
      ok: false;
      reason: 'special_page' | 'host_forbidden';
      reasonDetail: string;
    };

/**
 * Convert the complete URL policy into the smaller reason vocabulary used by
 * CDP attach callers. Protocol refusals stay "special_page"; built-in auth
 * protection and user host policy refusals become "host_forbidden".
 *
 * Keeping this pure makes the security boundary straightforward to test.
 */
export function classifyAttachUrl(url: string | undefined): AttachUrlDecision {
  if (!url) return { ok: true };
  const guard = checkUrlAllowed(url);
  if (guard.ok) return guard;

  return {
    ok: false,
    reason: guard.reason.startsWith('protocol ') ? 'special_page' : 'host_forbidden',
    reasonDetail: guard.reason,
  };
}
