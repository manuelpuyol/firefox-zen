"use strict";

const SIDEBAR_URL = browser.runtime.getURL("sidebar/sidebar.html");
const EXTENSION_ORIGIN = browser.runtime.getURL("");

// lib/model.js: changes run here, one at a time; pages forward them.
ZF.IS_BACKGROUND = true;

browser.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== "zf-call") return;
  // Only this extension's own pages, never content scripts or other extensions.
  if (sender.id !== browser.runtime.id || !sender.url?.startsWith(EXTENSION_ORIGIN)) return;
  if (!ZF.REMOTE_CALLS.includes(message.name)) return;
  return ZF.runQueued(message.name, Array.isArray(message.args) ? message.args : []);
});

// ---------------------------------------------------------------------------
// Folder tabs: each tab kept in the sidebar's pinned section remembers the
// URL it had when it got there, and can be reset to it (Zen pinned-tab reset).
// ---------------------------------------------------------------------------

async function resetTab(tab) {
  const original = await browser.sessions.getTabValue(tab.id, ZF.ORIGINAL_URL_KEY);
  if (original && original !== tab.url) await browser.tabs.update(tab.id, { url: original });
}

async function markCurrentAsOriginal(tab) {
  if (ZF.isRealUrl(tab.url)) await browser.sessions.setTabValue(tab.id, ZF.ORIGINAL_URL_KEY, tab.url);
  ZF.notifyChanged();
}

function createMenus() {
  const items = [
    // Tab menu (Firefox's tab context menu, also shown for tabs in the sidebar)
    { id: "zf-keep", title: "Keep in Sidebar", contexts: ["tab"] },
    { id: "zf-unkeep", title: "Move to Regular Tabs", contexts: ["tab"] },
    { id: "zf-folder-with-tab", title: "Move to New Folder", contexts: ["tab"] },
    { id: "reset-tab", title: "Reset to Original URL", contexts: ["tab"] },
    { id: "set-original", title: "Use Current Page as Original URL", contexts: ["tab"] },
    { id: "zf-copy-urls", title: "Copy URL", contexts: ["tab"] },
    // Sidebar folder menu
    { id: "zf-new-folder", title: "New Folder", contexts: ["all"], documentUrlPatterns: [SIDEBAR_URL] },
    { id: "zf-new-subfolder", title: "New Subfolder", contexts: ["all"], documentUrlPatterns: [SIDEBAR_URL] },
    { id: "zf-rename-folder", title: "Rename Folder", contexts: ["all"], documentUrlPatterns: [SIDEBAR_URL] },
    { id: "zf-remove-folder", title: "Remove Folder (Keep Tabs)", contexts: ["all"], documentUrlPatterns: [SIDEBAR_URL] },
  ];
  browser.menus.removeAll().then(() => {
    for (const item of items) browser.menus.create(item, () => void browser.runtime.lastError);
  });
}

// The URLs "Copy URL" will copy, worked out when the menu opens: the copy
// itself has to happen straight away in the click handler.
let urlsToCopy = [];

browser.menus.onShown.addListener(async (info, tab) => {
  if (!info.contexts.includes("tab") || !tab) return;
  // The clicked tab, or every selected tab when it's part of the selection.
  const selected = tab.highlighted ? await browser.tabs.query({ windowId: tab.windowId, highlighted: true }) : [tab];
  urlsToCopy = selected.sort((a, b) => a.index - b.index).map(t => t.url);
  browser.menus.update("zf-copy-urls", { title: urlsToCopy.length > 1 ? `Copy ${urlsToCopy.length} URLs` : "Copy URL" });
  const kept = !tab.pinned && Boolean(await ZF.getPlace(tab.id));
  const original = kept ? await browser.sessions.getTabValue(tab.id, ZF.ORIGINAL_URL_KEY) : null;
  browser.menus.update("zf-keep", { visible: !tab.pinned && !kept });
  browser.menus.update("zf-unkeep", { visible: kept });
  browser.menus.update("zf-folder-with-tab", { visible: !tab.pinned });
  browser.menus.update("reset-tab", { visible: kept, enabled: Boolean(original && original !== tab.url) });
  browser.menus.update("set-original", { visible: kept && ZF.isRealUrl(tab.url) && original !== tab.url });
  for (const id of ["zf-new-folder", "zf-new-subfolder", "zf-rename-folder", "zf-remove-folder"]) {
    browser.menus.update(id, { visible: false });
  }
  browser.menus.refresh();
});

browser.menus.onClicked.addListener(async (info, tab) => {
  if (!tab) return;
  if (info.menuItemId === "zf-copy-urls") {
    const urls = urlsToCopy.length ? urlsToCopy : [tab.url];
    navigator.clipboard.writeText(urls.join("\n")).catch(error => console.error("Copy URLs:", error));
    return;
  }
  if (info.menuItemId === "reset-tab") resetTab(tab);
  if (info.menuItemId === "set-original") markCurrentAsOriginal(tab);
  // Act on every selected tab when the clicked tab is part of the selection,
  // but only on the ones the action applies to: Keep takes regular tabs,
  // Unkeep takes kept tabs; Essentials are never touched.
  const selected = tab.highlighted ? await browser.tabs.query({ windowId: tab.windowId, highlighted: true }) : [tab];
  const unpinned = selected.filter(t => !t.pinned);
  const places = await Promise.all(unpinned.map(t => ZF.getPlace(t.id)));
  if (info.menuItemId === "zf-keep") ZF.moveTabs(unpinned.filter((_, i) => !places[i]).map(t => t.id), ZF.ROOT);
  if (info.menuItemId === "zf-unkeep") ZF.moveTabs(unpinned.filter((_, i) => places[i]).map(t => t.id), null);
  if (info.menuItemId === "zf-folder-with-tab") {
    const folder = await ZF.createFolder("New Folder", null);
    // Every selected tab except Essentials, in tab order.
    await ZF.moveTabs(unpinned.sort((a, b) => a.index - b.index).map(t => t.id), folder.id);
    browser.runtime.sendMessage({ type: "zf-rename", folderId: folder.id, windowId: tab.windowId }).catch(() => {});
  }
});

// Firefox's own "Add Tab to New Group" creates a native tab group; turn it
// into a sidebar folder once it has a name.
let migrating = Promise.resolve();
function migrateSoon(groupIds = null) {
  migrating = migrating
    .then(async () => {
      if ((await ZF.getSettings()).folders.convertTabGroups) await ZF.migrateNativeGroups(groupIds);
    })
    .catch(() => {});
}

// Wait until the group has a name: Firefox asks for one right after creating
// it, and converting before that would lose it. Unnamed groups are converted
// on the next startup.
// Firefox may update the name while it's being typed, so convert only once
// it has stayed the same for a second.
const pendingGroups = new Map();
for (const event of ["onCreated", "onUpdated"]) {
  browser.tabGroups[event].addListener(group => {
    clearTimeout(pendingGroups.get(group.id));
    if (!group.title?.trim()) return;
    pendingGroups.set(
      group.id,
      setTimeout(async () => {
        pendingGroups.delete(group.id);
        const now = await browser.tabGroups.get(group.id).catch(() => null);
        // Only this group; others are still waiting for their own name to settle.
        if (now?.title === group.title) migrateSoon([group.id]);
      }, 1000)
    );
  });
}

// ---------------------------------------------------------------------------
// Auto-unload (lib/unload.js)
// ---------------------------------------------------------------------------

browser.alarms.onAlarm.addListener(async alarm => {
  // Re-check: the alarm may fire just as auto-unload is being turned off.
  if (alarm.name === ZF.UNLOAD_ALARM && (await ZF.getUnloadSettings()).enabled) ZF.unloadStaleTabs();
});

browser.tabs.onUpdated.addListener((_id, _change, tab) => ZF.keepEssentialLoaded(tab).catch(() => {}), {
  properties: ["pinned"],
});

// Hiding or showing a tab changes where unpositioned kept tabs fall back to,
// and a tab that was hidden may have been renumbered by a respace while it
// was away; put Firefox's tab order back in line with the sidebar. Debounced
// per window: extensions can hide or show many at once.
ZF.local.normalizeOrder = ZF.normalizeOrder;
const visibilityChanged = new Map();
browser.tabs.onUpdated.addListener(
  (_id, change, tab) => {
    if (typeof change.hidden !== "boolean") return;
    clearTimeout(visibilityChanged.get(tab.windowId));
    visibilityChanged.set(
      tab.windowId,
      setTimeout(() => {
        visibilityChanged.delete(tab.windowId);
        ZF.runQueued("normalizeOrder", [tab.windowId]).catch(() => {});
      }, 200)
    );
  },
  { properties: ["hidden"] }
);

browser.storage.onChanged.addListener(changes => {
  // Only auto-unload settings matter here; ignore e.g. tile-size changes.
  const before = JSON.stringify(changes.settings?.oldValue?.autoUnload ?? null);
  const after = JSON.stringify(changes.settings?.newValue?.autoUnload ?? null);
  if (changes.settings && before !== after) ZF.configureAutoUnload();
  const glanceBefore = changes.settings?.oldValue?.glance?.enabled !== false;
  const glanceAfter = changes.settings?.newValue?.glance?.enabled !== false;
  if (changes.settings && glanceBefore !== glanceAfter) tellPages({ type: "glance-settings", enabled: glanceAfter });
  // Turning conversion back on converts existing groups.
  if (changes.settings && !changes.settings.oldValue?.folders?.convertTabGroups && changes.settings.newValue?.folders?.convertTabGroups) migrateSoon();
});

// Rare (a setting changed), so messaging every tab is fine; pages don't
// listen to storage changes, which would wake them on every folder change.
async function tellPages(message) {
  for (const tab of await browser.tabs.query({})) browser.tabs.sendMessage(tab.id, message).catch(() => {});
}

browser.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === "zf-unload-now" && sender.id === browser.runtime.id && sender.url?.startsWith(EXTENSION_ORIGIN)) {
    return ZF.unloadStaleTabs();
  }
});

function setUp() {
  ZF.configureAutoUnload().catch(() => {});
  createMenus();
  ZF.closeOldPlaceholders().catch(() => {});
  // Restore before migrating (both run in the background's change queue).
  ZF.restoreFoldersIfMissing().catch(() => {});
  migrateSoon();
}

browser.runtime.onInstalled.addListener(setUp);
browser.runtime.onStartup.addListener(setUp);

// ---------------------------------------------------------------------------
// Glance: Alt+click opens the link in a centred popup window over the current
// one. Clicking back on the main window or pressing Escape closes it;
// Alt+Shift+G turns it into a regular tab next to the one it came from.
// ---------------------------------------------------------------------------

// Kept in memory (focus changes check it often), backed by storage.session
// in case the background page is unloaded.
let glancesCache = null;

async function getGlances() {
  glancesCache ??= (await browser.storage.session.get("glances")).glances ?? {};
  return glancesCache;
}

async function setGlances(glances) {
  glancesCache = glances;
  await browser.storage.session.set({ glances });
}

function isWebUrl(url) {
  try {
    return ["http:", "https:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

async function openGlance(url, sourceTab) {
  const glances = await getGlances();
  // One Glance per window: reuse it rather than stacking more.
  const existing = Object.entries(glances).find(([, g]) => g.parentWindowId === sourceTab.windowId);
  if (existing) {
    const windowId = Number(existing[0]);
    const [tab] = await browser.tabs.query({ windowId, active: true });
    if (tab) {
      await browser.tabs.update(tab.id, { url });
      await browser.windows.update(windowId, { focused: true });
      return;
    }
  }
  const parent = await browser.windows.get(sourceTab.windowId);
  const { size } = (await ZF.getSettings()).glance;
  const width = Math.round((parent.width * size) / 100);
  const height = Math.round((parent.height * Math.min(size + 5, 95)) / 100);
  const glance = await browser.windows.create({
    url,
    type: "popup",
    // A private source opens a private Glance. (Container tabs never get
    // here: opening a window in a container needs the "cookies" permission.)
    incognito: sourceTab.incognito,
    width,
    height,
    left: parent.left + Math.round((parent.width - width) / 2),
    top: parent.top + Math.round((parent.height - height) / 2),
  });
  glances[glance.id] = { parentWindowId: parent.id, openerTabId: sourceTab.id };
  await setGlances(glances);
  // Its page may have asked before the Glance was registered.
  for (const tab of glance.tabs ?? []) browser.tabs.sendMessage(tab.id, { type: "glance-settings", inGlance: true }).catch(() => {});
}

async function closeGlance(windowId) {
  const glances = await getGlances();
  if (!glances[windowId]) return;
  delete glances[windowId];
  await setGlances(glances);
  await browser.windows.remove(windowId).catch(() => {});
}

// Move the Glance's tab into the main window, keeping the page as it is
// (history, scroll, form contents); the popup closes once it's empty.
async function expandGlance(windowId) {
  const glances = await getGlances();
  const glance = glances[windowId];
  if (!glance) return;
  const [tab] = await browser.tabs.query({ windowId, active: true });
  if (!tab) return;
  const opener = await browser.tabs.get(glance.openerTabId).catch(() => null);
  delete glances[windowId];
  await setGlances(glances);
  await browser.tabs.move(tab.id, { windowId: glance.parentWindowId, index: opener ? opener.index + 1 : -1 });
  await browser.tabs.update(tab.id, { active: true });
  await browser.windows.update(glance.parentWindowId, { focused: true });
}

const lastGlanceRequest = new Map();

// Only Glance messages are answered here; returning nothing for others lets
// other listeners reply.
// Glance can't keep a container's cookies without the "cookies" permission
// (which would let it read every site's cookies), so it's off in container
// tabs and Option+click behaves normally there.
function glanceAllowedIn(tab) {
  // Fail closed: only tabs known to use the default or private cookie store.
  return tab.cookieStoreId === "firefox-default" || tab.cookieStoreId === "firefox-private";
}

async function handleGlanceMessage(message, sender) {
  if (message.type === "glance-context") {
    return {
      allowed: glanceAllowedIn(sender.tab),
      enabled: (await ZF.getSettings()).glance.enabled,
      inGlance: Boolean((await getGlances())[sender.tab.windowId]),
    };
  }
  if (message.type === "glance-open") {
    if (!glanceAllowedIn(sender.tab) || !(await ZF.getSettings()).glance.enabled || !isWebUrl(message.url)) return;
    // At most one Glance request per tab every half second.
    const now = Date.now();
    if (now - (lastGlanceRequest.get(sender.tab.id) ?? 0) < 500) return;
    lastGlanceRequest.set(sender.tab.id, now);
    const glances = await getGlances();
    // Alt+click inside a Glance navigates that Glance instead of stacking another.
    if (glances[sender.tab.windowId]) await browser.tabs.update(sender.tab.id, { url: message.url });
    else await openGlance(message.url, sender.tab);
  }
  if (message.type === "glance-escape") await closeGlance(sender.tab.windowId);
}

browser.runtime.onMessage.addListener((message, sender) => {
  // Only from the Glance content script in a page's top frame.
  if (sender.tab && sender.frameId === 0 && ["glance-open", "glance-escape", "glance-context"].includes(message?.type)) {
    return handleGlanceMessage(message, sender);
  }
});

browser.tabs.onRemoved.addListener(tabId => lastGlanceRequest.delete(tabId));

browser.windows.onFocusChanged.addListener(async focusedId => {
  const glances = await getGlances();
  for (const [id, glance] of Object.entries(glances)) {
    if (glance.parentWindowId === focusedId) await closeGlance(Number(id));
  }
});

browser.windows.onRemoved.addListener(async windowId => {
  const glances = await getGlances();
  if (glances[windowId]) {
    delete glances[windowId];
    await setGlances(glances);
  }
});

browser.commands.onCommand.addListener(async (command, tab) => {
  if (command === "reset-tab" && tab && (await ZF.getPlace(tab.id))) await resetTab(tab);
  if (command === "glance-expand") {
    const focused = await browser.windows.getLastFocused();
    await expandGlance(focused.id);
  }
});
