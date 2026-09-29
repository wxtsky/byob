import { Tools } from '@byob/shared';
import type { ElementHandle } from '../dom/element.js';
import { callOnElement, describeHandle, resolveTarget, waitActionable } from '../dom/element.js';
import { evaluateIsolated } from '../dom/frames.js';
import { modifierMask, mouseClick, mouseMove } from '../input/mouse.js';
import { withEffects } from '../settle.js';
import { actionResult, attach, pickTab, requireTargetOrPoint } from './_common.js';
import { snapshotAfter } from './snapshot.js';

const PROBE_EVENTS = "['pointerdown','mousedown','click','contextmenu','auxclick']";

/**
 * Listen (in byob's isolated world) for trusted pointer events reaching the
 * element, so we can tell a click that landed from one swallowed by
 * something the hit-test couldn't see (an element replaced on mousedown, a
 * transparent overlay with pointer-events tricks…).
 */
async function installProbe(el: ElementHandle, key: string, signal: AbortSignal): Promise<void> {
  await callOnElement(el, `function (key) {
    const el = this;
    // Inside a closed shadow root, window listeners only see the host.
    const hosts = [];
    for (let r = el.getRootNode(); r && r.host; r = r.host.getRootNode()) hosts.push(r.host);
    const st = { down: false, click: false };
    const h = (e) => {
      if (!e.isTrusted) return;
      const path = e.composedPath();
      if (!path.includes(el) && !hosts.some((x) => path.includes(x))) return;
      if (e.type === 'click' || e.type === 'contextmenu' || e.type === 'auxclick') st.click = true; else st.down = true;
    };
    for (const t of ${PROBE_EVENTS}) window.addEventListener(t, h, true);
    const off = () => { for (const t of ${PROBE_EVENTS}) window.removeEventListener(t, h, true); };
    // Self-cleaning: a dialog or navigation may keep us from reading it.
    setTimeout(off, 10000);
    globalThis[key] = { st, off };
  }`, [key], signal);
}

async function readProbe(el: ElementHandle, key: string, signal: AbortSignal): Promise<{ down: boolean; click: boolean } | null> {
  try {
    const k = JSON.stringify(key);
    const r = await evaluateIsolated<{ down: boolean; click: boolean } | null>(
      el.session,
      el.frame,
      `(() => { const p = globalThis[${k}]; if (!p) return null; p.off(); delete globalThis[${k}]; return p.st; })()`,
      { signal },
    );
    return r.value ?? null;
  } catch {
    return null; // the click navigated away — that's a successful click
  }
}

export async function handleClick(raw: unknown, signal: AbortSignal): Promise<unknown> {
  const p = Tools.ClickInput.parse(raw);
  const mode = requireTargetOrPoint(p, 'browser_click');
  const tabId = await pickTab(p);
  const session = await attach(tabId, signal, 'click');
  const opts = { button: p.button, clickCount: p.doubleClick ? 2 : 1, modifiers: modifierMask(p.modifiers) };
  const verb = p.doubleClick ? 'Double-clicked' : p.button === 'right' ? 'Right-clicked' : 'Clicked';

  if (mode === 'point') {
    const { effects } = await withEffects(session, () => mouseClick(session, p.x!, p.y!, opts, signal), { signal });
    return {
      ...actionResult(tabId, `${verb} at (${p.x}, ${p.y})`, effects),
      ...(await snapshotAfter(session, p.snapshot, signal)),
    };
  }

  const el = await resolveTarget(session, p, signal);
  const pt = await waitActionable(el, {
    hitTest: true,
    enabled: true,
    force: p.force,
    timeoutMs: (p.timeoutSec ?? 5) * 1000,
  }, signal);

  let fallback = false;
  const { effects } = await withEffects(session, async () => {
    const key = `__byobProbe_${Math.random().toString(36).slice(2)}`;
    await installProbe(el, key, signal);
    await mouseClick(session, pt.x, pt.y, opts, signal);
    const got = await readProbe(el, key, signal);
    // Nothing reached the element at all: deliver the click to it directly.
    // Only when neither pointerdown nor click arrived, so a UI that reacted
    // to mousedown is never clicked twice.
    if (got && !got.down && !got.click && p.button === 'left' && !p.force) {
      await callOnElement(el, 'function () { this.click(); }', [], signal);
      fallback = true;
    }
  }, { signal });

  let summary = `${verb} ${describeHandle(el)}`;
  if (el.relocated) summary += ' (ref re-found after the page re-rendered)';
  if (fallback) summary += ' — the mouse event did not reach it, so a DOM click() was dispatched';
  return {
    ...actionResult(tabId, summary, effects, { ref: el.ref }),
    ...(await snapshotAfter(session, p.snapshot, signal)),
  };
}

export async function handleHover(raw: unknown, signal: AbortSignal): Promise<unknown> {
  const p = Tools.HoverInput.parse(raw);
  const mode = requireTargetOrPoint(p, 'browser_hover');
  const tabId = await pickTab(p);
  const session = await attach(tabId, signal, 'hover');
  if (mode === 'point') {
    const { effects } = await withEffects(session, () => mouseMove(session, p.x!, p.y!, {}, signal), { signal, graceMs: 60 });
    return {
      ...actionResult(tabId, `Moved the mouse to (${p.x}, ${p.y})`, effects),
      ...(await snapshotAfter(session, p.snapshot, signal)),
    };
  }
  const el = await resolveTarget(session, p, signal);
  const pt = await waitActionable(el, { hitTest: true, timeoutMs: (p.timeoutSec ?? 5) * 1000 }, signal);
  const { effects } = await withEffects(session, () => mouseMove(session, pt.x, pt.y, {}, signal), { signal, graceMs: 60 });
  return {
    ...actionResult(tabId, `Hovering ${describeHandle(el)}`, effects, { ref: el.ref }),
    ...(await snapshotAfter(session, p.snapshot, signal)),
  };
}
