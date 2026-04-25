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
        bus.post({ type: 'result', requestId, ...((data as object) ?? {}) });
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
