/**
 * Site policy management for the `byob policy` CLI (bridge route /policy).
 * Not an MCP tool, and not reachable through the generic /call route.
 *
 * Tightening applies at once. Loosening — allowing more hosts, removing a
 * deny entry, enabling file:// or login pages — only happens after the user
 * clicks "Allow" on an extension page that byob itself can never drive
 * (url-guard refuses byob's own origin), so neither an agent nor another
 * local program can widen byob's reach on its own.
 */
import { z } from 'zod';
import { ByobError } from '../errors.js';
import { FLAG_KEYS, HOST_POLICY_KEYS, coerceDomainList } from '../url-guard.js';

const PolicyInput = z.object({
  allowedDomains: z.array(z.string()).optional(),
  deniedDomains: z.array(z.string()).optional(),
  allowFile: z.boolean().optional(),
  allowAuthDomains: z.boolean().optional(),
});

interface Current {
  allowedDomains: string[];
  deniedDomains: string[];
  allowFile: boolean;
  allowAuthDomains: boolean;
}

async function current(): Promise<Current> {
  const cur = await chrome.storage.local.get([...FLAG_KEYS, ...HOST_POLICY_KEYS] as unknown as string[]);
  return {
    allowedDomains: coerceDomainList(cur.BYOB_ALLOWED_DOMAINS),
    deniedDomains: coerceDomainList(cur.BYOB_DENIED_DOMAINS),
    allowFile: !!cur.BYOB_ALLOW_FILE,
    allowAuthDomains: !!cur.BYOB_ALLOW_AUTH_DOMAINS,
  };
}

/** Human-readable list of the ways `next` grants more access than `cur`. */
export function looseningChanges(cur: Current, next: Partial<Current>): string[] {
  const out: string[] = [];
  if (next.allowedDomains) {
    if (cur.allowedDomains.length && !next.allowedDomains.length) out.push('Remove the allowlist (allow every site)');
    else if (cur.allowedDomains.length) {
      const added = next.allowedDomains.filter((d) => !cur.allowedDomains.includes(d));
      if (added.length) out.push(`Also allow: ${added.join(', ')}`);
    }
  }
  if (next.deniedDomains) {
    const removed = cur.deniedDomains.filter((d) => !next.deniedDomains!.includes(d));
    if (removed.length) out.push(`Stop blocking: ${removed.join(', ')}`);
  }
  if (next.allowFile && !cur.allowFile) out.push('Allow file:// URLs (local files)');
  if (next.allowAuthDomains && !cur.allowAuthDomains) out.push('Allow login pages (accounts.google.com, …)');
  return out;
}

const pending = new Map<string, (approve: boolean) => void>();

function onMessage(msg: unknown, sender: chrome.runtime.MessageSender): void {
  const m = msg as { target?: string; id?: string; approve?: boolean };
  if (m?.target !== 'byob-policy' || !m.id) return;
  // Only our own confirmation page may answer.
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL('confirm.html'))) return;
  pending.get(m.id)?.(m.approve === true);
}
if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage && !chrome.runtime.onMessage.hasListener?.(onMessage)) {
  chrome.runtime.onMessage.addListener(onMessage);
}

async function askUser(changes: string[], signal: AbortSignal): Promise<boolean> {
  const id = crypto.randomUUID();
  await chrome.storage.session.set({ [`policy-request:${id}`]: { changes } });
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL(`confirm.html?id=${id}`),
    type: 'popup',
    width: 460,
    height: 320,
    focused: true,
  });
  let onRemoved: ((wid: number) => void) | null = null;
  try {
    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 120_000);
      const done = (v: boolean): void => {
        clearTimeout(timer);
        resolve(v);
      };
      pending.set(id, done);
      signal.addEventListener('abort', () => done(false), { once: true });
      // Closing the window counts as "Reject".
      onRemoved = (wid: number): void => {
        if (wid === win?.id) done(false);
      };
      chrome.windows.onRemoved.addListener(onRemoved);
    });
  } finally {
    if (onRemoved) chrome.windows.onRemoved.removeListener(onRemoved);
    pending.delete(id);
    await chrome.storage.session.remove(`policy-request:${id}`);
    if (win?.id !== undefined) await chrome.windows.remove(win.id).catch(() => {});
  }
}

export async function handlePolicy(raw: unknown, signal: AbortSignal): Promise<unknown> {
  const p = PolicyInput.parse(raw ?? {});
  const cur = await current();
  const next: Partial<Current> = {};
  if (p.allowedDomains) next.allowedDomains = coerceDomainList(p.allowedDomains);
  if (p.deniedDomains) next.deniedDomains = coerceDomainList(p.deniedDomains);
  if (p.allowFile !== undefined) next.allowFile = p.allowFile;
  if (p.allowAuthDomains !== undefined) next.allowAuthDomains = p.allowAuthDomains;

  const loosening = looseningChanges(cur, next);
  if (loosening.length && !(await askUser(loosening, signal))) {
    throw new ByobError('url_forbidden', 'The change was not approved in the browser; the policy is unchanged.');
  }
  const set: Record<string, unknown> = {};
  if (next.allowedDomains) set.BYOB_ALLOWED_DOMAINS = next.allowedDomains;
  if (next.deniedDomains) set.BYOB_DENIED_DOMAINS = next.deniedDomains;
  if (next.allowFile !== undefined) set.BYOB_ALLOW_FILE = next.allowFile;
  if (next.allowAuthDomains !== undefined) set.BYOB_ALLOW_AUTH_DOMAINS = next.allowAuthDomains;
  if (Object.keys(set).length) await chrome.storage.local.set(set);
  return { ...(await current()), changed: Object.keys(set), confirmed: loosening.length > 0 };
}
