import { SelectInput } from '@byob/shared';
import { tryAttachToTab } from '../cdp.js';
import {
  resolveFrame,
  evaluateInResolvedFrame,
  frameErrorToEnvelope,
} from '../frame-resolver.js';
import { openOrReuse } from '../tab.js';
import { checkUrlAllowed, urlForbiddenError } from '../url-guard.js';
import { throwIfAborted } from '../signal-utils.js';
import { resolveByobIdxSelector } from './selector-resolver.js';

export async function handleSelect(
  rawParams: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const params = SelectInput.parse(rawParams);
  const selector = resolveByobIdxSelector(params.selector);
  if (params.url) {
    const guard = checkUrlAllowed(params.url);
    if (!guard.ok) return urlForbiddenError(guard.reason);
  }
  throwIfAborted(signal);

  const tab = await openOrReuse({ url: params.url, tabId: params.tabId, signal });

  const { session, reason } = await tryAttachToTab(tab.tabId, signal);
  if (!session) return attachErrorToEnvelope(reason);

  let frame;
  try {
    frame = await resolveFrame(session, params.framePath, signal);
  } catch (e) {
    const env = frameErrorToEnvelope(e);
    if (env) return env;
    throw e;
  }

  const sel = JSON.stringify(selector);
  const wantValue = JSON.stringify(params.value ?? null);
  const wantLabel = JSON.stringify(params.label ?? null);
  const wantIndex = params.index ?? -1;

  const expr = `(() => {
    const select = document.querySelector(${sel});
    if (!select || select.tagName !== 'SELECT') return { error: 'selector_not_found' };
    const options = Array.from(select.options);
    let target = null;
    if (${wantValue} !== null) target = options.find(o => o.value === ${wantValue}) || null;
    else if (${wantLabel} !== null) target = options.find(o => (o.label || o.text) === ${wantLabel}) || null;
    else if (${wantIndex} >= 0) target = options[${wantIndex}] || null;
    if (!target) return { error: 'option_not_found' };
    select.value = target.value;
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return {
      selectedValue: target.value,
      selectedLabel: target.label || target.text,
      url: location.href,
    };
  })()`;

  const result = await evaluateInResolvedFrame<
    { error?: string; selectedValue?: string; selectedLabel?: string; url?: string }
  >(session, frame, expr, { awaitPromise: false, returnByValue: true, signal });

  if (result.error === 'selector_not_found') {
    return { error: 'selector_not_found', message: `No <select> matched ${params.selector}` };
  }
  if (result.error === 'option_not_found') {
    return { error: 'option_not_found', message: 'No matching <option> for the given value/label/index' };
  }
  return {
    tabId: tab.tabId,
    url: result.url ?? '',
    selectedValue: result.selectedValue ?? '',
    selectedLabel: result.selectedLabel ?? '',
  };
}

function attachErrorToEnvelope(
  reason?: 'special_page' | 'tab_gone' | 'attach_failed' | 'flatten_unsupported',
): { error: string; message: string; hint?: string } {
  if (reason === 'special_page') {
    return {
      error: 'url_forbidden',
      message: 'Tab is on a special page (chrome://, devtools://, etc.) — CDP cannot attach.',
      hint: 'Switch to a regular http(s):// tab.',
    };
  }
  if (reason === 'tab_gone') return { error: 'tab_closed', message: 'Tab was closed.' };
  return {
    error: 'cdp_attach_failed',
    message: 'Could not attach Chrome debugger after 3 retries.',
    hint: 'Close DevTools (F12) on the target tab and retry.',
  };
}
