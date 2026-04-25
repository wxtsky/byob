export async function handleListTabs(): Promise<unknown> {
  const tabs = await chrome.tabs.query({});
  return {
    tabs: tabs
      .filter((t) => t.id !== undefined)
      .map((t) => ({
        id: t.id!,
        url: t.url ?? '',
        title: t.title ?? '',
        active: !!t.active,
        windowId: t.windowId,
      })),
  };
}
