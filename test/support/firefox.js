// A Firefox-shaped stand-in for the WebExtension APIs Zen Folder Tools uses.
//
// storage and alarms come from @webext-core/fake-browser (the in-memory fake
// WXT uses). Everything this extension depends on that it lacks or models
// after Chrome is implemented here the way Firefox behaves:
//   tabs     per-window active tab, index order with pinned tabs first,
//            hide/show, discard, move, highlight, sharingState
//   windows  several windows, each page knowing its own
//   sessions per-tab and per-window values
//   menus, permissions, scripting, commands, tabGroups, sidebarAction
//   runtime  messages go to the other pages (never back to the sender), with
//            a sender URL, as in Firefox
// Events fire asynchronously, like Firefox's; await env.settle() to let them
// and the work they start finish.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import { fakeBrowser } from "@webext-core/fake-browser";
import { Window } from "happy-dom";

export const EXTENSION = path.resolve(import.meta.dirname, "..", "..", "extension");
export const ORIGIN = "moz-extension://test/";
// file:// names let coverage map scripts run in vm contexts back to their files.
const sourceUrl = file => pathToFileURL(path.join(EXTENSION, file)).href;
const read = file => fs.readFileSync(path.join(EXTENSION, file), "utf8");
export const MANIFEST = JSON.parse(read("manifest.json"));
const EXTENSION_ID = MANIFEST.browser_specific_settings.gecko.id;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function createFirefox({ windows: windowIds = [1] } = {}) {
  fakeBrowser.reset();

  let pending = 0;
  const errors = [];
  const track = promise => {
    pending++;
    return Promise.resolve(promise)
      .catch(error => errors.push(error))
      .finally(() => pending--);
  };

  // Listeners run after the call that caused the event returns.
  const makeEvent = ({ filter } = {}) => {
    const listeners = [];
    const matching = args => listeners.filter(l => !filter || filter(l.extra, args));
    return {
      addListener(fn, extra) {
        listeners.push({ fn, extra });
      },
      removeListener(fn) {
        const i = listeners.findIndex(l => l.fn === fn);
        if (i !== -1) listeners.splice(i, 1);
      },
      hasListener: fn => listeners.some(l => l.fn === fn),
      // For tests: fire now and wait for what the listeners return.
      trigger: (...args) => Promise.all(matching(args).map(l => l.fn(...args))),
      emit(...args) {
        track(sleep(0).then(() => Promise.all(matching(args).map(l => track(l.fn(...args))))));
      },
    };
  };
  // tabs.onUpdated listeners with a filter only hear about those properties
  // (and that window).
  const updatedFilter = (extra, [, change, tab]) =>
    (!extra?.properties || extra.properties.some(p => p in change)) && (extra?.windowId === undefined || extra.windowId === tab.windowId);

  let nextTabId = 1;
  let nextWindowId = Math.max(0, ...windowIds) + 1;
  let clock = 1;
  const windows = windowIds.map(id => ({ id, type: "normal", incognito: false }));
  const tabs = [];
  const tabValues = new Map();
  const windowValues = new Map();
  const calls = { hide: [], show: [], discard: [], tabMessages: [], executeScript: [], clipboard: [], overrideContext: [], sidebarClosed: 0, optionsOpened: 0 };
  const faults = { hide: null };
  const menus = new Map();
  const granted = new Set();
  const scripts = new Map();
  // Firefox tab groups: { id, windowId, title, collapsed }; tabs carry groupId.
  const groups = [];

  const find = id => tabs.find(t => t.id === id);
  const copy = tab => structuredClone(tab);
  const values = (map, id) => map.get(id) ?? map.set(id, new Map()).get(id);
  const ids = value => [].concat(value);
  const reindex = windowId => {
    const inWindow = tabs.filter(t => t.windowId === windowId).sort((a, b) => a.index - b.index);
    [...inWindow.filter(t => t.pinned), ...inWindow.filter(t => !t.pinned)].forEach((t, i) => (t.index = i));
  };

  const ev = {
    tabs: {
      onCreated: makeEvent(),
      onUpdated: makeEvent({ filter: updatedFilter }),
      onActivated: makeEvent(),
      onHighlighted: makeEvent(),
      onRemoved: makeEvent(),
      onMoved: makeEvent(),
      onAttached: makeEvent(),
      onDetached: makeEvent(),
      onReplaced: makeEvent(),
    },
    windows: { onCreated: makeEvent(), onRemoved: makeEvent(), onFocusChanged: makeEvent() },
    menus: { onShown: makeEvent(), onClicked: makeEvent() },
    permissions: { onAdded: makeEvent(), onRemoved: makeEvent() },
    commands: { onCommand: makeEvent(), onChanged: makeEvent() },
    tabGroups: { onCreated: makeEvent(), onUpdated: makeEvent() },
    runtime: { onInstalled: makeEvent(), onStartup: makeEvent() },
  };
  const updated = (tab, change) => ev.tabs.onUpdated.emit(tab.id, change, copy(tab));

  // Selecting a tab makes it the whole selection (Firefox's active tab is
  // always highlighted), unless tabs.highlight is choosing several.
  const activate = (tab, { keepSelection = false } = {}) => {
    if (!keepSelection) for (const t of tabs) if (t.windowId === tab.windowId) t.highlighted = t === tab;
    const previous = tabs.find(t => t.windowId === tab.windowId && t.active);
    if (previous === tab) return;
    if (previous) previous.active = false;
    tab.active = true;
    tab.lastAccessed = clock++;
    if (tab.hidden) {
      // Firefox shows a hidden tab that gets selected.
      tab.hidden = false;
      updated(tab, { hidden: false });
    }
    ev.tabs.onActivated.emit({ tabId: tab.id, previousTabId: previous?.id, windowId: tab.windowId });
  };

  const tabsApi = {
    async query(filter = {}) {
      return (
        tabs
          // URL patterns aren't matched: every tab counts as a web page.
          .filter(t => Object.entries(filter).every(([k, v]) => k === "url" || t[k] === v))
          .sort((a, b) => a.windowId - b.windowId || a.index - b.index)
          .map(copy)
      );
    },
    async get(id) {
      const tab = find(id);
      if (!tab) throw new Error(`Invalid tab ID: ${id}`);
      return copy(tab);
    },
    async create({ windowId = windows[0].id, url = "about:newtab", active = true, pinned = false, discarded = false, title, cookieStoreId = "firefox-default" } = {}) {
      const tab = {
        id: nextTabId++,
        windowId,
        index: 1e6,
        url,
        title: title ?? url,
        pinned,
        active: false,
        hidden: false,
        discarded,
        highlighted: false,
        incognito: windows.find(w => w.id === windowId)?.incognito ?? false,
        status: "complete",
        lastAccessed: clock++,
        cookieStoreId,
        groupId: -1,
      };
      tabs.push(tab);
      reindex(windowId);
      ev.tabs.onCreated.emit(copy(tab));
      if (active || !tabs.some(t => t.windowId === windowId && t.active)) activate(tab);
      return copy(tab);
    },
    async update(id, props) {
      const tab = find(id);
      if (!tab) throw new Error(`Invalid tab ID: ${id}`);
      const change = {};
      if ("pinned" in props && props.pinned !== tab.pinned) {
        tab.pinned = change.pinned = props.pinned;
        if (tab.pinned) tab.hidden = false;
        reindex(tab.windowId);
      }
      if ("url" in props) tab.url = change.url = props.url;
      if ("autoDiscardable" in props) tab.autoDiscardable = change.autoDiscardable = props.autoDiscardable;
      if ("muted" in props) tab.mutedInfo = change.mutedInfo = { muted: props.muted };
      if (Object.keys(change).length) updated(tab, change);
      if (props.active) activate(tab);
      return copy(tab);
    },
    async remove(value) {
      for (const id of ids(value)) {
        const i = tabs.findIndex(t => t.id === id);
        if (i === -1) continue;
        const [tab] = tabs.splice(i, 1);
        reindex(tab.windowId);
        ev.tabs.onRemoved.emit(id, { windowId: tab.windowId, isWindowClosing: false });
        if (tab.active) {
          const next = tabs.filter(t => t.windowId === tab.windowId && !t.hidden).sort((a, b) => a.index - b.index)[0];
          if (next) activate(next);
        }
      }
    },
    async move(value, { windowId, index }) {
      const moving = ids(value).map(find);
      const attached = moving.filter(t => t.windowId !== windowId);
      const others = tabs.filter(t => t.windowId === windowId && !moving.includes(t)).sort((a, b) => a.index - b.index);
      others.splice(index === -1 ? others.length : index, 0, ...moving);
      others.forEach((t, i) => {
        t.windowId = windowId;
        t.index = i;
      });
      for (const tab of attached) ev.tabs.onAttached.emit(tab.id, { newWindowId: windowId, newPosition: tab.index });
      for (const tab of moving) ev.tabs.onMoved.emit(tab.id, { windowId, toIndex: tab.index });
      return moving.map(copy);
    },
    // Fails as a whole on an unknown tab; quietly skips tabs Firefox can't
    // hide (active, pinned, sharing).
    async hide(value) {
      calls.hide.push(ids(value));
      if (faults.hide?.(ids(value))) throw new Error("Couldn't hide tabs");
      for (const id of ids(value)) if (!find(id)) throw new Error(`Invalid tab ID: ${id}`);
      const done = [];
      for (const id of ids(value)) {
        const tab = find(id);
        const sharing = tab.sharingState?.camera || tab.sharingState?.microphone || tab.sharingState?.screen;
        if (tab.active || tab.pinned || sharing || tab.hidden) continue;
        tab.hidden = true;
        updated(tab, { hidden: true });
        done.push(id);
      }
      return done;
    },
    async show(value) {
      calls.show.push(ids(value));
      for (const id of ids(value)) {
        const tab = find(id);
        if (tab?.hidden) {
          tab.hidden = false;
          updated(tab, { hidden: false });
        }
      }
    },
    async discard(value) {
      for (const id of ids(value)) {
        calls.discard.push(id);
        const tab = find(id);
        if (tab && !tab.discarded) {
          tab.discarded = true;
          updated(tab, { discarded: true });
        }
      }
    },
    async highlight({ windowId, tabs: indexes }) {
      const inWindow = tabs.filter(t => t.windowId === windowId);
      const chosen = ids(indexes).map(i => inWindow.find(t => t.index === i)).filter(Boolean);
      for (const t of inWindow) t.highlighted = chosen.includes(t);
      if (chosen[0]) activate(chosen[0], { keepSelection: true });
      ev.tabs.onHighlighted.emit({ windowId, tabIds: chosen.map(t => t.id) });
    },
    // Recorded, and delivered to that tab's content scripts.
    async sendMessage(tabId, message) {
      calls.tabMessages.push({ tabId, message: structuredClone(message) });
      for (const realm of realms) {
        if (realm.sender?.tab?.id !== tabId) continue;
        for (const fn of realm.messageListeners) fn(structuredClone(message), { id: EXTENSION_ID });
      }
    },
    // A group with no tabs left is gone, as in Firefox.
    async ungroup(value) {
      for (const id of ids(value)) if (find(id)) find(id).groupId = -1;
      for (let i = groups.length - 1; i >= 0; i--) if (!tabs.some(t => t.groupId === groups[i].id)) groups.splice(i, 1);
    },
    ...ev.tabs,
  };

  const windowsApi = {
    WINDOW_ID_NONE: -1,
    async getAll({ windowTypes, populate } = {}) {
      return windows
        .filter(w => !windowTypes || windowTypes.includes(w.type))
        .map(w => ({ ...w, ...(populate ? { tabs: tabs.filter(t => t.windowId === w.id).map(copy) } : {}) }));
    },
    async getLastFocused({ windowTypes } = {}) {
      return { ...windows.find(w => !windowTypes || windowTypes.includes(w.type)) };
    },
    async get(id) {
      const w = windows.find(x => x.id === id);
      if (!w) throw new Error(`Invalid window ID: ${id}`);
      return { width: 1200, height: 800, left: 0, top: 0, ...w };
    },
    async create({ url, type = "normal", incognito = false, width, height, left, top } = {}) {
      const w = { id: nextWindowId++, type, incognito, width, height, left, top };
      windows.push(w);
      ev.windows.onCreated.emit({ ...w });
      const tab = await tabsApi.create({ windowId: w.id, url: url ?? "about:newtab" });
      return { ...w, tabs: [tab] };
    },
    async update(id, props) {
      if (props.focused) ev.windows.onFocusChanged.emit(id);
      return { ...windows.find(x => x.id === id), ...props };
    },
    async remove(id) {
      const i = windows.findIndex(x => x.id === id);
      if (i === -1) return;
      windows.splice(i, 1);
      for (const t of tabs.filter(t => t.windowId === id)) tabs.splice(tabs.indexOf(t), 1);
      ev.windows.onRemoved.emit(id);
    },
    ...ev.windows,
  };

  const sessionsApi = {
    async getTabValue(id, key) {
      return structuredClone(values(tabValues, id).get(key));
    },
    async setTabValue(id, key, value) {
      if (!find(id)) throw new Error(`Invalid tab ID: ${id}`);
      values(tabValues, id).set(key, structuredClone(value));
    },
    async removeTabValue(id, key) {
      values(tabValues, id).delete(key);
    },
    async getWindowValue(id, key) {
      return structuredClone(values(windowValues, id).get(key));
    },
    async setWindowValue(id, key, value) {
      values(windowValues, id).set(key, structuredClone(value));
    },
    async removeWindowValue(id, key) {
      values(windowValues, id).delete(key);
    },
  };

  const menusApi = {
    create(item, done) {
      menus.set(item.id, { visible: true, enabled: true, ...item });
      done?.();
      return item.id;
    },
    async update(id, props) {
      if (menus.has(id)) Object.assign(menus.get(id), props);
    },
    async removeAll() {
      menus.clear();
    },
    async refresh() {},
    overrideContext(context) {
      calls.overrideContext.push(context);
    },
    ...ev.menus,
  };

  const permissionsApi = {
    async contains({ origins = [] } = {}) {
      return origins.every(o => granted.has(o));
    },
    async request({ origins = [] } = {}) {
      origins.forEach(o => granted.add(o));
      ev.permissions.onAdded.emit({ origins });
      return true;
    },
    async remove({ origins = [] } = {}) {
      origins.forEach(o => granted.delete(o));
      ev.permissions.onRemoved.emit({ origins });
      return true;
    },
    ...ev.permissions,
  };

  const scriptingApi = {
    async getRegisteredContentScripts({ ids: wanted } = {}) {
      return [...scripts.values()].filter(s => !wanted || wanted.includes(s.id));
    },
    async registerContentScripts(list) {
      for (const s of list) scripts.set(s.id, s);
    },
    async unregisterContentScripts({ ids: gone } = {}) {
      for (const id of gone ?? [...scripts.keys()]) scripts.delete(id);
    },
    async executeScript(details) {
      calls.executeScript.push(details);
      return [];
    },
  };

  const commands = Object.entries(MANIFEST.commands).map(([name, c]) => ({
    name,
    description: c.description,
    shortcut: c.suggested_key?.mac ?? c.suggested_key?.default ?? "",
  }));
  const commandsApi = {
    async getAll() {
      return structuredClone(commands);
    },
    ...ev.commands,
  };

  const tabGroupsApi = {
    async query() {
      return structuredClone(groups);
    },
    async get(id) {
      const group = groups.find(g => g.id === id);
      if (!group) throw new Error("No such group");
      return structuredClone(group);
    },
    ...ev.tabGroups,
  };

  // Each page gets its own `browser`: shared state, but its own window and
  // sender identity for messages.
  const realms = [];
  const browserFor = realm => ({
    storage: fakeBrowser.storage,
    alarms: fakeBrowser.alarms,
    tabs: tabsApi,
    windows: { ...windowsApi, getCurrent: async () => ({ ...windows.find(w => w.id === realm.windowId) }) },
    sessions: sessionsApi,
    menus: menusApi,
    permissions: permissionsApi,
    scripting: scriptingApi,
    commands: commandsApi,
    tabGroups: tabGroupsApi,
    sidebarAction: {
      async close() {
        calls.sidebarClosed++;
      },
      async open() {},
    },
    runtime: {
      id: EXTENSION_ID,
      lastError: null,
      getURL: p => ORIGIN + p.replace(/^\//, ""),
      getManifest: () => structuredClone(MANIFEST),
      async openOptionsPage() {
        calls.optionsOpened++;
      },
      // Delivered to every other page's listeners; the first answer wins.
      async sendMessage(message) {
        const sender = { id: EXTENSION_ID, url: realm.url, ...realm.sender };
        let answer;
        for (const other of realms) {
          if (other === realm) continue;
          for (const fn of other.messageListeners) {
            const result = fn(structuredClone(message), sender);
            if (result !== undefined && answer === undefined) answer = result;
          }
        }
        // A rejection reaches the caller after the delay; don't report it as unhandled meanwhile.
        Promise.resolve(answer).catch(() => {});
        await sleep(0);
        return answer;
      },
      onMessage: {
        addListener: fn => realm.messageListeners.push(fn),
        removeListener: fn => realm.messageListeners.splice(realm.messageListeners.indexOf(fn), 1),
        hasListener: fn => realm.messageListeners.includes(fn),
      },
      ...ev.runtime,
    },
  });

  const env = {
    tabs,
    windows,
    calls,
    faults,
    menus,
    granted,
    scripts,
    errors,
    events: ev,
    find,
    fakeBrowser,
    groups,
    // sender: extra sender fields, e.g. a content script's { tab, frameId }.
    newRealm(url, windowId, sender = {}) {
      const realm = { url, windowId, sender, messageListeners: [] };
      realms.push(realm);
      realm.browser = browserFor(realm);
      return realm;
    },
    // Wait until queued events and the work they start are done.
    async settle(ms = 30) {
      for (let quiet = 0; quiet < 3; ) {
        await sleep(ms / 3);
        quiet = pending === 0 ? quiet + 1 : 0;
      }
    },
    // Changes a tab the way a page would (title, favicon, sound, sharing…)
    // and tells listeners.
    change(id, props) {
      const tab = find(id);
      Object.assign(tab, props);
      updated(tab, props);
    },
    // Opens a tab in the background, as a link would.
    async open(url, extra = {}) {
      return (await tabsApi.create({ windowId: windows[0].id, url, active: false, ...extra })).id;
    },
  };
  // The test's own `browser` (window 1, its own sender identity).
  env.browser = env.newRealm(`${ORIGIN}test.html`, windows[0].id).browser;
  return env;
}

function baseGlobals(env) {
  return {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    structuredClone,
    URL,
    navigator: { clipboard: { writeText: async text => env.calls.clipboard.push(text) } },
  };
}

// The model alone, as the background runs it (changes run directly).
export function loadModel(env, { windowId = env.windows[0].id } = {}) {
  const realm = env.newRealm(`${ORIGIN}model.html`, windowId);
  const context = vm.createContext({ ...baseGlobals(env), browser: realm.browser });
  for (const file of ["lib/settings.js", "lib/model.js"]) vm.runInContext(read(file), context, { filename: sourceUrl(file) });
  context.ZF.IS_BACKGROUND = true;
  return context;
}

// The background page: its scripts in manifest order, listeners registered.
export function loadBackground(env) {
  const realm = env.newRealm(`${ORIGIN}_generated_background_page.html`, env.windows[0].id);
  const context = vm.createContext({ ...baseGlobals(env), browser: realm.browser });
  for (const file of MANIFEST.background.scripts) vm.runInContext(read(file), context, { filename: sourceUrl(file) });
  return context;
}

// An extension page (sidebar or options) in happy-dom: its HTML, then its
// scripts in order, in a window bound to `windowId`.
export async function loadPage(env, page, { windowId = env.windows[0].id } = {}) {
  const url = `${ORIGIN}${page}`;
  const realm = env.newRealm(url, windowId);
  const window = new Window({
    url,
    width: 300,
    height: 900,
    settings: { disableJavaScriptFileLoading: true, disableCSSFileLoading: true, disableIframePageLoading: true },
  });
  const html = read(page);
  const files = [...html.matchAll(/<script src="([^"]+)"/g)].map(m => path.posix.normalize(path.posix.join(path.posix.dirname(page), m[1])));
  window.document.write(html.replace(/<script[^>]*><\/script>/g, ""));
  Object.assign(window, { browser: realm.browser, structuredClone });
  // happy-dom has no layout: every element is 100×100 at the origin, except
  // rows inside a collapsed folder (the sidebar's CSS keeps its active row).
  window.Element.prototype.getBoundingClientRect = function () {
    const height = this.closest(".children.collapsed") && !this.classList.contains("active") ? 0 : 100;
    return { x: 0, y: 0, top: 0, left: 0, width: 100, height, right: 100, bottom: height };
  };
  // happy-dom has no Option constructor.
  window.Option ??= function Option(text = "", value, defaultSelected = false, selected = false) {
    const option = window.document.createElement("option");
    Object.assign(option, { text, defaultSelected, selected });
    if (value !== undefined) option.value = value;
    return option;
  };
  for (const file of files) vm.runInContext(read(file), window, { filename: sourceUrl(file) });
  await env.settle(60);
  return window;
}

// A content script in a web page (happy-dom) of `tab`, with the page's HTML.
export async function loadContentScript(env, tab, { file = "glance-content.js", html = "" } = {}) {
  const realm = env.newRealm(tab.url, tab.windowId, { tab: structuredClone(tab), frameId: 0 });
  const window = new Window({ url: tab.url, settings: { disableJavaScriptFileLoading: true, disableCSSFileLoading: true, disableIframePageLoading: true } });
  window.document.write(html);
  window.browser = realm.browser;
  const run = () => vm.runInContext(read(file), window, { filename: sourceUrl(file) });
  run();
  await env.settle();
  return { window, document: window.document, realm, run };
}

export function plain(value) {
  return JSON.parse(JSON.stringify(value));
}
