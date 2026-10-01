/// <reference lib="dom" />
/** The toolbar popup (entrypoints/popup.html). State lives in the service worker (toolbar.ts). */
import type { PopupRequest, PopupState } from './toolbar.js';

type WithoutTarget<T> = T extends unknown ? Omit<T, 'target'> : never;
type Op = WithoutTarget<PopupRequest>;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

async function send(op: Op): Promise<void> {
  const s = (await chrome.runtime.sendMessage({ target: 'byob-popup', ...op })) as PopupState | { error: string } | undefined;
  if (s && !('error' in s)) render(s);
}

function time(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function render(s: PopupState): void {
  $('dot').classList.toggle('on', s.connected && !s.paused);
  $('status').textContent = !s.connected ? 'not connected' : s.paused ? 'paused' : s.running ? `working (${s.running})` : 'connected';
  const pause = $<HTMLButtonElement>('pause');
  pause.textContent = s.paused ? 'Resume' : 'Pause';
  pause.setAttribute('aria-pressed', String(s.paused));
  pause.onclick = () => void send({ op: 'pause', paused: !s.paused });
  $('pausedNote').style.display = s.paused ? 'block' : 'none';

  const box = $('handoffs');
  box.replaceChildren();
  $('handoffSection').hidden = s.handoffs.length === 0;
  for (const h of s.handoffs) {
    const card = el('div', 'handoff');
    card.append(el('p', '', h.message));
    const where = el('div', 'where', `${h.title || 'tab'}${h.host ? ` — ${h.host}` : ''} (show)`);
    where.onclick = () => void send({ op: 'focus', id: h.id });
    card.append(where);
    const row = el('div', 'row');
    const no = el('button', '', "I can't");
    no.onclick = () => void send({ op: 'answer', id: h.id, answer: 'declined' });
    const yes = el('button', 'primary', 'Done');
    yes.onclick = () => void send({ op: 'answer', id: h.id, answer: 'done' });
    row.append(no, yes);
    card.append(row);
    box.append(card);
  }

  const list = $('activity');
  list.replaceChildren();
  if (!s.activity.length) list.append(el('li', 'empty', 'Nothing yet.'));
  for (const a of s.activity) {
    const li = el('li', '');
    li.append(el('span', 't', time(a.startedAt)));
    const what = el('span', 'cmd', a.command);
    if (a.host) what.append(el('span', 'host', ` · ${a.host}`));
    li.append(what);
    const r = a.ms === undefined ? el('span', 'r run', 'running')
      : a.ok ? el('span', 'r ok', `${a.ms < 1000 ? `${a.ms}ms` : `${(a.ms / 1000).toFixed(1)}s`}`)
      : el('span', 'r bad', a.errorCode ?? 'error');
    li.append(r);
    list.append(li);
  }
}

void send({ op: 'state' });
setInterval(() => void send({ op: 'state' }), 1000);
