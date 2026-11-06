"use strict";

// Keep empty folders. Firefox deletes a tab group as soon as its last tab
// leaves, so every group gets one hidden placeholder tab (what Zen does
// internally). Placeholders are marked with a session value so they survive
// restarts, and are closed if they ever end up outside a group.

const PLACEHOLDER = "folderPlaceholder";
const PLACEHOLDER_URL = browser.runtime.getURL("placeholder.html");

function inGroup(tab) {
  return tab.groupId !== undefined && tab.groupId !== -1;
}

async function isPlaceholder(tab) {
  if (tab.url === PLACEHOLDER_URL) return true;
  return Boolean(await browser.sessions.getTabValue(tab.id, PLACEHOLDER).catch(() => false));
}

let ensuring = Promise.resolve();

// Serialised so overlapping events can't add two placeholders to one group.
function ensurePlaceholders() {
  ensuring = ensuring.then(doEnsurePlaceholders, doEnsurePlaceholders);
  return ensuring;
}

async function doEnsurePlaceholders() {
  const tabs = await browser.tabs.query({});
  const covered = new Set();
  for (const tab of tabs) {
    if (!(await isPlaceholder(tab))) continue;
    if (!inGroup(tab) || covered.has(tab.groupId)) {
      await browser.tabs.remove(tab.id).catch(() => {});
      continue;
    }
    covered.add(tab.groupId);
    if (!tab.hidden) await browser.tabs.hide(tab.id).catch(() => {});
  }

  for (const tab of tabs) {
    if (!inGroup(tab) || covered.has(tab.groupId) || (await isPlaceholder(tab))) continue;
    covered.add(tab.groupId);
    const groupTabs = tabs.filter(t => t.groupId === tab.groupId);
    const last = groupTabs.reduce((a, b) => (b.index > a.index ? b : a));
    const placeholder = await browser.tabs.create({
      url: PLACEHOLDER_URL,
      windowId: tab.windowId,
      index: last.index + 1,
      active: false,
    });
    await browser.sessions.setTabValue(placeholder.id, PLACEHOLDER, true);
    await browser.tabs.group({ tabIds: [placeholder.id], groupId: tab.groupId });
    await browser.tabs.hide(placeholder.id);
  }
}

browser.tabs.onUpdated.addListener(
  (_id, change) => {
    if ("groupId" in change) ensurePlaceholders();
  },
  { properties: ["groupId"] }
);
browser.tabs.onCreated.addListener(() => ensurePlaceholders());
browser.runtime.onStartup.addListener(() => ensurePlaceholders());
browser.runtime.onInstalled.addListener(() => ensurePlaceholders());

// A placeholder should never be shown; if Firefox selects one (e.g. it was the
// only tab left in a window), show the tab before it instead.
browser.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  const tab = await browser.tabs.get(tabId).catch(() => null);
  if (!tab || !(await isPlaceholder(tab))) return;
  const visible = (await browser.tabs.query({ windowId, hidden: false })).filter(t => t.id !== tabId);
  if (visible.length) {
    const before = visible.filter(t => t.index < tab.index).pop() ?? visible[0];
    await browser.tabs.update(before.id, { active: true });
  }
});

globalThis.isFolderPlaceholder = isPlaceholder;
