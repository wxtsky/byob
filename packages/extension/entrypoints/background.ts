import { startNativeBus, bus } from '../lib/native-msg.js';

export default defineBackground(() => {
  console.log('[byob] service worker boot');

  startNativeBus({
    onMessage: (msg) => {
      console.log('[byob] received:', msg);
      if (msg.type === 'command') {
        // Phase 1: no command dispatch yet. Reply with not-implemented so
        // the bridge doesn't hang waiting for a result.
        bus.post({
          type: 'result',
          requestId: msg.requestId,
          error: 'unknown',
          message: `Command ${msg.command} not implemented in Phase 1`,
        });
      }
    },
    onReady: () => {
      console.log('[byob] bridge ready, IPC up');
    },
  });

  // Keep the SW awake during long operations (Phase 2+ will need this).
  chrome.alarms.create('byob-keepalive', { periodInMinutes: 0.4 });
  chrome.alarms.onAlarm.addListener(() => {
    /* tick */
  });
});
