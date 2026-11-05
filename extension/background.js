"use strict";

const ORIGINAL_URL = "originalUrl";
const NO_GROUP = -1;

// ---------------------------------------------------------------------------
// Folder tabs: remember the URL a tab had when it entered a tab group, and
// reset to it on demand (Zen pinned-tab "reset" behaviour).
// ---------------------------------------------------------------------------

function isRealUrl(url) {
  return url && !url.startsWith("about:");
}

async function syncOriginalUrl(tab) {
  if (tab.groupId === undefined || tab.groupId === NO_GROUP) {
    await browser.sessions.removeTabValue(tab.id, ORIGINAL_URL);
    return;
  }
  if (!isRealUrl(tab.url)) return;
  const stored = await browser.sessions.getTabValue(tab.id, ORIGINAL_URL);
  if (!stored) await browser.sessions.setTabValue(tab.id, ORIGINAL_URL, tab.url);
}

async function resetTab(tab) {
  const original = await browser.sessions.getTabValue(tab.id, ORIGINAL_URL);
  if (original && original !== tab.url) await browser.tabs.update(tab.id, { url: original });
}

async function markCurrentAsOriginal(tab) {
  if (tab.groupId !== NO_GROUP && isRealUrl(tab.url)) {
    await browser.sessions.setTabValue(tab.id, ORIGINAL_URL, tab.url);
  }
}

browser.tabs.onUpdated.addListener(
  (_id, change, tab) => {
    if ("groupId" in change || change.status === "complete") syncOriginalUrl(tab);
  },
  { properties: ["groupId", "status"] }
);

browser.menus.create({ id: "reset-tab", title: "Reset to Original URL", contexts: ["tab"] }, () => void browser.runtime.lastError);
browser.menus.create({ id: "set-original", title: "Use Current Page as Original URL", contexts: ["tab"] }, () => void browser.runtime.lastError);

browser.menus.onShown.addListener(async (info, tab) => {
  if (!info.contexts.includes("tab") || !tab) return;
  const grouped = tab.groupId !== undefined && tab.groupId !== NO_GROUP;
  const original = grouped ? await browser.sessions.getTabValue(tab.id, ORIGINAL_URL) : null;
  browser.menus.update("reset-tab", { visible: grouped, enabled: Boolean(original && original !== tab.url) });
  browser.menus.update("set-original", { visible: grouped && isRealUrl(tab.url) && original !== tab.url });
  browser.menus.refresh();
});

browser.menus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "reset-tab") resetTab(tab);
  if (info.menuItemId === "set-original") markCurrentAsOriginal(tab);
});

browser.runtime.onInstalled.addListener(async () => {
  for (const tab of await browser.tabs.query({})) await syncOriginalUrl(tab);
});

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
  const width = Math.round(parent.width * 0.8);
  const height = Math.round(parent.height * 0.85);
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

browser.runtime.onMessage.addListener(async (message, sender) => {
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
  if (command === "reset-tab" && tab) await resetTab(tab);
  if (command === "glance-expand") {
    const focused = await browser.windows.getLastFocused();
    await expandGlance(focused.id);
  }
});
