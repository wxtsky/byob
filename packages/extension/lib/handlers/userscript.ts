/**
 * browser_userscript — resident scripts: register JavaScript that Chrome runs
 * on every matching page as it loads, in every tab (not only ones byob has
 * attached to), across reloads and browser restarts. Tampermonkey-style, but
 * the agent manages it.
 *
 * Built on chrome.userScripts. Chrome only exposes that API once the user
 * turns on "Allow User Scripts" for byob (chrome://extensions → byob →
 * Details), so every call checks for it and says how when it's missing.
 *
 * byob keeps its own copy in chrome.storage.local and re-registers on
 * startup, so a script survives Chrome dropping registrations (extension
 * reload / update).
 */
import { Tools } from '@byob/shared';
import { ByobError } from '../errors.js';

const STORE_KEY = 'BYOB_USERSCRIPTS';

export interface StoredScript {
  id: string;
  matches: string[];
  excludeMatches?: string[];
  code: string;
  runAt: 'document_start' | 'document_end' | 'document_idle';
  world: 'MAIN' | 'USER_SCRIPT';
  allFrames: boolean;
  updatedAt: number;
}

type UserScriptsApi = {
  register(scripts: unknown[]): Promise<void>;
  unregister(filter?: { ids?: string[] }): Promise<void>;
  getScripts(filter?: { ids?: string[] }): Promise<{ id: string }[]>;
  configureWorld?(props: { csp?: string; messaging?: boolean }): Promise<void>;
};

function api(): UserScriptsApi {
  let us: UserScriptsApi | undefined;
  try {
    // Accessing it throws (not just returns undefined) while the toggle is off.
    us = (chrome as unknown as { userScripts?: UserScriptsApi }).userScripts;
    void us?.getScripts;
  } catch {
    us = undefined;
  }
  if (!us) {
    throw new ByobError(
      'unknown',
      'Resident scripts need "Allow User Scripts" turned on for byob.',
      'Ask the user: chrome://extensions → byob → Details → turn on "Allow User Scripts" (on Chrome < 138: turn on Developer mode). No reload needed.',
    );
  }
  return us;
}

async function stored(): Promise<StoredScript[]> {
  const v = (await chrome.storage.local.get(STORE_KEY))[STORE_KEY];
  return Array.isArray(v) ? (v as StoredScript[]) : [];
}

function toRegistration(s: StoredScript): Record<string, unknown> {
  return {
    id: s.id,
    matches: s.matches,
    ...(s.excludeMatches?.length ? { excludeMatches: s.excludeMatches } : {}),
    js: [{ code: s.code }],
    runAt: s.runAt,
    world: s.world,
    allFrames: s.allFrames,
  };
}

/** Called at service-worker start: put back anything Chrome forgot. */
export async function restoreUserScripts(): Promise<void> {
  let us: UserScriptsApi;
  try { us = api(); } catch { return; }
  const want = await stored();
  if (!want.length) return;
  const have = new Set((await us.getScripts()).map((s) => s.id));
  const missing = want.filter((s) => !have.has(s.id));
  if (missing.length) await us.register(missing.map(toRegistration));
}

function summary(s: StoredScript): Record<string, unknown> {
  return {
    id: s.id, matches: s.matches, excludeMatches: s.excludeMatches, runAt: s.runAt, world: s.world, allFrames: s.allFrames,
    chars: s.code.length, preview: s.code.length > 160 ? s.code.slice(0, 160) + '…' : s.code, updatedAt: new Date(s.updatedAt).toISOString(),
  };
}

export async function handleUserscript(raw: unknown): Promise<unknown> {
  const p = Tools.UserscriptInput.parse(raw);
  const us = api();
  let all = await stored();

  if (p.action === 'list') {
    const live = new Set((await us.getScripts()).map((s) => s.id));
    return { action: 'list', scripts: all.map((s) => ({ ...summary(s), registered: live.has(s.id) })) };
  }

  if (p.action === 'clear') {
    await us.unregister();
    await chrome.storage.local.set({ [STORE_KEY]: [] });
    return { action: 'clear', removed: all.length };
  }

  if (p.action === 'remove') {
    if (!p.id) throw new ByobError('invalid_argument', 'remove needs id (see action:"list").');
    if (!all.some((s) => s.id === p.id)) throw new ByobError('invalid_argument', `No resident script with id "${p.id}".`);
    await us.unregister({ ids: [p.id] }).catch(() => {});
    all = all.filter((s) => s.id !== p.id);
    await chrome.storage.local.set({ [STORE_KEY]: all });
    return { action: 'remove', id: p.id };
  }

  // add (or replace one with the same id)
  if (!p.matches?.length) throw new ByobError('invalid_argument', 'add needs matches, e.g. ["https://example.com/*"].');
  if (!p.code) throw new ByobError('invalid_argument', 'add needs code.');
  const script: StoredScript = {
    id: p.id ?? `s-${Date.now().toString(36)}`,
    matches: p.matches,
    ...(p.excludeMatches?.length ? { excludeMatches: p.excludeMatches } : {}),
    code: p.code,
    runAt: p.runAt,
    world: p.world,
    allFrames: p.allFrames,
    updatedAt: Date.now(),
  };
  const replaced = all.some((s) => s.id === script.id);
  if (replaced) await us.unregister({ ids: [script.id] }).catch(() => {});
  try {
    await us.register([toRegistration(script)]);
  } catch (e) {
    throw new ByobError('invalid_argument', `Chrome rejected the script: ${(e as Error).message}`, 'Check the match patterns (scheme://host/path, e.g. "https://*.example.com/*").');
  }
  all = [...all.filter((s) => s.id !== script.id), script];
  await chrome.storage.local.set({ [STORE_KEY]: all });
  return { action: 'add', replaced, script: summary(script) };
}
