/**
 * Plumbing shared by the v0.5 handlers: which tab, attach, target
 * resolution, and the "report what happened" payload.
 */
import type { CdpSession } from '../cdp.js';
import { tryAttachToTab } from '../cdp.js';
import { attachErrorEnvelope } from '../attach-error.js';
import { ByobError } from '../errors.js';
import { activeTabId } from '../tab.js';
import { checkTabAccess } from '../tab-access.js';
import { resolveTarget, type ElementHandle, type TargetSpec, hasTarget } from '../dom/element.js';
import { tabOfRef, normalizeRef } from '../refs.js';
import type { ActionEffects } from '../settle.js';

/**
 * The tab a call applies to: explicit tabId, else the tab that minted the
 * ref (so `{ref:"e12"}` alone works), else the user's active tab.
 */
export async function pickTab(params: { tabId?: number; ref?: string }): Promise<number> {
  if (params.tabId !== undefined) {
    const access = await checkTabAccess(params.tabId, { allowForbiddenProtocol: true });
    if (!access.ok) {
      const env = access.error as { error: string; message: string; hint?: string };
      throw new ByobError(env.error as never, env.message, env.hint);
    }
    return params.tabId;
  }
  if (params.ref) {
    const r = normalizeRef(params.ref);
    const owner = r ? tabOfRef(r) : undefined;
    if (owner !== undefined) return owner;
  }
  const id = await activeTabId();
  if (id === null) throw new ByobError('tab_closed', 'No open tab.', 'Open one with browser_navigate.');
  return id;
}

export async function attach(tabId: number, signal: AbortSignal, what?: string): Promise<CdpSession> {
  const r = await tryAttachToTab(tabId, signal);
  if (!r.session) {
    const env = attachErrorEnvelope(r, { what });
    throw new ByobError(env.error as never, env.message, env.hint);
  }
  return r.session;
}

/** Tab + session + (optional) resolved element in one call. */
export async function withTarget(
  params: { tabId?: number } & TargetSpec,
  signal: AbortSignal,
): Promise<{ tabId: number; session: CdpSession; el: ElementHandle }> {
  const tabId = await pickTab(params);
  const session = await attach(tabId, signal);
  const el = await resolveTarget(session, params, signal);
  return { tabId, session, el };
}

export function requireTargetOrPoint(p: TargetSpec & { x?: number; y?: number }, tool: string): 'target' | 'point' {
  const t = hasTarget(p);
  const pt = p.x !== undefined || p.y !== undefined;
  if (p.ref !== undefined && p.selector !== undefined) {
    throw new ByobError('invalid_argument', `${tool}: pass ref or selector, not both.`);
  }
  if (t && pt) throw new ByobError('invalid_argument', `${tool}: pass a target (ref/selector) or x+y, not both.`);
  if (pt) {
    if (p.x === undefined || p.y === undefined) throw new ByobError('invalid_argument', `${tool}: x and y go together.`);
    return 'point';
  }
  if (!t) throw new ByobError('invalid_argument', `${tool}: pass ref (from browser_snapshot), selector, or x+y.`);
  return 'target';
}

export async function tabSummary(tabId: number): Promise<{ tabId: number; url: string; title: string }> {
  try {
    const t = await chrome.tabs.get(tabId);
    return { tabId, url: t.url ?? '', title: t.title ?? '' };
  } catch {
    return { tabId, url: '', title: '' };
  }
}

/** Common result shape for actions. */
export function actionResult(
  tabId: number,
  summary: string,
  effects: ActionEffects,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { tabId, summary, effects, ...extra };
}
