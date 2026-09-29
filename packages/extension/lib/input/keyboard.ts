/**
 * Keyboard input through CDP Input.dispatchKeyEvent.
 *
 * A bare `{type:'keyDown', key:'Enter'}` looks plausible but does nothing
 * useful: Chrome only runs a key's default action (submit a form, insert a
 * newline, move focus on Tab, delete on Backspace) when the event carries the
 * right `code`, `windowsVirtualKeyCode` and, for keys that produce input, the
 * `text`. This module holds a US layout table so every key is fully described.
 */
import type { CdpSession } from '../cdp.js';
import { ByobError } from '../errors.js';

interface KeyDef {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
  /** Key produced with Shift held (for printable keys). */
  shiftKey?: string;
  location?: number;
}

const DEFS = new Map<string, KeyDef>();
const BY_CHAR = new Map<string, { def: KeyDef; shift: boolean }>();

function add(def: KeyDef): void {
  DEFS.set(def.key, def);
  if (def.text !== undefined) BY_CHAR.set(def.text, { def, shift: false });
  if (def.shiftKey) {
    const shifted = { ...def, key: def.shiftKey, text: def.shiftKey };
    DEFS.set(def.shiftKey, shifted);
    BY_CHAR.set(def.shiftKey, { def: shifted, shift: true });
  }
}

for (let i = 0; i < 26; i++) {
  const lower = String.fromCharCode(97 + i);
  const upper = lower.toUpperCase();
  add({ key: lower, code: `Key${upper}`, keyCode: 65 + i, text: lower, shiftKey: upper });
}
const SHIFT_DIGITS = ')!@#$%^&*(';
for (let d = 0; d < 10; d++) {
  add({ key: String(d), code: `Digit${d}`, keyCode: 48 + d, text: String(d), shiftKey: SHIFT_DIGITS[d] });
}
for (const [key, code, keyCode, shiftKey] of [
  ['`', 'Backquote', 192, '~'], ['-', 'Minus', 189, '_'], ['=', 'Equal', 187, '+'],
  ['[', 'BracketLeft', 219, '{'], [']', 'BracketRight', 221, '}'], ['\\', 'Backslash', 220, '|'],
  [';', 'Semicolon', 186, ':'], ["'", 'Quote', 222, '"'], [',', 'Comma', 188, '<'],
  ['.', 'Period', 190, '>'], ['/', 'Slash', 191, '?'],
] as const) {
  add({ key, code, keyCode, text: key, shiftKey });
}
add({ key: ' ', code: 'Space', keyCode: 32, text: ' ' });
add({ key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' });
for (const [key, keyCode, code] of [
  ['Tab', 9], ['Backspace', 8], ['Delete', 46], ['Escape', 27], ['Insert', 45],
  ['ArrowLeft', 37], ['ArrowUp', 38], ['ArrowRight', 39], ['ArrowDown', 40],
  ['Home', 36], ['End', 35], ['PageUp', 33], ['PageDown', 34],
  ['CapsLock', 20], ['ContextMenu', 93],
  ['Shift', 16, 'ShiftLeft'], ['Control', 17, 'ControlLeft'], ['Alt', 18, 'AltLeft'], ['Meta', 91, 'MetaLeft'],
] as Array<[string, number, string?]>) {
  DEFS.set(key, { key, code: code ?? key, keyCode, location: code ? 1 : 0 });
}
for (let f = 1; f <= 12; f++) DEFS.set(`F${f}`, { key: `F${f}`, code: `F${f}`, keyCode: 111 + f });
// Newline / tab typed as text map to their keys.
BY_CHAR.set('\n', { def: DEFS.get('Enter')!, shift: false });
BY_CHAR.set('\r', { def: DEFS.get('Enter')!, shift: false });
BY_CHAR.set('\t', { def: DEFS.get('Tab')!, shift: false });

const ALIASES: Record<string, string> = {
  esc: 'Escape', escape: 'Escape', return: 'Enter', enter: 'Enter', space: ' ', spacebar: ' ',
  del: 'Delete', delete: 'Delete', backspace: 'Backspace', tab: 'Tab',
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
  arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight',
  pageup: 'PageUp', pagedown: 'PageDown', home: 'Home', end: 'End', insert: 'Insert',
  ctrl: 'Control', control: 'Control', cmd: 'Meta', command: 'Meta', meta: 'Meta', super: 'Meta',
  win: 'Meta', alt: 'Alt', option: 'Alt', opt: 'Alt', shift: 'Shift',
  controlormeta: 'ControlOrMeta', cmdorctrl: 'ControlOrMeta', commandorcontrol: 'ControlOrMeta',
  plus: '+', minus: '-',
};

const MODIFIER_BIT: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

export const IS_MAC = typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent);

function canonical(name: string): string {
  if (DEFS.has(name)) return name;
  const alias = ALIASES[name.toLowerCase()];
  if (alias) return alias === 'ControlOrMeta' ? (IS_MAC ? 'Meta' : 'Control') : alias;
  if (/^f([1-9]|1[0-2])$/i.test(name)) return name.toUpperCase();
  if (name.length === 1 && DEFS.has(name.toLowerCase())) return name;
  throw new ByobError('invalid_argument', `Unknown key "${name}"`,
    'Use names like Enter, Tab, Escape, ArrowDown, Backspace, a, F5 — combine with "+", e.g. "Control+A" or "ControlOrMeta+C".');
}

/** "Control+Shift+K" → { modifiers: ['Control','Shift'], key: 'K' }. A literal "+" key is allowed. */
export function parseCombo(combo: string): { modifiers: string[]; key: string } {
  const parts: string[] = [];
  let s = combo.trim();
  while (s.length) {
    const i = s.indexOf('+', 1);
    if (i === -1) {
      parts.push(s);
      break;
    }
    parts.push(s.slice(0, i));
    s = s.slice(i + 1);
  }
  if (parts.length === 0) throw new ByobError('invalid_argument', 'Empty key');
  const names = parts.map((p) => canonical(p.trim() || '+'));
  let key = names.pop()!;
  // "Control+K" means the K key: a real keyboard reports e.key === "k"
  // unless Shift is held, and sites compare case-sensitively.
  if (/^[A-Z]$/.test(key) && !names.includes('Shift')) key = key.toLowerCase();
  for (const m of names) {
    if (!(m in MODIFIER_BIT)) {
      throw new ByobError('invalid_argument', `"${m}" is not a modifier in "${combo}"`,
        'Only Control, Shift, Alt, Meta (or ControlOrMeta) can precede the final key.');
    }
  }
  return { modifiers: names, key };
}

/** macOS editing shortcuts only fire through the `commands` field. */
function macCommands(mods: string[], key: string): string[] | undefined {
  if (!IS_MAC || !mods.includes('Meta')) return undefined;
  const k = key.toLowerCase();
  const shift = mods.includes('Shift');
  if (k === 'a') return ['selectAll'];
  if (k === 'c') return ['copy'];
  if (k === 'x') return ['cut'];
  if (k === 'v') return ['paste'];
  if (k === 'z') return [shift ? 'redo' : 'undo'];
  return undefined;
}

type Send = (method: string, params: Record<string, unknown>) => Promise<unknown>;

function sender(session: CdpSession, signal?: AbortSignal): Send {
  return (method, params) => session.send(method, params, signal);
}

async function keyEvent(send: Send, type: string, def: KeyDef, modifiers: number, text?: string, commands?: string[]): Promise<void> {
  await send('Input.dispatchKeyEvent', {
    type,
    key: def.key,
    code: def.code,
    windowsVirtualKeyCode: def.keyCode,
    nativeVirtualKeyCode: def.keyCode,
    modifiers,
    ...(def.location ? { location: def.location } : {}),
    ...(text ? { text, unmodifiedText: text } : {}),
    ...(commands ? { commands } : {}),
  });
}

/** Press a key or combo, e.g. "Enter", "Shift+Tab", "ControlOrMeta+A". */
export async function pressCombo(session: CdpSession, combo: string, signal?: AbortSignal): Promise<void> {
  const { modifiers, key } = parseCombo(combo);
  const send = sender(session, signal);
  let mask = 0;
  for (const m of modifiers) {
    mask |= MODIFIER_BIT[m]!;
    await keyEvent(send, 'rawKeyDown', DEFS.get(m)!, mask);
  }
  let def = DEFS.get(key)!;
  if (mask & MODIFIER_BIT.Shift! && def.shiftKey) def = DEFS.get(def.shiftKey) ?? def;
  // Text is only produced when no command modifier is held (Shift is fine).
  const text = mask & ~MODIFIER_BIT.Shift! ? undefined : def.text;
  const commands = macCommands(modifiers, key);
  await keyEvent(send, text ? 'keyDown' : 'rawKeyDown', def, mask, text, commands);
  await keyEvent(send, 'keyUp', def, mask);
  for (const m of [...modifiers].reverse()) {
    mask &= ~MODIFIER_BIT[m]!;
    await keyEvent(send, 'keyUp', DEFS.get(m)!, mask);
  }
}

/** Type text as individual keystrokes; characters off the US layout use insertText. */
export async function typeKeystrokes(
  session: CdpSession,
  text: string,
  signal?: AbortSignal,
  delayMs = 0,
): Promise<void> {
  const send = sender(session, signal);
  for (const ch of text) {
    const hit = BY_CHAR.get(ch);
    if (hit) {
      const mask = hit.shift ? MODIFIER_BIT.Shift! : 0;
      await keyEvent(send, 'keyDown', hit.def, mask, hit.def.text);
      await keyEvent(send, 'keyUp', hit.def, mask);
    } else {
      await send('Input.insertText', { text: ch });
    }
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }
}

export async function insertText(session: CdpSession, text: string, signal?: AbortSignal): Promise<void> {
  await session.send('Input.insertText', { text }, signal);
}
