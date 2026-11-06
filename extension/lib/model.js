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

// storage.local is deleted when the extension is removed (including a
// temporary add-on being reloaded or Firefox restarting), so every save is
// mirrored into the session store, which keeps it with the window.
ZF.BACKUP_KEY = "zfFoldersBackup";
ZF.saveFolders = async folders => {
  await browser.storage.local.set({ folders });
  const backup = { savedAt: Date.now(), folders };
  for (const win of await browser.windows.getAll({ windowTypes: ["normal"] })) {
    await browser.sessions.setWindowValue(win.id, ZF.BACKUP_KEY, backup).catch(() => {});
  }
};

// If storage was wiped, restore folders from the newest session backup, then
// give any tab that points at a folder that no longer exists a "Recovered"
// folder of its own, so tabs stay grouped instead of being scattered.
ZF.restoreFoldersIfMissing = async () => {
  const report = { restoredFromBackup: 0, recoveredFolders: 0 };
  if (!(await ZF.loadFolders()).length) {
    let newest = null;
    for (const win of await browser.windows.getAll({ windowTypes: ["normal"] })) {
      const backup = await browser.sessions.getWindowValue(win.id, ZF.BACKUP_KEY).catch(() => null);
      if (backup?.folders?.length && (!newest || backup.savedAt > newest.savedAt)) newest = backup;
    }
    if (newest) {
      await ZF.mutateFolders(folders => folders.push(...newest.folders));
      report.restoredFromBackup = newest.folders.length;
    }
  }
  const known = new Set((await ZF.loadFolders()).map(f => f.id));
  const orphans = new Set();
  for (const tab of await browser.tabs.query({})) {
    const place = await ZF.getPlace(tab.id);
    if (place && place !== ZF.ROOT && !known.has(place)) orphans.add(place);
  }
  if (orphans.size) {
    await ZF.mutateFolders(folders => {
      let n = folders.filter(f => f.name.startsWith("Recovered folder")).length;
      for (const id of orphans) {
        folders.push({ id, name: `Recovered folder ${++n}`, parentId: null, collapsed: true, order: folders.length });
      }
    });
    report.recoveredFolders = orphans.size;
  }
  return report;
};

// All folder changes go through here, one at a time, so two quick changes
// (e.g. collapsing two folders) can't overwrite each other.
let folderQueue = Promise.resolve();
ZF.mutateFolders = fn => {
  const run = folderQueue.then(async () => {
    const folders = await ZF.loadFolders();
    const result = await fn(folders);
    await ZF.saveFolders(folders);
    return result;
  });
  folderQueue = run.catch(() => {});
  return run;
};

ZF.getPlace = async tabId => (await browser.sessions.getTabValue(tabId, ZF.FOLDER_KEY).catch(() => undefined)) ?? null;

ZF.setPlace = async (tab, place) => {
  if (place === null) {
    await browser.sessions.removeTabValue(tab.id, ZF.FOLDER_KEY);
    await browser.sessions.removeTabValue(tab.id, ZF.ORIGINAL_URL_KEY);
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
  const [allTabs, folders] = await Promise.all([browser.tabs.query({ windowId }), ZF.loadFolders()]);
  const tabs = allTabs.filter(t => !t.hidden).sort((a, b) => a.index - b.index);
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
  const current = (await browser.tabs.query({ windowId, pinned: false }))
    .filter(t => !t.hidden)
    .sort((a, b) => a.index - b.index)
    .map(t => t.id);
  if (desired.length === current.length && desired.every((id, i) => id === current[i])) return;
  // Hidden tabs (other extensions) may sit in between; moving to the end
  // keeps the visible order without having to account for them.
  await browser.tabs.move(desired, { windowId, index: -1 });
};

// Re-sort Firefox's tab order to match the sidebar.
ZF.normalizeOrder = async windowId => ZF.applyOrder(windowId, ZF.segments(await ZF.buildView(windowId)));

// Move tabs (kept in the given order) to a section/folder. place:
// "essentials" | null (regular) | ROOT | folderId. Position: before/after
// another tab, or the end.
ZF.moveTabs = async (tabIds, place, { beforeId = null, afterId = null } = {}) => {
  if (!tabIds.length) return;
  const anchor = beforeId ?? afterId;
  if (anchor && tabIds.includes(anchor)) return;
  const first = await browser.tabs.get(tabIds[0]);
  const windowId = first.windowId;

  if (place === "essentials") {
    for (const id of tabIds) {
      const tab = await browser.tabs.get(id);
      await ZF.setPlace(tab, null);
      if (!tab.pinned) await browser.tabs.update(id, { pinned: true });
    }
    if (anchor) {
      const other = await browser.tabs.get(anchor);
      const pinned = (await browser.tabs.query({ windowId, pinned: true })).sort((a, b) => a.index - b.index).map(t => t.id);
      const rest = pinned.filter(id => !tabIds.includes(id));
      const at = rest.indexOf(other.id) + (afterId ? 1 : 0);
      rest.splice(at, 0, ...tabIds);
      await browser.tabs.move(rest, { windowId, index: 0 });
    }
    return;
  }

  for (const id of tabIds) {
    let tab = await browser.tabs.get(id);
    if (tab.pinned) tab = await browser.tabs.update(id, { pinned: false });
    await ZF.setPlace(tab, place);
  }

  const view = await ZF.buildView(windowId);
  const segments = ZF.segments(view);
  for (const s of segments) s.ids = s.ids.filter(id => !tabIds.includes(id));
  const segment = segments.find(s => s.place === place);
  const at = anchor ? segment.ids.indexOf(anchor) : -1;
  if (at === -1) segment.ids.push(...tabIds);
  else segment.ids.splice(at + (afterId ? 1 : 0), 0, ...tabIds);
  await ZF.applyOrder(windowId, segments);
};

ZF.moveTab = (tabId, place, position) => ZF.moveTabs([tabId], place, position);

// Move a folder under parentId (null = top level), before/after a sibling.
ZF.moveFolder = async (folderId, parentId, { beforeId = null, afterId = null } = {}) => {
  const moved = await ZF.mutateFolders(folders => {
    if (folderId === parentId || (parentId && ZF.isDescendant(folders, parentId, folderId))) return false;
    const folder = folders.find(f => f.id === folderId);
    if (!folder) return false;
    const siblings = ZF.childrenOf(folders, parentId).filter(f => f.id !== folderId);
    const anchor = beforeId ?? afterId;
    const at = anchor ? siblings.findIndex(f => f.id === anchor) : -1;
    if (at === -1) siblings.push(folder);
    else siblings.splice(at + (afterId ? 1 : 0), 0, folder);
    folder.parentId = parentId;
    siblings.forEach((f, i) => (f.order = i));
    return true;
  });
  if (moved) await ZF.normalizeAllWindows();
};

ZF.createFolder = (name, parentId = null) =>
  ZF.mutateFolders(folders => {
    const folder = { id: ZF.newId(), name, parentId, collapsed: false, order: ZF.childrenOf(folders, parentId).length };
    folders.push(folder);
    return folder;
  });

ZF.updateFolder = (folderId, changes) =>
  ZF.mutateFolders(folders => {
    const folder = folders.find(f => f.id === folderId);
    if (folder) Object.assign(folder, changes);
  });

// Remove a folder but keep everything in it: its subfolders and tabs move up
// to its parent.
ZF.removeFolder = async folderId => {
  const folder = await ZF.mutateFolders(folders => {
    const index = folders.findIndex(f => f.id === folderId);
    if (index === -1) return null;
    const [removed] = folders.splice(index, 1);
    for (const child of folders.filter(f => f.parentId === folderId)) child.parentId = removed.parentId ?? null;
    return removed;
  });
  if (!folder) return;
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
// `avoid`: other tabs being closed in the same batch; never switch to them.
ZF.closeOrUnload = async (tabId, view, { unloadFirst = true, avoid = [] } = {}) => {
  const tab = await browser.tabs.get(tabId);
  // Essentials are only ever unloaded from the sidebar, whatever the setting.
  if (!unloadFirst && !tab.pinned) return browser.tabs.remove(tabId);
  const kept = tab.pinned || Boolean(await ZF.getPlace(tabId));
  if (!kept) return browser.tabs.remove(tabId);
  if (tab.discarded) {
    if (tab.pinned) return;
    return browser.tabs.remove(tabId);
  }
  if (tab.active) {
    const full = view ? ZF.displayOrder(view) : [];
    const here = full.indexOf(tabId);
    const ok = id => id !== tabId && !avoid.includes(id);
    // Nearest tab above, otherwise below, that isn't part of this close.
    const next = full.slice(0, Math.max(here, 0)).reverse().find(ok) ?? full.slice(here + 1).find(ok);
    if (!next) return;
    await browser.tabs.update(next, { active: true });
  }
  await browser.tabs.discard(tabId);
};

ZF.displayOrder = view => [...view.essentials.map(t => t.id), ...ZF.segments(view).flatMap(s => s.ids)];

// Close every regular tab (Zen's "Clear").
ZF.clearRegular = async windowId => {
  // Work out what's regular now, not from what a sidebar last drew.
  const view = await ZF.buildView(windowId);
  const ids = view.regular.map(t => t.id);
  if (!ids.length) return 0;
  if (ids.includes(view.activeId)) {
    const keep = ZF.displayOrder(view).filter(id => !ids.includes(id));
    if (keep.length) await browser.tabs.update(keep.at(-1), { active: true });
    else await browser.tabs.create({ windowId });
  }
  await browser.tabs.remove(ids);
  return ids.length;
};

// Import folders exported from Zen (export_zen_folders.py): recreate the
// folder tree and move every open tab whose address matches a tab that was
// in a Zen folder into it. Existing folders are kept; "Recovered" folders
// left empty by the import are removed.
ZF.importZenFolders = async data => {
  if (!Array.isArray(data?.folders) || !Array.isArray(data?.tabs)) throw new Error("Not a Zen folders export");
  const idMap = new Map();
  await ZF.mutateFolders(folders => {
    const pending = [...data.folders];
    // Parents first, so each child can point at its new parent id.
    while (pending.length) {
      const i = pending.findIndex(f => !f.parentId || idMap.has(f.parentId) || !data.folders.some(p => p.id === f.parentId));
      const [zen] = pending.splice(i === -1 ? 0 : i, 1);
      const parentId = zen.parentId ? idMap.get(zen.parentId) ?? null : null;
      const folder = { id: ZF.newId(), name: String(zen.name || "Folder"), parentId, collapsed: Boolean(zen.collapsed), order: ZF.childrenOf(folders, parentId).length };
      folders.push(folder);
      idMap.set(zen.id, folder.id);
    }
  });

  const strip = url => String(url).split("#")[0];
  const byUrl = new Map();
  for (const t of data.tabs) for (const url of t.urls ?? []) if (url && !byUrl.has(url)) byUrl.set(url, t.folderId);
  const byStripped = new Map([...byUrl].map(([u, f]) => [strip(u), f]));

  let placed = 0;
  for (const tab of await browser.tabs.query({ pinned: false })) {
    const zenFolder = byUrl.get(tab.url) ?? byStripped.get(strip(tab.url));
    const folderId = zenFolder && idMap.get(zenFolder);
    if (!folderId) continue;
    await ZF.setPlace(tab, folderId);
    placed++;
  }

  // Drop "Recovered" folders that no longer hold anything.
  const used = new Set();
  for (const tab of await browser.tabs.query({})) used.add(await ZF.getPlace(tab.id));
  await ZF.mutateFolders(folders => {
    for (let i = folders.length - 1; i >= 0; i--) {
      const f = folders[i];
      if (f.name.startsWith("Recovered folder") && !used.has(f.id) && !folders.some(c => c.parentId === f.id)) folders.splice(i, 1);
    }
  });
  await ZF.normalizeAllWindows();
  return { folders: idMap.size, tabs: placed };
};

// Version 0.2.0 kept empty tab groups alive with hidden placeholder tabs.
// Folders don't need them any more; close any that are left.
ZF.closeOldPlaceholders = async () => {
  const leftovers = [];
  for (const tab of await browser.tabs.query({})) {
    const marked = await browser.sessions.getTabValue(tab.id, "folderPlaceholder").catch(() => undefined);
    const looksLikeOne = tab.title === "Folder placeholder" && tab.url?.startsWith("moz-extension://");
    if (marked || looksLikeOne) leftovers.push(tab.id);
  }
  if (leftovers.length) await browser.tabs.remove(leftovers);
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
  // Folders are shared by all windows and kept on disk, so groups in private
  // windows are left alone.
  const privateWindows = new Set((await browser.windows.getAll()).filter(w => w.incognito).map(w => w.id));
  groups = groups.filter(g => !privateWindows.has(g.windowId));
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
      const folder = await ZF.local.createFolder(title.trim() || "Folder", parentId);
      await ZF.local.updateFolder(folder.id, { collapsed: Boolean(group.collapsed) });
      stack.push(folder.id);
      for (const tab of groupTabs) await ZF.setPlace(tab, folder.id);
      if (groupTabs.length) await browser.tabs.ungroup(groupTabs.map(t => t.id));
      migrated++;
    }
  }
  await ZF.normalizeAllWindows();
  return migrated;
};

// ---------------------------------------------------------------------------
// One writer. Every change to folders, tab placement or settings runs in the
// background, one at a time, so pages can't overwrite each other's changes;
// afterwards every sidebar is told to refresh. Other pages forward calls.
// ---------------------------------------------------------------------------

ZF.REMOTE_CALLS = [
  "createFolder",
  "updateFolder",
  "moveFolder",
  "removeFolder",
  "moveTabs",
  "clearRegular",
  "importZenFolders",
  "restoreFoldersIfMissing",
  "migrateNativeGroups",
  "updateSettings",
  "resetSettings",
];

ZF.local = {};
let callQueue = Promise.resolve();

ZF.runQueued = (name, args) => {
  const run = callQueue.then(() => ZF.local[name](...args));
  callQueue = run.catch(() => {});
  return run.finally(() => ZF.notifyChanged());
};

let notifyTimer = null;
ZF.notifyChanged = () => {
  if (!ZF.IS_BACKGROUND) return;
  clearTimeout(notifyTimer);
  notifyTimer = setTimeout(() => browser.runtime.sendMessage({ type: "zf-changed" }).catch(() => {}), 20);
};

for (const name of ZF.REMOTE_CALLS) {
  ZF.local[name] = ZF[name];
  ZF[name] = (...args) =>
    ZF.IS_BACKGROUND ? ZF.runQueued(name, args) : browser.runtime.sendMessage({ type: "zf-call", name, args });
}
