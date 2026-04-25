import { startNativeBus, bus } from '../lib/native-msg.js';
import { handlers } from '../lib/handlers/index.js';
import { isAbortError } from '../lib/signal-utils.js';
import { startWakeWatch, registerInFlightForWake } from '../lib/wake-watch.js';
import { recordContext, forgetContext } from '../lib/frame-resolver.js';

export default defineBackground(() => {
  console.log('[byob] service worker boot');

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
      // CDP only gives us the executionContextId on destruction, not the frameId.
      // Our registry is keyed by frameId, so we can't directly forget here —
      // the entry will be overwritten on the next executionContextCreated for
      // the same frame, or evicted via Page.frameDetached (handled elsewhere).
      // Reference forgetContext so the import is retained for future wiring.
      void forgetContext;
    }
  });

  // Keep the SW awake during long operations.
  chrome.alarms.create('byob-keepalive', { periodInMinutes: 0.4 });
  chrome.alarms.onAlarm.addListener(() => {
    /* tick */
  });

  // v0.2: detect macOS sleep/wake and reset CDP state on resume.
  // Currently a stub — full impl lands in Task 8 of the stability plan.
  startWakeWatch();
});
