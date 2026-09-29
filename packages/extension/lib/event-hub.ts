/**
 * The one chrome.debugger.onEvent listener.
 *
 * CDP events for every attached tab (and every flatten-attached OOPIF child
 * session) arrive here and are fanned out to the registries that care:
 * execution contexts, isolated worlds, OOPIF sessions, the console buffer,
 * and short-lived observers (post-action settle, waits).
 */
import { recordContext, forgetContextById } from './frame-resolver.js';
import {
  onContextDestroyed,
  onContextsCleared,
  recordOopif,
  forgetOopifSession,
  forgetTabFrames,
  forgetTabOopifs,
} from './dom/frames.js';
import { onConsoleEvent, forgetTabConsole } from './console-buffer.js';

export interface HubEvent {
  tabId: number;
  sessionId?: string;
  method: string;
  params: any;
}

type Observer = (e: HubEvent) => void;
const observers = new Set<Observer>();

/** Subscribe to raw events; returns the unsubscribe function. */
export function observe(fn: Observer): () => void {
  observers.add(fn);
  return () => observers.delete(fn);
}

function send(tabId: number, sessionId: string, method: string, params: object = {}): void {
  chrome.debugger.sendCommand({ tabId, sessionId } as chrome.debugger.Debuggee, method, params, () => {
    void chrome.runtime.lastError; // child may detach mid-flight
  });
}

function onEvent(source: chrome.debugger.Debuggee, method: string, params?: object): void {
  const tabId = source.tabId;
  if (tabId === undefined) return;
  const sessionId = (source as { sessionId?: string }).sessionId;
  const p = (params ?? {}) as any;

  switch (method) {
    case 'Runtime.executionContextCreated': {
      const ctx = p.context;
      // Only the page's default world maps a frame to "its" context. Isolated
      // worlds (byob's own, or other extensions' content scripts) used to
      // overwrite the entry and send evaluations into the wrong world.
      if (ctx?.auxData?.isDefault === true && typeof ctx.auxData.frameId === 'string') {
        recordContext(ctx.auxData.frameId, ctx.id, sessionId);
      }
      break;
    }
    case 'Runtime.executionContextDestroyed':
      if (typeof p.executionContextId === 'number') {
        forgetContextById(p.executionContextId, sessionId);
        onContextDestroyed(tabId, sessionId, p.executionContextId);
      }
      break;
    case 'Runtime.executionContextsCleared':
      onContextsCleared(tabId, sessionId);
      break;
    case 'Target.attachedToTarget': {
      const child = p.sessionId as string | undefined;
      const info = p.targetInfo as { targetId?: string; type?: string } | undefined;
      if (child && info?.type === 'iframe' && info.targetId) {
        recordOopif(tabId, info.targetId, child);
        // A flatten-attached child starts with nothing enabled. Mirror what
        // the tab session gets so contexts, dialogs and console flow, and
        // keep auto-attaching so nested OOPIFs are reachable too.
        send(tabId, child, 'Runtime.enable');
        send(tabId, child, 'Page.enable');
        send(tabId, child, 'Log.enable');
        send(tabId, child, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
      }
      break;
    }
    case 'Target.detachedFromTarget':
      if (typeof p.sessionId === 'string') forgetOopifSession(tabId, p.sessionId);
      break;
    case 'Runtime.consoleAPICalled':
    case 'Runtime.exceptionThrown':
    case 'Log.entryAdded':
      onConsoleEvent(tabId, method, p);
      break;
  }

  if (observers.size) {
    const e: HubEvent = { tabId, sessionId, method, params: p };
    for (const fn of observers) {
      try {
        fn(e);
      } catch (err) {
        console.warn('[byob/hub] observer failed', err);
      }
    }
  }
}

function onTabRemoved(tabId: number): void {
  forgetTabFrames(tabId);
  forgetTabOopifs(tabId);
  forgetTabConsole(tabId);
}

function onDetach(source: chrome.debugger.Debuggee): void {
  if (source.tabId === undefined) return;
  forgetTabFrames(source.tabId);
  forgetTabOopifs(source.tabId);
}

export function startEventHub(): void {
  if (!chrome.debugger.onEvent.hasListener?.(onEvent)) chrome.debugger.onEvent.addListener(onEvent);
  if (!chrome.debugger.onDetach.hasListener?.(onDetach)) chrome.debugger.onDetach.addListener(onDetach);
  if (!chrome.tabs.onRemoved.hasListener?.(onTabRemoved)) chrome.tabs.onRemoved.addListener(onTabRemoved);
}
