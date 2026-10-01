import { Tools } from '@byob/shared';
import { ByobError } from '../errors.js';
import { callOnElement, describeHandle, hasTarget, resolveTarget, waitActionable, type ElementHandle } from '../dom/element.js';
import { insertText, pressCombo, typeKeystrokes } from '../input/keyboard.js';
import { withEffects, type ActionEffects } from '../settle.js';
import { actionResult, attach, pickTab } from './_common.js';
import { snapshotAfter } from './snapshot.js';

export const SELECT_ALL_FN = `function () {
  const el = this;
  el.focus({ preventScroll: true });
  if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && typeof el.select === 'function') {
    try { el.select(); return 'input'; } catch (e) { /* type=number etc. */ }
    try { el.setSelectionRange(0, el.value.length); return 'input'; } catch (e) { return 'input-noselect'; }
  }
  if (el.isContentEditable) {
    const r = document.createRange();
    r.selectNodeContents(el);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
    return 'ce';
  }
  return 'other';
}`;

export const READ_VALUE_FN = `function () {
  return this.isContentEditable ? this.innerText : ('value' in this ? String(this.value) : this.textContent);
}`;

/** Native-setter fallback: React/Vue controlled inputs update through the
 *  input event even when the text never went through the keyboard path.
 *  Honours maxlength, which a value setter alone would ignore. */
export const SET_VALUE_FN = `function (v) {
  const ml = this.maxLength;
  if (typeof ml === 'number' && ml > 0 && v.length > ml) v = v.slice(0, ml);
  const proto = this.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype
    : this.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const d = Object.getOwnPropertyDescriptor(proto, 'value');
  if (d && d.set) d.set.call(this, v); else this.value = v;
  this.dispatchEvent(new Event('input', { bubbles: true }));
  this.dispatchEvent(new Event('change', { bubbles: true }));
  return String(this.value);
}`;

/** Focus and put the caret at the end (input, textarea or contenteditable). */
export const CARET_END_FN = `function () {
  this.focus({ preventScroll: true });
  if ((this.tagName === 'INPUT' || this.tagName === 'TEXTAREA') && typeof this.setSelectionRange === 'function') {
    try { const n = this.value.length; this.setSelectionRange(n, n); } catch (e) {}
  } else if (this.isContentEditable) {
    const r = document.createRange();
    r.selectNodeContents(this);
    r.collapse(false);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
  }
}`;

const MAX_LENGTH_FN = `function () { return typeof this.maxLength === 'number' ? this.maxLength : -1; }`;

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();
/** Letters and digits only, case-folded: what survives an input mask. */
const loose = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/**
 * Did the field take `text`? Exactly, or reformatted by the page (card /
 * phone masks, upper-casing), or cut short by maxlength.
 */
export function acceptedAs(value: string, text: string, maxLength: number): 'exact' | 'reformatted' | 'truncated' | null {
  if (norm(value) === norm(text)) return 'exact';
  const v = loose(value);
  if (!v) return null;
  const t = loose(text);
  if (v === t) return 'reformatted';
  if (maxLength > 0 && text.length > maxLength && t.startsWith(v)) return 'truncated';
  return null;
}

interface FillResult {
  method: string;
  /** The field's value, when it differs from what was typed. */
  shown?: string;
  how?: 'reformatted' | 'truncated';
}

async function fillElement(
  el: ElementHandle,
  text: string,
  opts: { clear: boolean; slowly: boolean },
  signal: AbortSignal,
): Promise<FillResult> {
  const session = el.session;
  if (opts.clear) {
    const kind = await callOnElement<string>(el, SELECT_ALL_FN, [], signal);
    if (text === '') {
      await pressCombo(session, 'Backspace', signal);
    } else if (opts.slowly) {
      await typeKeystrokes(session, text, signal, 10);
    } else {
      await insertText(session, text, signal);
    }
    const method = opts.slowly ? 'keystrokes' : 'insertText';
    if (kind !== 'input' && kind !== 'input-noselect') return { method };
    const maxLength = await callOnElement<number>(el, MAX_LENGTH_FN, [], signal);
    const now = await callOnElement<string>(el, READ_VALUE_FN, [], signal);
    const typed = acceptedAs(now, text, maxLength);
    if (typed) return typed === 'exact' ? { method } : { method, shown: now, how: typed };
    // The keyboard path didn't land (a controlled input ignored it): set the
    // value the way the framework listens for.
    const after = await callOnElement<string>(el, SET_VALUE_FN, [text], signal);
    const set = acceptedAs(after, text, maxLength);
    if (set) return set === 'exact' ? { method: 'value-setter' } : { method: 'value-setter', shown: after, how: set };
    throw new ByobError('element_not_editable',
      `${describeHandle(el)} did not accept the text (value is ${JSON.stringify(after.slice(0, 60))}).`,
      'The field may reformat or validate input (dates, numbers, masks) — check the expected format.');
  }
  await callOnElement(el, CARET_END_FN, [], signal);
  if (opts.slowly) await typeKeystrokes(session, text, signal, 10);
  else await insertText(session, text, signal);
  return { method: opts.slowly ? 'keystrokes' : 'insertText' };
}

export async function handleType(raw: unknown, signal: AbortSignal): Promise<unknown> {
  const p = Tools.TypeInput.parse(raw);
  if (p.ref !== undefined && p.selector !== undefined) {
    throw new ByobError('invalid_argument', 'browser_type: pass ref or selector, not both.');
  }
  const tabId = await pickTab(p);
  const session = await attach(tabId, signal, 'type');

  let summary: string;
  let effects: ActionEffects = {};
  let ref: string | undefined;
  if (hasTarget(p)) {
    const el = await resolveTarget(session, p, signal);
    ref = el.ref;
    await waitActionable(el, { editable: true, enabled: true, hitTest: false, timeoutMs: (p.timeoutSec ?? 5) * 1000 }, signal);
    const r = await withEffects(session, async () => {
      const f = await fillElement(el, p.text, { clear: p.clear, slowly: !!p.slowly }, signal);
      if (p.submit) await pressCombo(session, 'Enter', signal);
      return f;
    }, { signal, graceMs: p.submit ? 150 : 0 });
    effects = r.effects;
    const f = r.result;
    summary = `${p.clear ? 'Filled' : 'Typed into'} ${describeHandle(el)} with ${p.text.length} chars`
      + (f?.method === 'value-setter' ? ' (set via value setter)' : '')
      + (f?.shown !== undefined
        ? ` — the field ${f.how === 'truncated' ? 'cut it to its maxlength' : 'reformatted it'}: ${JSON.stringify(f.shown.slice(0, 80))}`
        : '')
      + (p.submit ? ' and pressed Enter' : '');
  } else {
    // No target: type into whatever has focus (after a click on the field).
    const focused = await session.send<{ result: { value?: boolean } }>('Runtime.evaluate', {
      expression: `(() => { let a = document.activeElement; while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
        return !!a && a !== document.body && (a.isContentEditable || a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'IFRAME'); })()`,
      returnByValue: true,
    }, signal);
    if (!focused.result.value) {
      throw new ByobError('element_not_focused', 'Nothing editable has focus.',
        'Pass ref/selector of the field, or click it first.');
    }
    const r = await withEffects(session, async () => {
      if (p.clear) await pressCombo(session, 'ControlOrMeta+A', signal);
      if (p.clear && !p.text) await pressCombo(session, 'Backspace', signal);
      else if (p.slowly) await typeKeystrokes(session, p.text, signal, 10);
      else if (p.text) await insertText(session, p.text, signal);
      if (p.submit) await pressCombo(session, 'Enter', signal);
    }, { signal, graceMs: p.submit ? 150 : 0 });
    effects = r.effects;
    summary = `Typed ${p.text.length} chars into the focused field` + (p.submit ? ' and pressed Enter' : '');
  }
  return {
    ...actionResult(tabId, summary, effects, ref ? { ref } : {}),
    ...(await snapshotAfter(session, p.snapshot, signal)),
  };
}

export async function handlePressKey(raw: unknown, signal: AbortSignal): Promise<unknown> {
  const p = Tools.PressKeyInput.parse(raw);
  const tabId = await pickTab(p);
  const session = await attach(tabId, signal, 'press a key');
  let where = '';
  let ref: string | undefined;
  if (hasTarget(p)) {
    const el = await resolveTarget(session, p, signal);
    ref = el.ref;
    await waitActionable(el, { hitTest: false, timeoutMs: 5000 }, signal);
    await callOnElement(el, 'function () { this.focus({ preventScroll: true }); }', [], signal);
    where = ` in ${describeHandle(el)}`;
  }
  const { effects } = await withEffects(session, async () => {
    for (let i = 0; i < p.repeat; i++) await pressCombo(session, p.key, signal);
  }, { signal });
  return {
    ...actionResult(tabId, `Pressed ${p.key}${p.repeat > 1 ? ` ×${p.repeat}` : ''}${where}`, effects, ref ? { ref } : {}),
    ...(await snapshotAfter(session, p.snapshot, signal)),
  };
}
