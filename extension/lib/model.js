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
// Position of a kept tab among the items (tabs and subfolders) of its folder.
ZF.ORDER_KEY = "zfOrder";
// Tabs without a stored position sort after positioned items, in Firefox's
// order (that's how everything was laid out before positions existed).
const UNPOSITIONED = 1_000_000;

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
      if (Array.isArray(backup?.folders) && (!newest || backup.savedAt > newest.savedAt)) newest = backup;
    }
    // The newest backup wins even if it's empty (you deleted every folder).
    if (newest?.folders.length) {
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
    await browser.sessions.removeTabValue(tab.id, ZF.ORDER_KEY);
    ZF.metaCache?.delete(tab.id);
    return;
  }
  await browser.sessions.setTabValue(tab.id, ZF.FOLDER_KEY, place);
  ZF.metaCache?.delete(tab.id);
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
// Per-tab session values, cached by pages that redraw often (the sidebar sets
// ZF.metaCache = new Map()). They only change through the background, which
// then sends "zf-changed", and the sidebar clears the cache.
ZF.metaCache = null;

async function readMeta(tab) {
  if (tab.pinned) return { place: null };
  // The cache is replaced (not cleared) on invalidation, so a read that
  // started before a change can't put stale values into the new cache.
  const cache = ZF.metaCache;
  const cached = cache?.get(tab.id);
  if (cached) return cached;
  const get = key => browser.sessions.getTabValue(tab.id, key).catch(() => undefined);
  const place = (await get(ZF.FOLDER_KEY)) ?? null;
  const meta = place
    ? { place, original: await get(ZF.ORIGINAL_URL_KEY), order: await get(ZF.ORDER_KEY) }
    : { place: null };
  cache?.set(tab.id, meta);
  return meta;
}

ZF.buildView = async windowId => {
  const [allTabs, folders] = await Promise.all([browser.tabs.query({ windowId }), ZF.loadFolders()]);
  const tabs = allTabs.filter(t => !t.hidden).sort((a, b) => a.index - b.index);
  const known = new Set(folders.map(f => f.id));
  const metas = await Promise.all(tabs.map(readMeta));

  const view = { windowId, folders, essentials: [], byPlace: new Map(), regular: [], activeId: null, tabsById: new Map() };
  tabs.forEach((tab, i) => {
    view.tabsById.set(tab.id, tab);
    if (tab.active) view.activeId = tab.id;
    if (tab.pinned) {
      view.essentials.push(tab);
      return;
    }
    let { place, original, order } = metas[i];
    if (place && place !== ZF.ROOT && !known.has(place)) place = ZF.ROOT;
    if (!place) {
      view.regular.push(tab);
      return;
    }
    tab.zfPlace = place;
    tab.zfOriginalUrl = original;
    tab.zfOrderStored = typeof order === "number";
    tab.zfOrder = tab.zfOrderStored ? order : UNPOSITIONED + i;
    if (!view.byPlace.has(place)) view.byPlace.set(place, []);
    view.byPlace.get(place).push(tab);
  });
  return view;
};

// Stored positions of kept tabs in `key`, across every window.
async function keptTabsEverywhere(key) {
  const out = [];
  for (const tab of await browser.tabs.query({ pinned: false })) {
    if ((await ZF.getPlace(tab.id)) !== key) continue;
    const order = await browser.sessions.getTabValue(tab.id, ZF.ORDER_KEY).catch(() => undefined);
    out.push({ tab, order: typeof order === "number" ? order : UNPOSITIONED + tab.index });
  }
  return out;
}

// Items of a folder (or ROOT): its subfolders and tabs, in one order.
ZF.itemsOf = (view, key) => {
  const parentId = key === ZF.ROOT ? null : key;
  const items = [
    ...view.folders.filter(f => (f.parentId ?? null) === parentId).map(f => ({ kind: "folder", id: f.id, order: f.order ?? 0, folder: f })),
    ...(view.byPlace.get(key) ?? []).map(t => ({ kind: "tab", id: t.id, order: t.zfOrder, tab: t })),
  ];
  // Stable for ties: folders first, as before positions existed.
  return items.sort((a, b) => a.order - b.order || (a.kind === b.kind ? 0 : a.kind === "folder" ? -1 : 1));
};

// Kept tabs in the order the sidebar shows them.
ZF.keptOrder = view => {
  const out = [];
  const visit = key => {
    for (const item of ZF.itemsOf(view, key)) {
      if (item.kind === "tab") out.push(item.id);
      else visit(item.id);
    }
  };
  visit(ZF.ROOT);
  return out;
};

// Firefox's tab order: kept tabs as the sidebar shows them, then regular tabs.
ZF.desiredOrder = view => [...ZF.keptOrder(view), ...view.regular.map(t => t.id)];

// Indices of a longest increasing subsequence of `seq`.
function longestIncreasing(seq) {
  const tails = [];
  const prev = new Array(seq.length);
  for (let i = 0; i < seq.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (seq[tails[mid]] < seq[i]) lo = mid + 1;
      else hi = mid;
    }
    prev[i] = lo ? tails[lo - 1] : -1;
    tails[lo] = i;
  }
  const out = new Set();
  for (let i = tails.at(-1) ?? -1; i !== -1; i = prev[i]) out.add(i);
  return out;
}

// Put Firefox's tab order in the given order, moving as few tabs as possible:
// tabs already in the right relative order stay put, others are moved next to
// their new neighbour. A single drag moves one tab, not the whole window.
ZF.applyOrder = async (windowId, desired) => {
  const visible = (await browser.tabs.query({ windowId, pinned: false })).filter(t => !t.hidden).sort((a, b) => a.index - b.index);
  const current = visible.map(t => t.id);
  if (desired.length === current.length && desired.every((id, i) => id === current[i])) return;
  const pos = new Map(current.map((id, i) => [id, i]));
  if (desired.length !== current.length || desired.some(id => !pos.has(id))) {
    await browser.tabs.move(desired, { windowId, index: -1 });
    return;
  }
  const stay = longestIncreasing(desired.map(id => pos.get(id)));
  const firstStay = Math.min(...stay);
  // Left to right: tabs before the first staying tab go just before it (in
  // order); every other moving tab goes right after its predecessor, which by
  // then is already in its final place.
  for (let k = 0; k < desired.length; k++) {
    if (stay.has(k)) continue;
    const id = desired[k];
    const index = new Map((await browser.tabs.query({ windowId })).map(t => [t.id, t.index]));
    const from = index.get(id);
    let to = k < firstStay ? index.get(desired[firstStay]) : index.get(desired[k - 1]) + 1;
    if (from < to) to--;
    if (to !== from) await browser.tabs.move(id, { windowId, index: to });
  }
};

// Re-sort Firefox's tab order to match the sidebar.
ZF.normalizeOrder = async windowId => ZF.applyOrder(windowId, ZF.desiredOrder(await ZF.buildView(windowId)));

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

  if (place !== null) {
    const anchor = beforeId ?? afterId;
    return ZF.local.moveItems(
      windowId,
      tabIds.map(id => ({ kind: "tab", id })),
      place,
      anchor ? { anchor: { kind: "tab", id: anchor }, after: Boolean(afterId) } : {}
    );
  }

  for (const id of tabIds) {
    let tab = await browser.tabs.get(id);
    if (tab.pinned) tab = await browser.tabs.update(id, { pinned: false });
    await ZF.setPlace(tab, null);
  }
  const view = await ZF.buildView(windowId);
  const regular = view.regular.map(t => t.id).filter(id => !tabIds.includes(id));
  const at = anchor ? regular.indexOf(anchor) : -1;
  if (at === -1) regular.push(...tabIds);
  else regular.splice(at + (afterId ? 1 : 0), 0, ...tabIds);
  await ZF.applyOrder(windowId, [...ZF.keptOrder(view), ...regular]);
};

// Move tabs and/or folders into a folder (or ROOT), before/after another item
// of that folder, at its start, or at its end. Subfolders and tabs share one
// order, so a subfolder can sit anywhere among a folder's tabs.
ZF.moveItems = async (windowId, moving, key, { anchor = null, after = false, atStart = false } = {}) => {
  if (!moving.length || (anchor && moving.some(m => m.kind === anchor.kind && m.id === anchor.id))) return;
  const parentId = key === ZF.ROOT ? null : key;
  const movingFolders = moving.filter(m => m.kind === "folder").map(m => m.id);
  const folders = await ZF.loadFolders();
  // A folder can't go inside itself or its own subfolders.
  if (parentId && movingFolders.some(id => id === parentId || ZF.isDescendant(folders, parentId, id))) return;

  for (const m of moving) {
    if (m.kind !== "tab") continue;
    let tab = await browser.tabs.get(m.id);
    if (tab.pinned) tab = await browser.tabs.update(m.id, { pinned: false });
    await ZF.setPlace(tab, key);
  }

  const view = await ZF.buildView(windowId);
  view.folders = view.folders.map(f => (movingFolders.includes(f.id) ? { ...f, parentId } : f));
  const isMoving = item => moving.some(m => m.kind === item.kind && m.id === item.id);
  const items = ZF.itemsOf(view, key).filter(item => !isMoving(item));
  let at = items.length;
  if (atStart) at = 0;
  else if (anchor) {
    const i = items.findIndex(item => item.kind === anchor.kind && item.id === anchor.id);
    if (i !== -1) at = i + (after ? 1 : 0);
  }

  // Give the moving items positions between their new neighbours. Nothing
  // else changes, so folders (shared by all windows) keep their place relative
  // to other windows' tabs. Neighbouring tabs that have no stored position yet
  // get their current one stored first, so they don't drift later.
  for (const item of items) {
    if (item.kind === "tab" && !item.tab.zfOrderStored) {
      await browser.sessions.setTabValue(item.id, ZF.ORDER_KEY, item.order);
      ZF.metaCache?.delete(item.id);
    }
  }
  const prev = items[at - 1]?.order;
  const next = items[at]?.order;
  const n = moving.length;
  const low = prev ?? (next !== undefined ? next - n - 1 : 0);
  const high = next ?? low + n + 1;
  const positions = moving.map((_, i) => low + ((high - low) * (i + 1)) / (n + 1));
  // Too little room left between the neighbours (after many moves): space the
  // whole folder out again.
  const crowded = positions.some((p, i) => p <= (positions[i - 1] ?? low) || p >= high);
  let placed = moving.map((item, i) => ({ ...item, order: positions[i] }));
  let respaced = false;
  if (crowded) {
    // Space the folder out again, across every window: folders are shared,
    // so other windows' tabs in this folder are renumbered too, keeping
    // their order relative to the folders.
    const everywhere = [
      ...(await ZF.loadFolders())
        .filter(f => (f.parentId ?? null) === parentId && !movingFolders.includes(f.id))
        .map(f => ({ kind: "folder", id: f.id, order: f.order ?? 0 })),
      ...(await keptTabsEverywhere(key))
        .filter(({ tab }) => !moving.some(m => m.kind === "tab" && m.id === tab.id))
        .map(({ tab, order }) => ({ kind: "tab", id: tab.id, order })),
    ].sort((a, b) => a.order - b.order || (a.kind === b.kind ? 0 : a.kind === "folder" ? -1 : 1));
    // Insert after this window's preceding item (or before its first one).
    const anchorItem = items[at - 1] ?? null;
    const anchorAt = anchorItem ? everywhere.findIndex(i => i.kind === anchorItem.kind && i.id === anchorItem.id) + 1 : 0;
    const firstOfWindow = items[at] ? everywhere.findIndex(i => i.kind === items[at].kind && i.id === items[at].id) : -1;
    const insertAt = anchorItem ? anchorAt : Math.max(0, firstOfWindow);
    everywhere.splice(insertAt, 0, ...moving);
    placed = everywhere.map((item, i) => ({ ...item, order: i }));
    respaced = true;
  }

  const folderOrder = new Map();
  for (const item of placed) {
    if (item.kind === "folder") folderOrder.set(item.id, item.order);
    else {
      await browser.sessions.setTabValue(item.id, ZF.ORDER_KEY, item.order);
      ZF.metaCache?.delete(item.id);
    }
  }
  await ZF.mutateFolders(all => {
    for (const f of all) {
      if (movingFolders.includes(f.id)) f.parentId = parentId;
      if (folderOrder.has(f.id)) f.order = folderOrder.get(f.id);
    }
  });
  if (movingFolders.length || respaced) await ZF.normalizeAllWindows();
  else await ZF.normalizeOrder(windowId);
};

ZF.moveTab = (tabId, place, position) => ZF.moveTabs([tabId], place, position);

ZF.createFolder = async (name, parentId = null) => {
  // Strictly after everything already in the parent, in every window, so it
  // never ties with a tab's position.
  const tabOrders = (await keptTabsEverywhere(parentId ?? ZF.ROOT)).map(t => t.order);
  return ZF.mutateFolders(folders => {
    const siblings = folders.filter(f => (f.parentId ?? null) === parentId).map(f => f.order ?? 0);
    const order = Math.floor(Math.max(2 * UNPOSITIONED, ...siblings, ...tabOrders)) + 1;
    const folder = { id: ZF.newId(), name, parentId, collapsed: false, order };
    folders.push(folder);
    return folder;
  });
};

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

ZF.displayOrder = view => [...view.essentials.map(t => t.id), ...ZF.desiredOrder(view)];

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
  if ((await browser.storage.local.get("placeholdersCleaned")).placeholdersCleaned) return;
  const leftovers = [];
  for (const tab of await browser.tabs.query({})) {
    const marked = await browser.sessions.getTabValue(tab.id, "folderPlaceholder").catch(() => undefined);
    const looksLikeOne = tab.title === "Folder placeholder" && tab.url?.startsWith("moz-extension://");
    if (marked || looksLikeOne) leftovers.push(tab.id);
  }
  if (leftovers.length) await browser.tabs.remove(leftovers);
  await browser.storage.local.set({ placeholdersCleaned: true });
};

// Convert Firefox tab groups into folders (subfolders use the leading-space
// naming from the userChrome.css setup), then ungroup them.
// `onlyGroupIds`: convert just these (named groups whose name has settled);
// without it, every group (startup, or turning conversion back on).
ZF.migrateNativeGroups = async (onlyGroupIds = null) => {
  let groups;
  try {
    groups = await browser.tabGroups.query({});
  } catch {
    return 0;
  }
  if (onlyGroupIds) groups = groups.filter(g => onlyGroupIds.includes(g.id) && g.title?.trim());
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
      // Like Zen: subfolders above the folder's own (unpositioned) tabs.
      const siblings = (await ZF.loadFolders()).filter(f => (f.parentId ?? null) === parentId && f.id !== folder.id).length;
      await ZF.local.updateFolder(folder.id, { collapsed: Boolean(group.collapsed), order: siblings });
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
  "removeFolder",
  "moveTabs",
  "moveItems",
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
