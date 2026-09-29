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
 *  input event even when the text never went through the keyboard path. */
export const SET_VALUE_FN = `function (v) {
  const proto = this.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype
    : this.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const d = Object.getOwnPropertyDescriptor(proto, 'value');
  if (d && d.set) d.set.call(this, v); else this.value = v;
  this.dispatchEvent(new Event('input', { bubbles: true }));
  this.dispatchEvent(new Event('change', { bubbles: true }));
  return String(this.value);
}`;

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();

async function fillElement(
  el: ElementHandle,
  text: string,
  opts: { clear: boolean; slowly: boolean },
  signal: AbortSignal,
): Promise<{ method: string }> {
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
    const now = await callOnElement<string>(el, READ_VALUE_FN, [], signal);
    if (norm(now) === norm(text)) return { method: opts.slowly ? 'keystrokes' : 'insertText' };
    if (kind === 'input' || kind === 'input-noselect') {
      const after = await callOnElement<string>(el, SET_VALUE_FN, [text], signal);
      if (norm(after) === norm(text)) return { method: 'value-setter' };
      throw new ByobError('element_not_editable',
        `${describeHandle(el)} did not accept the text (value is ${JSON.stringify(after.slice(0, 60))}).`,
        'The field may reformat or validate input (dates, numbers, masks) — check the expected format.');
    }
    return { method: 'insertText' };
  }
  await callOnElement(el, `function () {
    this.focus({ preventScroll: true });
    if ((this.tagName === 'INPUT' || this.tagName === 'TEXTAREA') && typeof this.setSelectionRange === 'function') {
      try { const n = this.value.length; this.setSelectionRange(n, n); } catch (e) {}
    }
  }`, [], signal);
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
    summary = `${p.clear ? 'Filled' : 'Typed into'} ${describeHandle(el)} with ${p.text.length} chars`
      + (r.result?.method === 'value-setter' ? ' (set via value setter)' : '')
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
      if (p.slowly) await typeKeystrokes(session, p.text, signal, 10);
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
