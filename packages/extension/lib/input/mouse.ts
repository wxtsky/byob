import type { CdpSession } from '../cdp.js';

export type MouseButton = 'left' | 'right' | 'middle';

const BUTTON_MASK: Record<MouseButton, number> = { left: 1, right: 2, middle: 4 };
const MOD_BIT: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

export function modifierMask(mods: readonly string[] = []): number {
  let m = 0;
  for (const k of mods) m |= MOD_BIT[k] ?? 0;
  return m;
}

export async function mouseMove(
  session: CdpSession,
  x: number,
  y: number,
  opts: { modifiers?: number; buttons?: number } = {},
  signal?: AbortSignal,
): Promise<void> {
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x, y, modifiers: opts.modifiers ?? 0, buttons: opts.buttons ?? 0,
  }, signal);
}

/**
 * A real click: move, then press/release once per click. A double click is
 * two press/release pairs with clickCount 1 then 2 — what Chrome itself
 * emits — so both `click` and `dblclick` listeners fire.
 */
export async function mouseClick(
  session: CdpSession,
  x: number,
  y: number,
  opts: { button?: MouseButton; clickCount?: number; modifiers?: number } = {},
  signal?: AbortSignal,
): Promise<void> {
  const button = opts.button ?? 'left';
  const modifiers = opts.modifiers ?? 0;
  await mouseMove(session, x, y, { modifiers }, signal);
  const count = Math.max(1, opts.clickCount ?? 1);
  for (let i = 1; i <= count; i++) {
    const common = { x, y, button, clickCount: i, modifiers };
    await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', buttons: BUTTON_MASK[button], ...common }, signal);
    await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', buttons: 0, ...common }, signal);
  }
}

export async function mouseWheel(
  session: CdpSession,
  x: number,
  y: number,
  deltaX: number,
  deltaY: number,
  signal?: AbortSignal,
): Promise<void> {
  await session.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY }, signal);
}

export async function mouseDown(session: CdpSession, x: number, y: number, signal?: AbortSignal): Promise<void> {
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 }, signal);
}

export async function mouseUp(session: CdpSession, x: number, y: number, signal?: AbortSignal): Promise<void> {
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 }, signal);
}
