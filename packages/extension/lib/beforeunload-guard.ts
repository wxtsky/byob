// While byob is operating on a tab (read/screenshot/long-running), prevent
// page-initiated navigation (history.pushState aside; this catches plain
// link/refresh/window.location). The page-side handler calls
// preventDefault on beforeunload so SPAs that programmatically reload mid-op
// don't yank the DOM out from under us.
//
// Install before the long op starts; uninstall in `finally`.

import type { CdpSession } from './cdp.js';

const INSTALL = `
(() => {
  if (window.__byobBeforeunloadGuard) return;
  const handler = (e) => {
    e.preventDefault();
    e.returnValue = '';
  };
  window.__byobBeforeunloadGuard = handler;
  window.addEventListener('beforeunload', handler);
})();
`;

const UNINSTALL = `
(() => {
  const h = window.__byobBeforeunloadGuard;
  if (h) {
    window.removeEventListener('beforeunload', h);
    delete window.__byobBeforeunloadGuard;
  }
})();
`;

export async function installBeforeunloadGuard(session: CdpSession): Promise<void> {
  try {
    await session.evaluate(INSTALL, { awaitPromise: false });
  } catch {
    // best-effort; not fatal if install fails
  }
}

export async function uninstallBeforeunloadGuard(session: CdpSession): Promise<void> {
  try {
    await session.evaluate(UNINSTALL, { awaitPromise: false });
  } catch {
    // tab may already be gone
  }
}
