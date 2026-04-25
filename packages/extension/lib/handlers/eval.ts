import { EvalInput } from '@byob/shared';
import { tryAttachToTab } from '../cdp.js';
import { notifyEval, recordAndCheckRate } from '../notify.js';
import { resolveFrame, frameErrorToEnvelope } from '../frame-resolver.js';
import { isAbortError, throwIfAborted } from '../signal-utils.js';

/**
 * v0.2: When CDP attach fails (DevTools held the target, extension just
 * reloaded, etc.), fall back to chrome.scripting.executeScript in MAIN world.
 * Behavioural diffs vs CDP are documented in
 * docs/superpowers/specs/2026-04-25-v0.2-stability-design.md §5.3.
 *
 * The fallback ONLY triggers on `attach_failed` (not `special_page` /
 * `tab_gone`, since chrome.scripting can't help there) and is NOT triggered
 * by frame-resolution failures — framePath errors have their own
 * envelopes that should surface to callers unchanged.
 */
export async function handleEval(rawParams: unknown, signal?: AbortSignal): Promise<unknown> {
  const params = EvalInput.parse(rawParams);

  const tabId = params.tabId ?? (await activeTabId());
  if (tabId === null) return { error: 'unknown', message: 'No active tab' };
  if (signal) throwIfAborted(signal);

  if (!recordAndCheckRate(tabId)) {
    return {
      error: 'rate_limited',
      message: 'Too many eval calls in this tab in the last minute',
    };
  }

  const tab = await chrome.tabs.get(tabId);
  notifyEval(tabId, tab.url ?? '', params.code);

  const { session, reason } = await tryAttachToTab(tabId, signal);
  if (!session) {
    if (reason === 'special_page') {
      return {
        error: 'url_forbidden',
        message: 'Active tab is on a special page (chrome://, devtools://, etc.) — CDP cannot attach.',
        hint: 'Switch to a regular http(s):// tab.',
      };
    }
    if (reason === 'tab_gone') return { error: 'tab_closed', message: 'Tab was closed.' };
    // CDP attach itself failed (DevTools held / SW just reloaded). Try
    // chrome.scripting fallback. framePath is unsupported here — if the
    // caller asked for a nested frame we surface a hint instead of silently
    // running the code in the main frame.
    if (reason === 'attach_failed') {
      if (params.framePath.length > 0) {
        return {
          error: 'cdp_attach_failed',
          message: 'Could not attach Chrome debugger after 3 retries; chrome.scripting fallback cannot target framePath.',
          hint: 'Close DevTools (F12) on the target tab and retry, or omit framePath.',
        };
      }
      try {
        return await runFallback(tabId, params.code, signal);
      } catch (fbE) {
        if (isAbortError(fbE)) throw fbE;
        return {
          error: 'cdp_attach_failed',
          message: `CDP attach and chrome.scripting fallback both failed: ${fbE instanceof Error ? fbE.message : String(fbE)}`,
          hint: 'Close DevTools, ensure the tab is on http(s)://, and retry.',
        };
      }
    }
    return {
      error: 'cdp_attach_failed',
      message: 'Could not attach Chrome debugger after 3 retries.',
      hint: 'Close DevTools (F12) on the target tab and retry.',
    };
  }

  if (signal) throwIfAborted(signal);

  let frame;
  try {
    frame = await resolveFrame(session, params.framePath);
  } catch (e) {
    const env = frameErrorToEnvelope(e);
    if (env) return env;
    throw e;
  }

  const evalParams = {
    contextId: frame.contextId,
    expression: params.code,
    awaitPromise: params.awaitPromise,
    returnByValue: params.returnByValue,
  };
  let res;
  try {
    res = frame.sessionId
      ? await session.sendOnSession<{
          result: { value?: unknown; type: string };
          exceptionDetails?: unknown;
        }>(frame.sessionId, 'Runtime.evaluate', evalParams)
      : await session.send<{
          result: { value?: unknown; type: string };
          exceptionDetails?: unknown;
        }>('Runtime.evaluate', evalParams, signal);
  } catch (e) {
    if (isAbortError(e)) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    if (/sandbox|isolated|blocked/i.test(msg)) {
      return {
        error: 'frame_eval_blocked',
        message: `Eval blocked in target frame (sandboxed without allow-scripts?): ${msg}`,
        hint: 'Add allow-scripts to the iframe sandbox attribute, or evaluate in the main frame.',
      };
    }
    throw e;
  }
  if (res.exceptionDetails) {
    return {
      error: 'eval_exception',
      message: 'Page threw during eval',
      exceptionDetails: res.exceptionDetails,
    };
  }
  return {
    result: res.result?.value,
    resultType: res.result?.type ?? 'undefined',
    fallbackUsed: false,
  };
}

/**
 * Fallback path: chrome.scripting.executeScript({ world: 'MAIN' }).
 * Runtime semantics intentionally diverge from CDP — see spec §5.3.
 * We wrap the user's code in `(async () => { return (eval(code)); })()`
 * so that:
 *   - returning a Promise gets awaited (CDP awaitPromise:true parity)
 *   - thrown errors surface in result.exceptionDetails-equivalent form
 */
async function runFallback(
  tabId: number,
  code: string,
  signal?: AbortSignal,
): Promise<unknown> {
  if (signal) throwIfAborted(signal);
  // chrome.scripting doesn't expose an AbortSignal; we approximate by
  // checking before and after. The script body itself will run to
  // completion in the page even if signal aborts mid-execution; the
  // dispatcher will discard the eventual result either way because the
  // request id has already been removed from inFlight.
  type ScriptingResult = { result?: unknown; error?: { message: string } };
  let frames: ScriptingResult[];
  try {
    frames = (await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      // args[0] = the user's code string.
      func: (userCode: string): unknown => {
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        const r = (0, eval)(`(async () => { return (${userCode}); })()`);
        return r;
      },
      args: [code],
    })) as ScriptingResult[];
  } catch (e) {
    if (signal) throwIfAborted(signal);
    throw e;
  }
  if (signal) throwIfAborted(signal);
  const first = frames[0];
  if (!first) {
    return {
      error: 'eval_exception',
      message: 'chrome.scripting returned no frames',
      fallbackUsed: true,
    };
  }
  if (first.error) {
    return {
      error: 'eval_exception',
      message: first.error.message,
      fallbackUsed: true,
    };
  }
  return {
    result: first.result,
    resultType: typeof first.result,
    fallbackUsed: true,
  };
}

async function activeTabId(): Promise<number | null> {
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return t?.id ?? null;
}
