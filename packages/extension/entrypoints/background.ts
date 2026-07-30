import { startNativeBus, bus } from '../lib/native-msg.js';
import { handlers } from '../lib/handlers/index.js';
import { isAbortError } from '../lib/signal-utils.js';
import { startWakeWatch, registerInFlightForWake } from '../lib/wake-watch.js';
import { recordContext, forgetContextById } from '../lib/frame-resolver.js';
import {
  setAllowedFlags,
  FLAG_KEYS,
  type Flags,
  setHostPolicy,
  HOST_POLICY_KEYS,
  coerceDomainList,
} from '../lib/url-guard.js';
import { startDialogRegistry } from '../lib/dialog-registry.js';

export default defineBackground(() => {
  console.log('[byob] service worker boot');

  // Hydrate url-guard flags from chrome.storage.local at boot, and keep the
  // in-memory cache in sync with later changes. Users opt in via the SW
  // console: `chrome.storage.local.set({ BYOB_ALLOW_FILE: true })`.
  // Do not accept a browser command until persisted URL-policy state has
  // loaded. Otherwise the first request after a service-worker wake gets the
  // permissive in-memory defaults and can briefly bypass a user's denylist.
  let policyLoadError: unknown;
  const policyReady = chrome.storage.local
    .get([...FLAG_KEYS, ...HOST_POLICY_KEYS] as unknown as string[])
    .then((stored) => {
      const update: Partial<Flags> = {};
      for (const key of FLAG_KEYS) update[key] = !!stored[key];
      setAllowedFlags(update);
      setHostPolicy({
        allowedDomains: coerceDomainList(stored.BYOB_ALLOWED_DOMAINS),
        deniedDomains: coerceDomainList(stored.BYOB_DENIED_DOMAINS),
      });
    })
    .catch((error) => {
      policyLoadError = error;
      console.error('[byob] failed to load URL policy; browser commands will stay blocked', error);
    });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const update: Partial<Flags> = {};
    for (const key of FLAG_KEYS) {
      const change = changes[key];
      if (change) update[key] = !!change.newValue;
    }
    if (Object.keys(update).length > 0) setAllowedFlags(update);

    if (changes.BYOB_ALLOWED_DOMAINS) {
      setHostPolicy({ allowedDomains: coerceDomainList(changes.BYOB_ALLOWED_DOMAINS.newValue) });
    }
    if (changes.BYOB_DENIED_DOMAINS) {
      setHostPolicy({ deniedDomains: coerceDomainList(changes.BYOB_DENIED_DOMAINS.newValue) });
    }
  });

  /** Keyed by NM frame id (the bridge's `nmId`). */
  const inFlight = new Map<string, AbortController>();
  // Wake watch needs visibility into in-flight controllers to abort them
  // on system wake. We pass a getter so wake-watch.ts doesn't import this
  // file (avoids circular imports through entrypoints/).
  registerInFlightForWake(() => inFlight);

  startNativeBus({
    onMessage: async (msg) => {
      if (msg.type === 'cancel') {
        const ctrl = inFlight.get(msg.requestId);
        if (ctrl) {
          ctrl.abort('aborted');
          inFlight.delete(msg.requestId);
        }
        return;
      }
      if (msg.type !== 'command') return;
      const { requestId, command, params } = msg;
      const handler = handlers[command];
      if (!handler) {
        bus.post({
          type: 'result',
          requestId,
          error: 'unknown',
          message: `No handler for ${command}`,
        });
        return;
      }
      const ac = new AbortController();
      inFlight.set(requestId, ac);
      try {
        await policyReady;
        if (policyLoadError !== undefined) throw policyLoadError;
        const data = await handler(params, ac.signal);
        // NOTE: spread payload FIRST, then NM-protocol fields. This guarantees
        // handler payloads can never shadow `type`/`requestId` (we hit this once
        // when EvalOutput.type collided with type:'result' and stalled the
        // pending-request map). Handlers must avoid using top-level `type`
        // or `requestId` keys in their return value either way.
        bus.post({ ...((data as object) ?? {}), type: 'result', requestId });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (isAbortError(e)) {
          const code =
            (e as { reason?: string }).reason === 'aborted_due_to_wake'
              ? 'aborted_due_to_wake'
              : 'aborted';
          bus.post({ type: 'result', requestId, error: code, message: code, aborted: true });
        } else {
          bus.post({ type: 'result', requestId, error: 'unknown', message });
        }
      } finally {
        inFlight.delete(requestId);
      }
    },
    onReady: () => console.log('[byob] bridge ready'),
  });

  // Frame execution context tracking — populates the frame-resolver registry
  // from Runtime executionContextCreated/Destroyed events emitted by
  // flatten auto-attach (parent + child OOPIF sessions).
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (method === 'Runtime.executionContextCreated') {
      const p = params as
        | { context?: { id?: number; auxData?: { frameId?: string } } }
        | undefined;
      const frameId = p?.context?.auxData?.frameId;
      const contextId = p?.context?.id;
      if (typeof frameId === 'string' && typeof contextId === 'number') {
        const sessionId = (source as { sessionId?: string }).sessionId;
        recordContext(frameId, contextId, sessionId);
      }
    } else if (method === 'Runtime.executionContextDestroyed') {
      // Reverse-lookup forget by contextId — CDP doesn't supply the
      // frameId here. See frame-resolver.forgetContextById for why
      // we scan instead of keeping a parallel index.
      const p = params as { executionContextId?: number } | undefined;
      const contextId = p?.executionContextId;
      if (typeof contextId === 'number') {
        const sessionId = (source as { sessionId?: string }).sessionId;
        forgetContextById(contextId, sessionId);
      }
    }
  });

  // v0.2: detect macOS sleep/wake and reset CDP state on resume.
  // The wake-watch alarm (60s tick) plus the per-recording keepalive alarm
  // installed by recording-registry.ts together keep the MV3 SW alive — no
  // extra `byob-keepalive` tick is needed here.
  startWakeWatch();

  // Observe JavaScript dialogs without making a choice for the user. They
  // remain open until browser_handle_js_dialog accepts or dismisses them.
  startDialogRegistry();
});
