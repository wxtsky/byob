/**
 * Per-session state. Each MCP client (one Claude Code session, one Cursor
 * window…) runs its own byob-mcp process over stdio, so module state here is
 * naturally scoped to one agent — two sessions never share a working tab.
 */

/** The tab this session is working in; tools default to it. */
let workingTab: number | undefined;
/** Tabs this session opened itself (safe to navigate away). */
const ownedTabs = new Set<number>();

export function getWorkingTab(): number | undefined {
  return workingTab;
}

export function isOwnedTab(tabId: number): boolean {
  return ownedTabs.has(tabId);
}

export function noteTab(tabId: number, opts: { opened?: boolean } = {}): void {
  workingTab = tabId;
  if (opts.opened) ownedTabs.add(tabId);
}

export function markOwned(tabId: number): void {
  ownedTabs.add(tabId);
}

export function forgetTab(tabId: number): void {
  ownedTabs.delete(tabId);
  if (workingTab === tabId) workingTab = undefined;
}

/** Test-only. */
export function _resetState(): void {
  workingTab = undefined;
  ownedTabs.clear();
}
