"use strict";

// Shared model for the Zen-style sidebar.
//
// Sections (top to bottom):
//   essentials - Firefox's own pinned tabs, shown as tiles
//   pinned     - tabs and nested folders kept by this extension
//   regular    - everything else
//
// Folders live in storage.local. A tab's place in the pinned section is a
// session value on the tab (survives restarts and moves between windows):
//   "zfFolder": a folder id, or ROOT for the pinned section's top level.
// Tabs without it are regular. Firefox's real tab order is kept in the same
// sequence as the sidebar, so session restore, Cmd+1..9 and tab cycling match.

const ZF = (globalThis.ZF ??= {});

ZF.ROOT = "root";
ZF.FOLDER_KEY = "zfFolder";
ZF.ORIGINAL_URL_KEY = "originalUrl";

ZF.isRealUrl = url => Boolean(url) && !url.startsWith("about:") && !url.startsWith(browser.runtime.getURL(""));

ZF.newId = () => `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

ZF.loadFolders = async () => (await browser.storage.local.get("folders")).folders ?? [];
ZF.saveFolders = folders => browser.storage.local.set({ folders });

ZF.getPlace = async tabId => (await browser.sessions.getTabValue(tabId, ZF.FOLDER_KEY).catch(() => undefined)) ?? null;

ZF.setPlace = async (tab, place) => {
  if (place === null) {
    await browser.sessions.removeTabValue(tab.id, ZF.FOLDER_KEY);
    return;
  }
  await browser.sessions.setTabValue(tab.id, ZF.FOLDER_KEY, place);
  const original = await browser.sessions.getTabValue(tab.id, ZF.ORIGINAL_URL_KEY).catch(() => undefined);
  if (!original && ZF.isRealUrl(tab.url)) await browser.sessions.setTabValue(tab.id, ZF.ORIGINAL_URL_KEY, tab.url);
};

ZF.childrenOf = (folders, parentId) =>
  folders.filter(f => (f.parentId ?? null) === parentId).sort((a, b) => a.order - b.order);

ZF.isDescendant = (folders, folderId, ancestorId) => {
  let current = folders.find(f => f.id === folderId);
  while (current) {
    if (current.parentId === ancestorId) return true;
    current = folders.find(f => f.id === current.parentId);
  }
  return false;
};

// Everything the sidebar needs for one window.
ZF.buildView = async windowId => {
  const [tabs, folders] = await Promise.all([browser.tabs.query({ windowId }), ZF.loadFolders()]);
  tabs.sort((a, b) => a.index - b.index);
  const known = new Set(folders.map(f => f.id));
  const places = await Promise.all(tabs.map(t => (t.pinned ? null : ZF.getPlace(t.id))));
  const originals = await Promise.all(
    tabs.map((t, i) => (places[i] ? browser.sessions.getTabValue(t.id, ZF.ORIGINAL_URL_KEY).catch(() => undefined) : undefined))
  );

  const view = { windowId, folders, essentials: [], byPlace: new Map(), regular: [], activeId: null, tabsById: new Map() };
  tabs.forEach((tab, i) => {
    view.tabsById.set(tab.id, tab);
    if (tab.active) view.activeId = tab.id;
    if (tab.pinned) {
      view.essentials.push(tab);
      return;
    }
    let place = places[i];
    if (place && place !== ZF.ROOT && !known.has(place)) place = ZF.ROOT;
    if (!place) {
      view.regular.push(tab);
      return;
    }
    tab.zfPlace = place;
    tab.zfOriginalUrl = originals[i];
    if (!view.byPlace.has(place)) view.byPlace.set(place, []);
    view.byPlace.get(place).push(tab);
  });
  return view;
};

// Pinned-section order: each folder's subfolders, then its own tabs; the
// top-level pinned tabs come after all folders.
ZF.segments = view => {
  const out = [];
  const visit = folder => {
    for (const child of ZF.childrenOf(view.folders, folder.id)) visit(child);
    out.push({ place: folder.id, ids: (view.byPlace.get(folder.id) ?? []).map(t => t.id) });
  };
  for (const folder of ZF.childrenOf(view.folders, null)) visit(folder);
  out.push({ place: ZF.ROOT, ids: (view.byPlace.get(ZF.ROOT) ?? []).map(t => t.id) });
  out.push({ place: null, ids: view.regular.map(t => t.id) });
  return out;
};

ZF.applyOrder = async (windowId, segments) => {
  const desired = segments.flatMap(s => s.ids);
  const current = (await browser.tabs.query({ windowId, pinned: false })).sort((a, b) => a.index - b.index).map(t => t.id);
  if (desired.length === current.length && desired.every((id, i) => id === current[i])) return;
  const pinnedCount = (await browser.tabs.query({ windowId, pinned: true })).length;
  await browser.tabs.move(desired, { windowId, index: pinnedCount });
};

// Re-sort Firefox's tab order to match the sidebar.
ZF.normalizeOrder = async windowId => ZF.applyOrder(windowId, ZF.segments(await ZF.buildView(windowId)));

// Move a tab to a section/folder. place: "essentials" | null (regular) |
// ROOT | folderId. Position: before/after another tab, or the end.
ZF.moveTab = async (tabId, place, { beforeId = null, afterId = null } = {}) => {
  let tab = await browser.tabs.get(tabId);
  const windowId = tab.windowId;

  if (place === "essentials") {
    await ZF.setPlace(tab, null);
    if (!tab.pinned) tab = await browser.tabs.update(tabId, { pinned: true });
    const anchor = beforeId ?? afterId;
    if (anchor) {
      const other = await browser.tabs.get(anchor);
      let index = other.index + (afterId ? 1 : 0);
      if (tab.index < index) index--;
      await browser.tabs.move(tabId, { index });
    }
    return;
  }

  if (tab.pinned) tab = await browser.tabs.update(tabId, { pinned: false });
  await ZF.setPlace(tab, place);

  const view = await ZF.buildView(windowId);
  const segments = ZF.segments(view);
  for (const s of segments) s.ids = s.ids.filter(id => id !== tabId);
  const segment = segments.find(s => s.place === place);
  const anchor = beforeId ?? afterId;
  const at = anchor ? segment.ids.indexOf(anchor) : -1;
  if (at === -1) segment.ids.push(tabId);
  else segment.ids.splice(at + (afterId ? 1 : 0), 0, tabId);
  await ZF.applyOrder(windowId, segments);
};

// Move a folder under parentId (null = top level), before/after a sibling.
ZF.moveFolder = async (folderId, parentId, { beforeId = null, afterId = null } = {}) => {
  const folders = await ZF.loadFolders();
  if (folderId === parentId || (parentId && ZF.isDescendant(folders, parentId, folderId))) return;
  const folder = folders.find(f => f.id === folderId);
  if (!folder) return;
  const siblings = ZF.childrenOf(folders, parentId).filter(f => f.id !== folderId);
  const anchor = beforeId ?? afterId;
  const at = anchor ? siblings.findIndex(f => f.id === anchor) : -1;
  if (at === -1) siblings.push(folder);
  else siblings.splice(at + (afterId ? 1 : 0), 0, folder);
  folder.parentId = parentId;
  siblings.forEach((f, i) => (f.order = i));
  await ZF.saveFolders(folders);
  await ZF.normalizeAllWindows();
};

ZF.createFolder = async (name, parentId = null) => {
  const folders = await ZF.loadFolders();
  const folder = { id: ZF.newId(), name, parentId, collapsed: false, order: ZF.childrenOf(folders, parentId).length };
  folders.push(folder);
  await ZF.saveFolders(folders);
  return folder;
};

ZF.updateFolder = async (folderId, changes) => {
  const folders = await ZF.loadFolders();
  const folder = folders.find(f => f.id === folderId);
  if (folder) Object.assign(folder, changes);
  await ZF.saveFolders(folders);
};

// Remove a folder but keep everything in it: its subfolders and tabs move up
// to its parent.
ZF.removeFolder = async folderId => {
  const folders = await ZF.loadFolders();
  const folder = folders.find(f => f.id === folderId);
  if (!folder) return;
  for (const child of folders.filter(f => f.parentId === folderId)) child.parentId = folder.parentId ?? null;
  await ZF.saveFolders(folders.filter(f => f.id !== folderId));
  for (const tab of await browser.tabs.query({})) {
    if ((await ZF.getPlace(tab.id)) === folderId) await ZF.setPlace(tab, folder.parentId ?? ZF.ROOT);
  }
  await ZF.normalizeAllWindows();
};

ZF.normalizeAllWindows = async () => {
  for (const win of await browser.windows.getAll({ windowTypes: ["normal"] })) await ZF.normalizeOrder(win.id);
};

// Zen close: a loaded Essential or pinned-section tab is unloaded first; an
// unloaded pinned-section tab is closed. Regular tabs just close.
ZF.closeOrUnload = async (tabId, view) => {
  const tab = await browser.tabs.get(tabId);
  const kept = tab.pinned || Boolean(await ZF.getPlace(tabId));
  if (!kept) return browser.tabs.remove(tabId);
  if (tab.discarded) {
    if (tab.pinned) return;
    return browser.tabs.remove(tabId);
  }
  if (tab.active) {
    const order = view ? ZF.displayOrder(view).filter(id => id !== tabId) : [];
    const here = view ? ZF.displayOrder(view).indexOf(tabId) : -1;
    const next = order[Math.max(0, here - 1)] ?? order[0];
    if (!next) return;
    await browser.tabs.update(next, { active: true });
  }
  await browser.tabs.discard(tabId);
};

ZF.displayOrder = view => [...view.essentials.map(t => t.id), ...ZF.segments(view).flatMap(s => s.ids)];

// Close every regular tab (Zen's "Clear").
ZF.clearRegular = async view => {
  const ids = view.regular.map(t => t.id);
  if (!ids.length) return;
  if (ids.includes(view.activeId)) {
    const keep = ZF.displayOrder(view).filter(id => !ids.includes(id));
    if (keep.length) await browser.tabs.update(keep.at(-1), { active: true });
    else await browser.tabs.create({ windowId: view.windowId });
  }
  await browser.tabs.remove(ids);
};

// Convert Firefox tab groups into folders (subfolders use the leading-space
// naming from the userChrome.css setup), then ungroup them.
ZF.migrateNativeGroups = async () => {
  let groups;
  try {
    groups = await browser.tabGroups.query({});
  } catch {
    return 0;
  }
  if (!groups.length) return 0;
  const tabs = (await browser.tabs.query({})).filter(t => t.groupId !== undefined && t.groupId !== -1);
  const byWindow = new Map();
  for (const group of groups) {
    const groupTabs = tabs.filter(t => t.groupId === group.id).sort((a, b) => a.index - b.index);
    const first = groupTabs[0]?.index ?? Infinity;
    if (!byWindow.has(group.windowId)) byWindow.set(group.windowId, []);
    byWindow.get(group.windowId).push({ group, groupTabs, first });
  }
  let migrated = 0;
  for (const entries of byWindow.values()) {
    entries.sort((a, b) => a.first - b.first);
    const stack = [];
    for (const { group, groupTabs } of entries) {
      const title = group.title ?? "";
      const depth = title.length - title.trimStart().length;
      while (stack.length > depth) stack.pop();
      const parentId = stack.at(-1) ?? null;
      const folder = await ZF.createFolder(title.trim() || "Folder", parentId);
      await ZF.updateFolder(folder.id, { collapsed: Boolean(group.collapsed) });
      stack.push(folder.id);
      for (const tab of groupTabs) await ZF.setPlace(tab, folder.id);
      if (groupTabs.length) await browser.tabs.ungroup(groupTabs.map(t => t.id));
      migrated++;
    }
  }
  await ZF.normalizeAllWindows();
  return migrated;
};
