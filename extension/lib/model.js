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
//
// Spaces (like Zen's): each window shows one space at a time. Essentials are
// shared; every other tab belongs to one space ("zfSpace" session value) and
// top-level folders carry a spaceId (subfolders follow their top folder).
// Untagged tabs belong to whichever space their window shows, so new tabs
// land in the current space; they're tagged when the window switches away.
// Tabs of other spaces are hidden in Firefox (tabs.hide), so Ctrl+Tab, the
// tab list and tab search only see the current space.

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
  const report = { restoredFromBackup: 0, recoveredFolders: 0, restoredSpaces: await restoreSpacesIfMissing() };
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
  // Each orphaned folder id, with the space of a tab that points at it.
  const orphans = new Map();
  for (const tab of await browser.tabs.query({})) {
    const place = await ZF.getPlace(tab.id);
    if (place && place !== ZF.ROOT && !known.has(place) && !orphans.get(place)) orphans.set(place, await getSpaceTag(tab.id));
  }
  if (orphans.size) {
    await ZF.mutateFolders(folders => {
      let n = folders.filter(f => f.name.startsWith("Recovered folder")).length;
      for (const [id, spaceId] of orphans) {
        folders.push({ id, name: `Recovered folder ${++n}`, parentId: null, collapsed: true, order: folders.length, ...(spaceId ? { spaceId } : {}) });
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

// ---------------------------------------------------------------------------
// Spaces
// ---------------------------------------------------------------------------

ZF.SPACE_KEY = "zfSpace";
ZF.WINDOW_SPACE_KEY = "zfActiveSpace";
ZF.SPACES_BACKUP_KEY = "zfSpacesBackup";
ZF.SPACE_ICONS = ["🏠", "💼", "🧪", "📚", "🎨", "🎮", "🎵", "✈️", "🛒", "💬", "📰", "⭐", "🔥", "🌱", "🌙", "☕", "🐙", "🚀"];
// Sidebar-only menu items for a space (built in background.js).
ZF.SPACE_MENU_ITEMS = ["zf-space-rename", "zf-space-icon", "zf-space-bg", "zf-space-left", "zf-space-right", "zf-space-delete", "zf-space-new"];
const DEFAULT_SPACE = { id: "home", name: "Home", icon: "🏠", background: null };

// Never empty: without saved spaces there's one, Home.
ZF.loadSpaces = async () => {
  const { spaces } = await browser.storage.local.get("spaces");
  return Array.isArray(spaces) && spaces.length ? spaces : [{ ...DEFAULT_SPACE }];
};

// Mirrored into the session store like folders (see saveFolders).
ZF.saveSpaces = async spaces => {
  await browser.storage.local.set({ spaces });
  const backup = { savedAt: Date.now(), spaces };
  for (const win of await browser.windows.getAll({ windowTypes: ["normal"] })) {
    await browser.sessions.setWindowValue(win.id, ZF.SPACES_BACKUP_KEY, backup).catch(() => {});
  }
};

async function restoreSpacesIfMissing() {
  if ((await browser.storage.local.get("spaces")).spaces?.length) return 0;
  let newest = null;
  for (const win of await browser.windows.getAll({ windowTypes: ["normal"] })) {
    const backup = await browser.sessions.getWindowValue(win.id, ZF.SPACES_BACKUP_KEY).catch(() => null);
    if (Array.isArray(backup?.spaces) && backup.spaces.length && (!newest || backup.savedAt > newest.savedAt)) newest = backup;
  }
  if (!newest) return 0;
  await ZF.saveSpaces(newest.spaces);
  return newest.spaces.length;
}

// Unknown ids (a deleted space, or spaces lost with storage) mean the first space.
ZF.resolveSpace = (spaces, id) => (spaces.find(s => s.id === id) ?? spaces[0]).id;

ZF.activeSpaceId = async (windowId, spaces) =>
  ZF.resolveSpace(spaces, await browser.sessions.getWindowValue(windowId, ZF.WINDOW_SPACE_KEY).catch(() => undefined));

// A folder's space is its top-level folder's.
ZF.folderSpace = (folders, folder, spaces) => {
  const seen = new Set();
  let top = folder;
  while (top.parentId && !seen.has(top.id)) {
    seen.add(top.id);
    const parent = folders.find(f => f.id === top.parentId);
    if (!parent) break;
    top = parent;
  }
  return ZF.resolveSpace(spaces, top.spaceId);
};

ZF.tabSpace = (tag, spaces, windowSpace) => (tag ? ZF.resolveSpace(spaces, tag) : windowSpace);

const getSpaceTag = tabId => browser.sessions.getTabValue(tabId, ZF.SPACE_KEY).catch(() => undefined);
// Every tab's tag at once: switching with hundreds of tabs shouldn't wait
// on each read in turn.
const spaceTags = tabs => Promise.all(tabs.map(t => (t.pinned ? undefined : getSpaceTag(t.id))));

// Firefox can't hide a tab that's sharing the camera, microphone or screen.
ZF.isSharing = tab => Boolean(tab.sharingState?.camera || tab.sharingState?.microphone || tab.sharingState?.screen);

// Every write of a tab's sidebar metadata goes through here, so the sidebars
// can be told exactly which tabs changed (see notifyChanged).
ZF.changedTabs = new Set();
ZF.setMeta = async (tabId, key, value) => {
  if (value === undefined) await browser.sessions.removeTabValue(tabId, key);
  else await browser.sessions.setTabValue(tabId, key, value);
  ZF.metaCache?.delete(tabId);
  ZF.changedTabs.add(tabId);
};

ZF.setPlace = async (tab, place) => {
  if (place === null) {
    await ZF.setMeta(tab.id, ZF.FOLDER_KEY, undefined);
    await ZF.setMeta(tab.id, ZF.ORIGINAL_URL_KEY, undefined);
    await ZF.setMeta(tab.id, ZF.ORDER_KEY, undefined);
    return;
  }
  await ZF.setMeta(tab.id, ZF.FOLDER_KEY, place);
  const original = await browser.sessions.getTabValue(tab.id, ZF.ORIGINAL_URL_KEY).catch(() => undefined);
  if (!original && ZF.isRealUrl(tab.url)) await ZF.setMeta(tab.id, ZF.ORIGINAL_URL_KEY, tab.url);
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
// ZF.metaCache = new Map()). They only change through the background
// (ZF.setMeta), which then sends "zf-changed" with the tabs that changed, and
// the sidebar drops just those from its cache.
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
  const space = await get(ZF.SPACE_KEY);
  const meta = place
    ? { place, space, original: await get(ZF.ORIGINAL_URL_KEY), order: await get(ZF.ORDER_KEY) }
    : { place: null, space };
  cache?.set(tab.id, meta);
  return meta;
}

ZF.buildView = async windowId => {
  const [allTabs, allFolders, spaces] = await Promise.all([browser.tabs.query({ windowId }), ZF.loadFolders(), ZF.loadSpaces()]);
  const spaceId = await ZF.activeSpaceId(windowId, spaces);
  // Only this space's folders; a tab whose folder is in another space shows
  // at the top level.
  const folders = allFolders.filter(f => ZF.folderSpace(allFolders, f, spaces) === spaceId);
  const tabs = allTabs.filter(t => !t.hidden).sort((a, b) => a.index - b.index);
  const known = new Set(folders.map(f => f.id));
  const metas = await Promise.all(tabs.map(readMeta));

  const view = {
    windowId,
    folders,
    spaces,
    spaceId,
    space: spaces.find(s => s.id === spaceId),
    essentials: [],
    byPlace: new Map(),
    regular: [],
    activeId: null,
    tabsById: new Map(),
  };
  tabs.forEach((tab, i) => {
    if (tab.pinned) {
      view.tabsById.set(tab.id, tab);
      if (tab.active) view.activeId = tab.id;
      view.essentials.push(tab);
      return;
    }
    // Other spaces' tabs are normally hidden already; this covers the moment
    // before hiding catches up. A tab Firefox can't hide (sharing the camera,
    // microphone or screen) stays listed: it's still in Firefox's tab order.
    if (ZF.tabSpace(metas[i].space, spaces, spaceId) !== spaceId && !ZF.isSharing(tab)) return;
    view.tabsById.set(tab.id, tab);
    if (tab.active) view.activeId = tab.id;
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

// Positions of kept tabs in `key`, across every window. Unpositioned tabs
// are ranked exactly as buildView ranks them: by index among the window's
// visible tabs. Hidden tabs don't count towards that rank, but hidden tabs
// with a stored position are included, so a respace renumbers them along
// with everything else and they reappear where they were.
async function keptTabsEverywhere(key) {
  const out = [];
  const known = new Set((await ZF.loadFolders()).map(f => f.id));
  const byWindow = new Map();
  for (const tab of await browser.tabs.query({})) {
    if (!byWindow.has(tab.windowId)) byWindow.set(tab.windowId, []);
    byWindow.get(tab.windowId).push(tab);
  }
  for (const tabs of byWindow.values()) {
    tabs.sort((a, b) => a.index - b.index);
    let visibleIndex = -1;
    for (const tab of tabs) {
      if (!tab.hidden) visibleIndex++;
      if (tab.pinned) continue;
      let place = await ZF.getPlace(tab.id);
      // Same fallback as buildView: a tab whose folder is gone shows at the top level.
      if (place && place !== ZF.ROOT && !known.has(place)) place = ZF.ROOT;
      if (place !== key) continue;
      const order = await browser.sessions.getTabValue(tab.id, ZF.ORDER_KEY).catch(() => undefined);
      if (typeof order === "number") out.push({ tab, order });
      else if (!tab.hidden) out.push({ tab, order: UNPOSITIONED + visibleIndex });
    }
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
  // Only the tabs being ordered: other spaces' tabs keep their own order.
  const wanted = new Set(desired);
  const visible = (await browser.tabs.query({ windowId, pinned: false })).filter(t => wanted.has(t.id)).sort((a, b) => a.index - b.index);
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
      await ZF.setMeta(item.id, ZF.ORDER_KEY, item.order);
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
    const indexOf = item => (item ? everywhere.findIndex(i => i.kind === item.kind && i.id === item.id) : -1);
    const after = indexOf(items[at - 1]);
    const before = indexOf(items[at]);
    const insertAt = after !== -1 ? after + 1 : before !== -1 ? before : at === 0 ? 0 : everywhere.length;
    everywhere.splice(insertAt, 0, ...moving);
    placed = everywhere.map((item, i) => ({ ...item, order: i }));
    respaced = true;
  }

  const folderOrder = new Map();
  for (const item of placed) {
    if (item.kind === "folder") folderOrder.set(item.id, item.order);
    else {
      await ZF.setMeta(item.id, ZF.ORDER_KEY, item.order);
    }
  }
  const spaceId = parentId === null && movingFolders.length ? await ZF.activeSpaceId(windowId, await ZF.loadSpaces()) : null;
  await ZF.mutateFolders(all => {
    for (const f of all) {
      if (movingFolders.includes(f.id)) {
        f.parentId = parentId;
        if (spaceId) f.spaceId = spaceId;
      }
      if (folderOrder.has(f.id)) f.order = folderOrder.get(f.id);
    }
  });
  if (movingFolders.length || respaced) await ZF.normalizeAllWindows();
  else await ZF.normalizeOrder(windowId);
};

ZF.moveTab = (tabId, place, position) => ZF.moveTabs([tabId], place, position);

// spaceId: for a top-level folder (subfolders follow their parent); without
// one it goes in the first space.
ZF.createFolder = async (name, parentId = null, spaceId = null) => {
  // Strictly after everything already in the parent, in every window, so it
  // never ties with a tab's position.
  const tabOrders = (await keptTabsEverywhere(parentId ?? ZF.ROOT)).map(t => t.order);
  return ZF.mutateFolders(folders => {
    const siblings = folders.filter(f => (f.parentId ?? null) === parentId).map(f => f.order ?? 0);
    const order = Math.floor(Math.max(2 * UNPOSITIONED, ...siblings, ...tabOrders)) + 1;
    const folder = { id: ZF.newId(), name, parentId, collapsed: false, order };
    if (!parentId && spaceId) folder.spaceId = spaceId;
    folders.push(folder);
    return folder;
  });
};

ZF.updateFolder = (folderId, changes) =>
  ZF.mutateFolders(folders => {
    const folder = folders.find(f => f.id === folderId);
    if (folder) Object.assign(folder, changes);
  });

// Open or close every folder at once (or just these, e.g. one space's).
ZF.setAllCollapsed = (collapsed, folderIds = null) =>
  ZF.mutateFolders(folders => {
    for (const folder of folders) if (!folderIds || folderIds.includes(folder.id)) folder.collapsed = collapsed;
  });

// Remove a folder but keep everything in it: its subfolders and tabs move up
// to its parent.
ZF.removeFolder = async folderId => {
  const spaces = await ZF.loadSpaces();
  const folder = await ZF.mutateFolders(folders => {
    const index = folders.findIndex(f => f.id === folderId);
    if (index === -1) return null;
    // Children that become top-level folders stay in the same space.
    const spaceId = ZF.folderSpace(folders, folders[index], spaces);
    const [removed] = folders.splice(index, 1);
    for (const child of folders.filter(f => f.parentId === folderId)) {
      child.parentId = removed.parentId ?? null;
      if (!child.parentId) child.spaceId = spaceId;
    }
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
// spaceId: the space Clear was clicked in; nothing closes if the window has
// switched to another one since.
ZF.clearRegular = async (windowId, spaceId = null) => {
  // Work out what's regular now, not from what a sidebar last drew.
  const view = await ZF.buildView(windowId);
  if (spaceId && view.spaceId !== spaceId) return 0;
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

// The space of the last focused normal window: where imported and restored
// things go when the file doesn't say.
async function focusedSpaceId(spaces) {
  const win = await browser.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null);
  return win ? ZF.activeSpaceId(win.id, spaces) : spaces[0].id;
}

// Import folders exported from Zen (export_zen_folders.py): recreate the
// folder tree and move every open tab whose address matches a tab that was
// in a Zen folder into it. Existing folders are kept; "Recovered" folders
// left empty by the import are removed.
ZF.importZenFolders = async data => {
  if (!Array.isArray(data?.folders) || !Array.isArray(data?.tabs)) throw new Error("Not a Zen folders export");
  // Everything goes into the current space.
  const spaceId = await focusedSpaceId(await ZF.loadSpaces());
  const idMap = new Map();
  await ZF.mutateFolders(folders => {
    const pending = [...data.folders];
    // Parents first, so each child can point at its new parent id.
    while (pending.length) {
      const i = pending.findIndex(f => !f.parentId || idMap.has(f.parentId) || !data.folders.some(p => p.id === f.parentId));
      const [zen] = pending.splice(i === -1 ? 0 : i, 1);
      const parentId = zen.parentId ? idMap.get(zen.parentId) ?? null : null;
      const folder = { id: ZF.newId(), name: String(zen.name || "Folder"), parentId, collapsed: Boolean(zen.collapsed), order: ZF.childrenOf(folders, parentId).length };
      if (!parentId) folder.spaceId = spaceId;
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
    await ZF.setMeta(tab.id, ZF.SPACE_KEY, spaceId);
    placed++;
  }

  await dropEmptyRecoveredFolders();
  await ZF.local.showAllSpaces();
  await ZF.normalizeAllWindows();
  return { folders: idMap.size, tabs: placed };
};

// Drop "Recovered" folders that no longer hold anything.
async function dropEmptyRecoveredFolders() {
  const used = new Set();
  for (const tab of await browser.tabs.query({})) used.add(await ZF.getPlace(tab.id));
  await ZF.mutateFolders(folders => {
    for (let i = folders.length - 1; i >= 0; i--) {
      const f = folders[i];
      if (f.name.startsWith("Recovered folder") && !used.has(f.id) && !folders.some(c => c.parentId === f.id)) folders.splice(i, 1);
    }
  });
}

// ---------------------------------------------------------------------------
// Backup file: spaces, folders, kept tabs (place, position, address, space)
// and Essentials. Private windows are left out. Version 1 files (before
// spaces) still restore, into the current space.
// ---------------------------------------------------------------------------

ZF.BACKUP_FORMAT = "zen-folder-tools-backup";
// Container (cookie store) of a tab. Restore only matches tabs in the same
// container, and can only reopen tabs outside containers: opening one in a
// container needs the "cookies" permission, which this extension doesn't have.
const DEFAULT_CONTAINER = "firefox-default";
const containerOf = tab => tab.cookieStoreId ?? DEFAULT_CONTAINER;
const containerField = value => (typeof value === "string" && value.length <= 100 ? value : DEFAULT_CONTAINER);
const cleanName = name => String(name ?? "").trim().slice(0, 500) || "Folder";
// Longer addresses (e.g. huge data in a query string) aren't backed up.
const MAX_URL = 8192;

ZF.isWebUrl = url => {
  try {
    return ["http:", "https:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
};

ZF.exportFolders = async () => {
  const [folders, spaces] = await Promise.all([ZF.loadFolders(), ZF.loadSpaces()]);
  const windowSpace = new Map();
  const known = new Set(folders.map(f => f.id));
  const tabs = [];
  const essentials = [];
  let skippedLongAddresses = 0;
  const all = (await browser.tabs.query({})).filter(t => !t.incognito).sort((a, b) => a.windowId - b.windowId || a.index - b.index);
  for (const tab of all) {
    if (tab.pinned) {
      if (ZF.isWebUrl(tab.url) && tab.url.length > MAX_URL) skippedLongAddresses++;
      else if (ZF.isWebUrl(tab.url)) essentials.push({ url: tab.url, title: tab.title ?? "", container: containerOf(tab) });
      continue;
    }
    const place = await ZF.getPlace(tab.id);
    if (!place) continue;
    if (tab.url.length > MAX_URL) {
      skippedLongAddresses++;
      continue;
    }
    const get = key => browser.sessions.getTabValue(tab.id, key).catch(() => undefined);
    const order = await get(ZF.ORDER_KEY);
    if (!windowSpace.has(tab.windowId)) windowSpace.set(tab.windowId, await ZF.activeSpaceId(tab.windowId, spaces));
    tabs.push({
      space: ZF.tabSpace(await get(ZF.SPACE_KEY), spaces, windowSpace.get(tab.windowId)),
      place: known.has(place) ? place : ZF.ROOT,
      order: typeof order === "number" ? order : null,
      url: tab.url,
      originalUrl: (await get(ZF.ORIGINAL_URL_KEY)) ?? null,
      title: tab.title ?? "",
      container: containerOf(tab),
    });
  }
  return {
    format: ZF.BACKUP_FORMAT,
    version: 2,
    exportedAt: new Date().toISOString(),
    spaces: spaces.map(sp => ({ id: sp.id, name: sp.name, icon: sp.icon, background: sp.background ?? null })),
    folders: folders.map(f => ({
      id: f.id,
      name: f.name,
      parentId: f.parentId ?? null,
      collapsed: Boolean(f.collapsed),
      order: f.order ?? 0,
      // Subfolders follow their top folder.
      spaceId: f.parentId ? null : ZF.folderSpace(folders, f, spaces),
    })),
    tabs,
    essentials,
    // Informational only; restore ignores it.
    skippedLongAddresses,
  };
};

// Checks a whole backup file before anything is changed; throws on anything
// unexpected and returns a clean copy.
ZF.parseBackup = data => {
  const fail = why => {
    throw new Error(`Not a valid backup: ${why}`);
  };
  if (data?.format !== ZF.BACKUP_FORMAT || ![1, 2].includes(data.version)) fail("unknown format");
  if (!Array.isArray(data.folders) || !Array.isArray(data.tabs) || !Array.isArray(data.essentials ?? []) || !Array.isArray(data.spaces ?? [])) fail("missing lists");
  if (data.folders.length > 5000 || data.tabs.length > 20000 || (data.essentials ?? []).length > 1000 || (data.spaces ?? []).length > 100) fail("too large");
  const str = (v, max) => typeof v === "string" && v.length <= max;
  const num = v => typeof v === "number" && Number.isFinite(v);
  const spaces = (data.spaces ?? []).map(sp => {
    if (!str(sp?.id, 100) || !sp.id || typeof sp.name !== "string") fail("bad space");
    return {
      id: sp.id,
      name: cleanSpaceName(sp.name) || "Space",
      icon: ZF.SPACE_ICONS.includes(sp.icon) ? sp.icon : ZF.SPACE_ICONS[0],
      background: ZF.BACKGROUNDS.includes(sp.background) ? sp.background : null,
    };
  });
  const spaceIds = new Set(spaces.map(sp => sp.id));
  if (spaceIds.size !== spaces.length) fail("duplicate space ids");
  // A space the file doesn't define means "the current space".
  const spaceField = v => (v === null || v === undefined ? null : str(v, 100) ? (spaceIds.has(v) ? v : null) : fail("bad space reference"));
  const folders = data.folders.map(f => {
    if (!str(f?.id, 100) || !f.id || f.id === ZF.ROOT || typeof f.name !== "string") fail("bad folder");
    if (f.parentId !== null && f.parentId !== undefined && !str(f.parentId, 100)) fail("bad folder parent");
    return { id: f.id, name: cleanName(f.name), parentId: f.parentId ?? null, collapsed: f.collapsed === true, order: num(f.order) ? f.order : 0, spaceId: spaceField(f.spaceId) };
  });
  const byId = new Map(folders.map(f => [f.id, f]));
  if (byId.size !== folders.length) fail("duplicate folder ids");
  for (const f of folders) {
    if (f.parentId !== null && !byId.has(f.parentId)) fail("folder parent missing");
    // No loops: following parents must reach the top.
    const seen = new Set();
    for (let p = f; p; p = p.parentId === null ? null : byId.get(p.parentId)) {
      if (seen.has(p.id)) fail("folder loop");
      seen.add(p.id);
    }
  }
  // Addresses longer than MAX_URL are skipped, as on export.
  const tooLong = e => typeof e?.url === "string" && e.url.length > MAX_URL;
  const skippedLongAddresses = data.tabs.filter(tooLong).length + (data.essentials ?? []).filter(tooLong).length;
  const tabs = data.tabs.filter(t => !tooLong(t)).map(t => {
    if (!str(t?.url, MAX_URL) || !(t.place === ZF.ROOT || byId.has(t.place))) fail("bad tab");
    if (t.originalUrl !== null && t.originalUrl !== undefined && typeof t.originalUrl !== "string") fail("bad tab address");
    const originalUrl = typeof t.originalUrl === "string" && t.originalUrl.length <= MAX_URL ? t.originalUrl : null;
    return { place: t.place, order: num(t.order) ? t.order : null, url: t.url, originalUrl, container: containerField(t.container), title: str(t.title, 2000) ? t.title : "", space: spaceField(t.space) };
  });
  const essentials = (data.essentials ?? []).filter(e => !tooLong(e)).map(e => {
    if (!str(e?.url, MAX_URL)) fail("bad Essential");
    return { url: e.url, title: str(e.title, 2000) ? e.title : "", container: containerField(e.container) };
  });
  return { spaces, folders, tabs, essentials, skippedLongAddresses };
};

// Merges a backup in; nothing is removed. Spaces with the same name, and
// folders with the same name, parent and space, are reused (so restoring
// twice doesn't duplicate them); open tabs with a matching address are moved
// into place (and into their space), and missing kept tabs are reopened
// unloaded. Missing Essentials are reopened as pinned tabs.
ZF.restoreFolders = async raw => {
  const data = ZF.parseBackup(raw);
  const report = { spacesCreated: 0, foldersCreated: 0, foldersMatched: 0, tabsMoved: 0, tabsOpened: 0, essentialsOpened: 0, skippedInContainers: 0, skippedLongAddresses: data.skippedLongAddresses };

  const spaceMap = new Map();
  await ZF.mutateSpaces(spaces => {
    for (const sp of data.spaces) {
      const same = spaces.find(x => cleanSpaceName(x.name) === sp.name && ![...spaceMap.values()].includes(x.id));
      if (same) spaceMap.set(sp.id, same.id);
      else {
        const created = { ...sp, id: `s${ZF.newId().slice(1)}` };
        spaces.push(created);
        spaceMap.set(sp.id, created.id);
        report.spacesCreated++;
      }
    }
  });
  const spaces = await ZF.loadSpaces();
  const current = await focusedSpaceId(spaces);
  const spaceOf = id => (id === null ? current : spaceMap.get(id) ?? current);

  const idMap = new Map();
  await ZF.mutateFolders(folders => {
    const pending = [...data.folders];
    // Parents first (parseBackup guarantees every parent exists, without loops).
    while (pending.length) {
      const [f] = pending.splice(pending.findIndex(p => p.parentId === null || idMap.has(p.parentId)), 1);
      const parentId = f.parentId === null ? null : idMap.get(f.parentId);
      const taken = new Set(idMap.values());
      // Names are compared the way parseBackup cleans them up.
      // A top-level folder is only the same folder in the same space.
      const spaceId = parentId === null ? spaceOf(f.spaceId) : null;
      const same = folders.find(
        x => (x.parentId ?? null) === parentId && cleanName(x.name) === f.name && !taken.has(x.id) && (parentId !== null || ZF.folderSpace(folders, x, spaces) === spaceId)
      );
      if (same) {
        idMap.set(f.id, same.id);
        report.foldersMatched++;
      } else {
        const folder = { id: ZF.newId(), name: f.name, parentId, collapsed: f.collapsed, order: f.order };
        if (spaceId) folder.spaceId = spaceId;
        folders.push(folder);
        idMap.set(f.id, folder.id);
        report.foldersCreated++;
      }
    }
  });

  // Open tabs that entries can be matched to, by container and address. Each
  // open tab is matched at most once, so duplicates round-trip.
  // Only tabs in normal windows: not a Glance or other popup.
  const normal = new Set((await browser.windows.getAll({ windowTypes: ["normal"] })).map(w => w.id));
  const open = (await browser.tabs.query({})).filter(t => !t.incognito && normal.has(t.windowId));
  const keyOf = (container, url) => `${container}\n${url}`;
  const pool = new Map();
  const pinnedPool = new Map();
  const offer = (map, url, tab) => {
    if (!url) return;
    const key = keyOf(containerOf(tab), url);
    (map.get(key) ?? map.set(key, []).get(key)).push(tab);
  };
  for (const tab of open) {
    if (tab.pinned) {
      offer(pinnedPool, tab.url, tab);
      continue;
    }
    offer(pool, tab.url, tab);
    offer(pool, await browser.sessions.getTabValue(tab.id, ZF.ORIGINAL_URL_KEY).catch(() => undefined), tab);
  }
  const used = new Set();
  const take = async (map, container, urls, accept = async () => true) => {
    for (const url of urls) {
      for (const tab of map.get(keyOf(container, url)) ?? []) {
        if (!used.has(tab.id) && (await accept(tab))) {
          used.add(tab.id);
          return tab;
        }
      }
    }
    return null;
  };
  // Reopened tabs go to the last focused window (never a private one).
  const target = await browser.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null);
  const windowId = target && !target.incognito ? target.id : (await browser.windows.getAll({ windowTypes: ["normal"] })).find(w => !w.incognito)?.id;

  for (const t of data.tabs) {
    let tab = await take(pool, t.container, [t.url, t.originalUrl].filter(Boolean));
    if (tab) report.tabsMoved++;
    else {
      if (t.container !== DEFAULT_CONTAINER) {
        report.skippedInContainers++;
        continue;
      }
      if (windowId === undefined || !ZF.isWebUrl(t.url)) continue;
      tab = await browser.tabs.create({ windowId, url: t.url, active: false, discarded: true, ...(t.title ? { title: t.title } : {}) }).catch(() => null);
      if (!tab) continue;
      report.tabsOpened++;
    }
    const place = t.place === ZF.ROOT ? ZF.ROOT : idMap.get(t.place);
    const previous = await ZF.getPlace(tab.id);
    await ZF.setPlace(tab, place);
    // A tab in a folder goes to the folder's space.
    const folders = await ZF.loadFolders();
    const folder = folders.find(f => f.id === place);
    await ZF.setMeta(tab.id, ZF.SPACE_KEY, folder ? ZF.folderSpace(folders, folder, spaces) : spaceOf(t.space));
    if (t.originalUrl && ZF.isWebUrl(t.originalUrl)) await ZF.setMeta(tab.id, ZF.ORIGINAL_URL_KEY, t.originalUrl);
    // A position only means something within its folder.
    if (t.order !== null) await ZF.setMeta(tab.id, ZF.ORDER_KEY, t.order);
    else if (previous !== place) await ZF.setMeta(tab.id, ZF.ORDER_KEY, undefined);
  }

  for (const e of data.essentials) {
    if (!ZF.isWebUrl(e.url)) continue;
    // Already an Essential.
    if (await take(pinnedPool, e.container, [e.url])) continue;
    // Only a regular tab becomes an Essential; a kept tab stays in its folder.
    const tab = await take(pool, e.container, [e.url], async candidate => !(await ZF.getPlace(candidate.id)));
    if (tab) {
      await browser.tabs.update(tab.id, { pinned: true });
    } else if (e.container !== DEFAULT_CONTAINER) {
      report.skippedInContainers++;
    } else if (windowId !== undefined && (await browser.tabs.create({ windowId, url: e.url, pinned: true, active: false }).catch(() => null))) {
      report.essentialsOpened++;
    }
  }

  await dropEmptyRecoveredFolders();
  await ZF.local.showAllSpaces();
  await ZF.normalizeAllWindows();
  return report;
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
  const spaces = await ZF.loadSpaces();
  for (const [windowId, entries] of byWindow) {
    const spaceId = await ZF.activeSpaceId(windowId, spaces);
    entries.sort((a, b) => a.first - b.first);
    const stack = [];
    for (const { group, groupTabs } of entries) {
      const title = group.title ?? "";
      const depth = title.length - title.trimStart().length;
      while (stack.length > depth) stack.pop();
      const parentId = stack.at(-1) ?? null;
      const folder = await ZF.local.createFolder(title.trim() || "Folder", parentId, spaceId);
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
// Space changes. Like every other change they run in the background, one at
// a time; inside them, other changes are called through ZF.local.
// ---------------------------------------------------------------------------

const cleanSpaceName = name => String(name ?? "").trim().slice(0, 50);

ZF.mutateSpaces = async fn => {
  const spaces = await ZF.loadSpaces();
  const result = await fn(spaces);
  await ZF.saveSpaces(spaces);
  return result;
};

// Show the window's space in Firefox and hide every other space's tabs.
// Firefox can't hide the active tab, so if it's leaving, the space's most
// recently used tab is switched to first (or a new tab opens in an empty
// space). focusLatest: also leave an Essential for the space's last tab.
async function showSpace(windowId, { focusLatest = false } = {}) {
  const spaces = await ZF.loadSpaces();
  const spaceId = await ZF.activeSpaceId(windowId, spaces);
  const show = [];
  const hide = [];
  const here = [];
  let active = null;
  const tabs = await browser.tabs.query({ windowId });
  const tags = await spaceTags(tabs);
  for (const [i, tab] of tabs.entries()) {
    if (tab.active) active = tab;
    if (tab.pinned) continue;
    if (ZF.tabSpace(tags[i], spaces, spaceId) === spaceId) {
      here.push(tab);
      if (tab.hidden) show.push(tab.id);
    } else if (!tab.hidden) hide.push(tab.id);
  }
  if (show.length) await browser.tabs.show(show);
  const latest = [...here].sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
  const leaving = active && !active.pinned && !here.includes(active);
  if (leaving || (focusLatest && active?.pinned && latest)) {
    if (latest) await browser.tabs.update(latest.id, { active: true });
    else await browser.tabs.create({ windowId });
  }
  if (hide.length) await browser.tabs.hide(hide).catch(error => console.error("Hide tabs:", error));
}

ZF.showSpaceIn = windowId => showSpace(windowId);

ZF.showAllSpaces = async () => {
  for (const win of await browser.windows.getAll({ windowTypes: ["normal"] })) await showSpace(win.id);
};

ZF.switchSpace = async (windowId, spaceId) => {
  const spaces = await ZF.loadSpaces();
  const from = await ZF.activeSpaceId(windowId, spaces);
  const to = ZF.resolveSpace(spaces, spaceId);
  if (from !== to) {
    // Untagged tabs follow the window's space, so pin them to the one they're in.
    const tabs = await browser.tabs.query({ windowId, pinned: false });
    const tags = await spaceTags(tabs);
    await Promise.all(tabs.filter((_, i) => !tags[i]).map(t => ZF.setMeta(t.id, ZF.SPACE_KEY, from)));
    await browser.sessions.setWindowValue(windowId, ZF.WINDOW_SPACE_KEY, to);
  }
  await showSpace(windowId, { focusLatest: from !== to });
};

// Next (1) or previous (-1) space; stops at the ends.
ZF.switchSpaceBy = async (windowId, delta) => {
  const spaces = await ZF.loadSpaces();
  const active = await ZF.activeSpaceId(windowId, spaces);
  const next = spaces[spaces.findIndex(s => s.id === active) + Math.sign(delta)];
  if (next) await ZF.local.switchSpace(windowId, next.id);
};

// name and icon come from the New Space dialog; without them it's "Space N"
// with the first icon no other space uses.
ZF.createSpace = async (windowId = null, { name = "", icon = null } = {}) => {
  const space = await ZF.mutateSpaces(spaces => {
    const used = new Set(spaces.map(s => s.icon));
    const created = {
      id: `s${ZF.newId().slice(1)}`,
      name: cleanSpaceName(name) || `Space ${spaces.length + 1}`,
      icon: ZF.SPACE_ICONS.includes(icon) ? icon : ZF.SPACE_ICONS.find(i => !used.has(i)) ?? "⭐",
      background: null,
    };
    spaces.push(created);
    return created;
  });
  if (windowId !== null) await ZF.local.switchSpace(windowId, space.id);
  return space;
};

ZF.updateSpace = (spaceId, changes) =>
  ZF.mutateSpaces(spaces => {
    const space = spaces.find(s => s.id === spaceId);
    if (!space) return;
    if ("name" in changes && cleanSpaceName(changes.name)) space.name = cleanSpaceName(changes.name);
    if ("icon" in changes && ZF.SPACE_ICONS.includes(changes.icon)) space.icon = changes.icon;
    if ("background" in changes) space.background = ZF.BACKGROUNDS.includes(changes.background) ? changes.background : null;
  });

// Folders, windows and tabs without a (known) space belong to the first
// one. Before another space becomes first, give them that space for real.
async function pinToFirstSpace(spaces) {
  const first = spaces[0].id;
  const known = new Set(spaces.map(s => s.id));
  await ZF.mutateFolders(folders => {
    for (const f of folders) if (!f.parentId && !known.has(f.spaceId)) f.spaceId = first;
  });
  for (const win of await browser.windows.getAll({ windowTypes: ["normal"] })) {
    if (!known.has(await browser.sessions.getWindowValue(win.id, ZF.WINDOW_SPACE_KEY).catch(() => undefined))) {
      await browser.sessions.setWindowValue(win.id, ZF.WINDOW_SPACE_KEY, first);
    }
  }
  const tabs = await browser.tabs.query({ pinned: false });
  const tags = await spaceTags(tabs);
  await Promise.all(tabs.filter((_, i) => tags[i] && !known.has(tags[i])).map(t => ZF.setMeta(t.id, ZF.SPACE_KEY, first)));
}

// Move a space left (-1) or right (1) in the switcher.
ZF.moveSpace = async (spaceId, delta) => {
  const spaces = await ZF.loadSpaces();
  const i = spaces.findIndex(s => s.id === spaceId);
  const j = i + Math.sign(delta);
  if (i === -1 || j < 0 || j >= spaces.length) return;
  if (i === 0 || j === 0) await pinToFirstSpace(spaces);
  await ZF.mutateSpaces(all => {
    [all[i], all[j]] = [all[j], all[i]];
  });
  await ZF.local.showAllSpaces();
};

// Nothing is closed: the space's tabs and folders move to the space before
// it (or after it, for the first one), and windows showing it switch there.
ZF.deleteSpace = async spaceId => {
  const spaces = await ZF.loadSpaces();
  const i = spaces.findIndex(s => s.id === spaceId);
  if (i === -1 || spaces.length < 2) return;
  const target = spaces[i === 0 ? 1 : i - 1].id;
  const windows = await browser.windows.getAll({ windowTypes: ["normal"] });
  for (const win of windows) {
    const shown = await ZF.activeSpaceId(win.id, spaces);
    const tabs = await browser.tabs.query({ windowId: win.id, pinned: false });
    const tags = await spaceTags(tabs);
    await Promise.all(tabs.filter((_, i) => ZF.tabSpace(tags[i], spaces, shown) === spaceId).map(t => ZF.setMeta(t.id, ZF.SPACE_KEY, target)));
    if (shown === spaceId) await browser.sessions.setWindowValue(win.id, ZF.WINDOW_SPACE_KEY, target);
  }
  await ZF.mutateFolders(folders => {
    const top = folders.filter(f => !f.parentId || !folders.some(p => p.id === f.parentId));
    for (const f of top) if (ZF.folderSpace(folders, f, spaces) === spaceId) f.spaceId = target;
  });
  await ZF.mutateSpaces(all => all.splice(all.findIndex(s => s.id === spaceId), 1));
  for (const win of windows) await showSpace(win.id);
};

// A folder belongs to one space, so a kept tab moving to another space
// leaves its folder for that space's top level.
ZF.moveTabsToSpace = async (tabIds, spaceId) => {
  const spaces = await ZF.loadSpaces();
  if (!spaces.some(s => s.id === spaceId)) return;
  const folders = await ZF.loadFolders();
  const windows = new Set();
  for (const id of tabIds) {
    const tab = await browser.tabs.get(id).catch(() => null);
    if (!tab || tab.pinned) continue;
    const place = await ZF.getPlace(id);
    const folder = folders.find(f => f.id === place);
    if (place && place !== ZF.ROOT && (!folder || ZF.folderSpace(folders, folder, spaces) !== spaceId)) {
      await ZF.setMeta(id, ZF.FOLDER_KEY, ZF.ROOT);
      await ZF.setMeta(id, ZF.ORDER_KEY, undefined);
    }
    await ZF.setMeta(id, ZF.SPACE_KEY, spaceId);
    windows.add(tab.windowId);
  }
  for (const windowId of windows) await showSpace(windowId);
};

// The folder becomes a top-level folder of the other space, with its
// subfolders and every tab in them (in every window).
ZF.moveFolderToSpace = async (folderId, spaceId) => {
  const spaces = await ZF.loadSpaces();
  if (!spaces.some(s => s.id === spaceId)) return;
  const tabOrders = (await keptTabsEverywhere(ZF.ROOT)).map(t => t.order);
  const moved = await ZF.mutateFolders(folders => {
    const folder = folders.find(f => f.id === folderId);
    if (!folder) return null;
    const siblings = folders.filter(f => !f.parentId && f.id !== folderId).map(f => f.order ?? 0);
    folder.parentId = null;
    folder.spaceId = spaceId;
    folder.order = Math.floor(Math.max(2 * UNPOSITIONED, ...siblings, ...tabOrders)) + 1;
    const ids = new Set([folderId]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const f of folders) {
        if (f.parentId && ids.has(f.parentId) && !ids.has(f.id)) {
          ids.add(f.id);
          grew = true;
        }
      }
    }
    return ids;
  });
  if (!moved) return;
  const windows = new Set();
  const tabs = await browser.tabs.query({ pinned: false });
  const places = await Promise.all(tabs.map(t => ZF.getPlace(t.id)));
  const inFolder = tabs.filter((_, i) => moved.has(places[i]));
  await Promise.all(inFolder.map(t => ZF.setMeta(t.id, ZF.SPACE_KEY, spaceId)));
  for (const tab of inFolder) windows.add(tab.windowId);
  for (const windowId of windows) await showSpace(windowId);
  await ZF.normalizeAllWindows();
};

// A tab of another space became active (e.g. "Switch to Tab" from the
// address bar): show its space, like Zen.
ZF.followTab = async (windowId, tabId) => {
  const tab = await browser.tabs.get(tabId).catch(() => null);
  if (!tab?.active || tab.pinned || tab.windowId !== windowId) return;
  const tag = await getSpaceTag(tabId);
  if (!tag) return;
  const spaces = await ZF.loadSpaces();
  const to = ZF.resolveSpace(spaces, tag);
  if (to !== (await ZF.activeSpaceId(windowId, spaces))) await ZF.local.switchSpace(windowId, to);
};

// A tab moved in from another window joins this window's space; if it was
// in a folder of another space it goes to the top level.
ZF.adoptTab = async (tabId, windowId) => {
  const tab = await browser.tabs.get(tabId).catch(() => null);
  if (!tab || tab.pinned) return;
  const spaces = await ZF.loadSpaces();
  const shown = await ZF.activeSpaceId(windowId, spaces);
  const tag = await getSpaceTag(tabId);
  if (tag && ZF.resolveSpace(spaces, tag) !== shown) await ZF.setMeta(tabId, ZF.SPACE_KEY, undefined);
  const place = await ZF.getPlace(tabId);
  if (place && place !== ZF.ROOT) {
    const folders = await ZF.loadFolders();
    const folder = folders.find(f => f.id === place);
    if (!folder || ZF.folderSpace(folders, folder, spaces) !== shown) {
      await ZF.setMeta(tabId, ZF.FOLDER_KEY, ZF.ROOT);
      await ZF.setMeta(tabId, ZF.ORDER_KEY, undefined);
    }
  }
  await showSpace(windowId);
};

// A new window starts in the space of the window it was opened from.
ZF.initWindow = async (windowId, fromWindowId) => {
  if (await browser.sessions.getWindowValue(windowId, ZF.WINDOW_SPACE_KEY).catch(() => undefined)) return;
  const from = fromWindowId === null ? undefined : await browser.sessions.getWindowValue(fromWindowId, ZF.WINDOW_SPACE_KEY).catch(() => undefined);
  if (from) await browser.sessions.setWindowValue(windowId, ZF.WINDOW_SPACE_KEY, from).catch(() => {});
};

// ---------------------------------------------------------------------------
// One writer. Every change to folders, tab placement or settings runs in the
// background, one at a time, so pages can't overwrite each other's changes;
// afterwards every sidebar is told to refresh. Other pages forward calls.
// ---------------------------------------------------------------------------

ZF.REMOTE_CALLS = [
  "createFolder",
  "updateFolder",
  "setAllCollapsed",
  "removeFolder",
  "moveTabs",
  "moveItems",
  "clearRegular",
  "importZenFolders",
  "restoreFolders",
  "restoreFoldersIfMissing",
  "migrateNativeGroups",
  "updateSettings",
  "resetSettings",
  "createSpace",
  "updateSpace",
  "moveSpace",
  "deleteSpace",
  "switchSpace",
  "switchSpaceBy",
  "moveTabsToSpace",
  "moveFolderToSpace",
];

// Queued like the calls above, but only the background starts them.
ZF.INTERNAL_CALLS = ["followTab", "adoptTab", "initWindow", "showAllSpaces", "showSpaceIn"];

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
  notifyTimer = setTimeout(() => {
    const tabIds = [...ZF.changedTabs];
    ZF.changedTabs.clear();
    browser.runtime.sendMessage({ type: "zf-changed", tabIds }).catch(() => {});
  }, 20);
};

for (const name of [...ZF.REMOTE_CALLS, ...ZF.INTERNAL_CALLS]) {
  ZF.local[name] = ZF[name];
  ZF[name] = (...args) =>
    ZF.IS_BACKGROUND ? ZF.runQueued(name, args) : browser.runtime.sendMessage({ type: "zf-call", name, args });
}
