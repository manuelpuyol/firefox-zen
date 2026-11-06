"use strict";

const SIDEBAR_URL = browser.runtime.getURL("sidebar/sidebar.html");

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
}

function createMenus() {
  const items = [
    // Tab menu (Firefox's tab context menu, also shown for tabs in the sidebar)
    { id: "zf-keep", title: "Keep in Sidebar", contexts: ["tab"] },
    { id: "zf-unkeep", title: "Move to Regular Tabs", contexts: ["tab"] },
    { id: "zf-folder-with-tab", title: "Move to New Folder", contexts: ["tab"] },
    { id: "reset-tab", title: "Reset to Original URL", contexts: ["tab"] },
    { id: "set-original", title: "Use Current Page as Original URL", contexts: ["tab"] },
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

browser.menus.onShown.addListener(async (info, tab) => {
  if (!info.contexts.includes("tab") || !tab) return;
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
  if (info.menuItemId === "reset-tab") resetTab(tab);
  if (info.menuItemId === "set-original") markCurrentAsOriginal(tab);
  if (info.menuItemId === "zf-keep") ZF.moveTab(tab.id, ZF.ROOT);
  if (info.menuItemId === "zf-unkeep") ZF.moveTab(tab.id, null);
  if (info.menuItemId === "zf-folder-with-tab") {
    const folder = await ZF.createFolder("New Folder", null);
    await ZF.moveTab(tab.id, folder.id);
    browser.runtime.sendMessage({ type: "zf-rename", folderId: folder.id, windowId: tab.windowId }).catch(() => {});
  }
});

// Firefox's own "Add Tab to New Group" creates a native tab group; turn it
// into a sidebar folder once it has a name.
let migrating = Promise.resolve();
function migrateSoon() {
  migrating = migrating.then(() => ZF.migrateNativeGroups()).catch(() => {});
}

// Wait until the group has a name: Firefox asks for one right after creating
// it, and converting before that would lose it. Unnamed groups are converted
// on the next startup.
for (const event of ["onCreated", "onUpdated"]) {
  browser.tabGroups[event].addListener(group => {
    if (group.title?.trim()) migrateSoon();
  });
}

// ---------------------------------------------------------------------------
// Auto-unload (lib/unload.js)
// ---------------------------------------------------------------------------

browser.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ZF.UNLOAD_ALARM) ZF.unloadStaleTabs();
});

browser.tabs.onUpdated.addListener((_id, _change, tab) => ZF.keepEssentialLoaded(tab).catch(() => {}), {
  properties: ["pinned"],
});

browser.storage.onChanged.addListener(changes => {
  if (changes.settings || changes.autoUnload) ZF.configureAutoUnload();
});

browser.runtime.onMessage.addListener(message => {
  if (message?.type === "zf-unload-now") return ZF.unloadStaleTabs();
});

function setUp() {
  ZF.configureAutoUnload().catch(() => {});
  createMenus();
  ZF.closeOldPlaceholders().catch(() => {});
  // Restore before migrating, so native groups don't race the restore.
  migrating = migrating.then(() => ZF.restoreFoldersIfMissing()).catch(() => {});
  migrateSoon();
}

browser.runtime.onInstalled.addListener(setUp);
browser.runtime.onStartup.addListener(setUp);

// ---------------------------------------------------------------------------
// Glance: Alt+click opens the link in a centred popup window over the current
// one. Clicking back on the main window or pressing Escape closes it;
// Alt+Shift+G turns it into a regular tab next to the one it came from.
// ---------------------------------------------------------------------------

async function getGlances() {
  return (await browser.storage.session.get("glances")).glances ?? {};
}

async function setGlances(glances) {
  await browser.storage.session.set({ glances });
}

async function openGlance(url, sourceTab) {
  const parent = await browser.windows.get(sourceTab.windowId);
  const { size } = (await ZF.getSettings()).glance;
  const width = Math.round((parent.width * size) / 100);
  const height = Math.round((parent.height * Math.min(size + 5, 95)) / 100);
  const glance = await browser.windows.create({
    url,
    type: "popup",
    width,
    height,
    left: parent.left + Math.round((parent.width - width) / 2),
    top: parent.top + Math.round((parent.height - height) / 2),
  });
  const glances = await getGlances();
  glances[glance.id] = { parentWindowId: parent.id, openerTabId: sourceTab.id };
  await setGlances(glances);
}

async function closeGlance(windowId) {
  const glances = await getGlances();
  if (!glances[windowId]) return;
  delete glances[windowId];
  await setGlances(glances);
  await browser.windows.remove(windowId).catch(() => {});
}

async function expandGlance(windowId) {
  const glance = (await getGlances())[windowId];
  if (!glance) return;
  const [tab] = await browser.tabs.query({ windowId, active: true });
  const opener = await browser.tabs.get(glance.openerTabId).catch(() => null);
  await browser.tabs.create({
    url: tab.url,
    windowId: glance.parentWindowId,
    index: opener ? opener.index + 1 : undefined,
    active: true,
  });
  await browser.windows.update(glance.parentWindowId, { focused: true });
  await closeGlance(windowId);
}

// Only Glance messages are answered here; returning nothing for others lets
// other listeners (e.g. "unload now") reply.
async function handleGlanceMessage(message, sender) {
  if (!sender.tab) return;
  if (message.type === "glance-open") {
    const glances = await getGlances();
    // Alt+click inside a Glance navigates that Glance instead of stacking another.
    if (glances[sender.tab.windowId]) {
      await browser.tabs.update(sender.tab.id, { url: message.url });
    } else {
      await openGlance(message.url, sender.tab);
    }
  }
  if (message.type === "glance-escape") await closeGlance(sender.tab.windowId);
}

browser.runtime.onMessage.addListener((message, sender) => {
  if (sender.tab && (message?.type === "glance-open" || message?.type === "glance-escape")) {
    return handleGlanceMessage(message, sender);
  }
});

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
