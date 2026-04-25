import { startNativeBus, bus } from '../lib/native-msg.js';
import { handlers } from '../lib/handlers/index.js';

export default defineBackground(() => {
  console.log('[byob] service worker boot');

  startNativeBus({
    onMessage: async (msg) => {
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
      try {
        const data = await handler(params);
        // NOTE: spread payload FIRST, then NM-protocol fields. This guarantees
        // handler payloads can never shadow `type`/`requestId` (we hit this once
        // when EvalOutput.type collided with type:'result' and stalled the
        // pending-request map). Handlers must avoid using top-level `type`
        // or `requestId` keys in their return value either way.
        bus.post({ ...((data as object) ?? {}), type: 'result', requestId });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        bus.post({ type: 'result', requestId, error: 'unknown', message });
      }
    },
    onReady: () => console.log('[byob] bridge ready'),
  });

  // Keep the SW awake during long operations.
  chrome.alarms.create('byob-keepalive', { periodInMinutes: 0.4 });
  chrome.alarms.onAlarm.addListener(() => {
    /* tick */
  });
});
