"use strict";

// A small in-memory stand-in for the parts of Firefox's WebExtension API that
// lib/model.js uses, so the model can be tested with Node's test runner.

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const EXTENSION = path.join(__dirname, "..", "extension");

function createBrowser({ windows = [1] } = {}) {
  let nextId = 1;
  let clock = 1;
  const tabs = [];
  const tabValues = new Map();
  const windowValues = new Map();
  const local = {};
  const session = {};
  const calls = { hide: [], show: [] };
  // Tests set faults.hide to a function; when it returns true, tabs.hide fails.
  const faults = { hide: null };

  const copy = tab => structuredClone(tab);
  const find = id => tabs.find(t => t.id === id);
  const reindex = windowId => {
    const inWindow = tabs.filter(t => t.windowId === windowId).sort((a, b) => a.index - b.index);
    // Pinned tabs always come first, as in Firefox.
    [...inWindow.filter(t => t.pinned), ...inWindow.filter(t => !t.pinned)].forEach((t, i) => (t.index = i));
  };
  const activate = tab => {
    for (const t of tabs) if (t.windowId === tab.windowId) t.active = false;
    tab.active = true;
    tab.hidden = false;
    tab.lastAccessed = clock++;
  };
  const values = (map, id) => map.get(id) ?? map.set(id, new Map()).get(id);
  const pick = (store, keys) => {
    if (keys == null) return structuredClone(store);
    const list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
    const out = {};
    for (const k of list) if (k in store) out[k] = structuredClone(store[k]);
    return out;
  };
  const storageArea = store => ({
    async get(keys) {
      return pick(store, keys);
    },
    async set(items) {
      Object.assign(store, structuredClone(items));
    },
    async remove(keys) {
      for (const k of [].concat(keys)) delete store[k];
    },
  });
  const ids = value => [].concat(value);
  const listener = () => ({ addListener() {}, removeListener() {} });

  const browser = {
    runtime: { id: "test@example", getURL: p => `moz-extension://test/${p}`, sendMessage: async () => {}, onMessage: listener() },
    storage: { local: storageArea(local), session: storageArea(session), onChanged: listener() },
    windows: {
      async getAll() {
        return windows.map(id => ({ id, type: "normal", incognito: false }));
      },
      async getLastFocused() {
        return { id: windows[0], type: "normal", incognito: false };
      },
    },
    tabs: {
      async query(filter = {}) {
        return tabs
          .filter(t => Object.entries(filter).every(([k, v]) => t[k] === v))
          .sort((a, b) => a.windowId - b.windowId || a.index - b.index)
          .map(copy);
      },
      async get(id) {
        const tab = find(id);
        if (!tab) throw new Error(`Invalid tab ID: ${id}`);
        return copy(tab);
      },
      async create({ windowId = windows[0], url = "about:newtab", active = true, pinned = false, discarded = false, title = "" } = {}) {
        const tab = {
          id: nextId++,
          windowId,
          index: 1e6,
          url,
          title: title || url,
          pinned,
          active: false,
          hidden: false,
          discarded,
          highlighted: false,
          lastAccessed: clock++,
          cookieStoreId: "firefox-default",
        };
        tabs.push(tab);
        if (active) activate(tab);
        reindex(windowId);
        return copy(tab);
      },
      async update(id, props) {
        const tab = find(id);
        if (!tab) throw new Error(`Invalid tab ID: ${id}`);
        if (props.active) activate(tab);
        if ("pinned" in props) {
          tab.pinned = props.pinned;
          if (tab.pinned) tab.hidden = false;
          reindex(tab.windowId);
        }
        if ("url" in props) tab.url = props.url;
        return copy(tab);
      },
      async remove(value) {
        for (const id of ids(value)) {
          const i = tabs.findIndex(t => t.id === id);
          if (i === -1) continue;
          const [tab] = tabs.splice(i, 1);
          if (tab.active) {
            const next = tabs.filter(t => t.windowId === tab.windowId && !t.hidden).sort((a, b) => a.index - b.index)[0];
            if (next) activate(next);
          }
          reindex(tab.windowId);
        }
      },
      async move(value, { windowId, index }) {
        const moving = ids(value).map(find);
        const others = tabs.filter(t => t.windowId === windowId && !moving.includes(t)).sort((a, b) => a.index - b.index);
        others.splice(index === -1 ? others.length : index, 0, ...moving);
        others.forEach((t, i) => {
          t.windowId = windowId;
          t.index = i;
        });
        return moving.map(copy);
      },
      // Like Firefox: fails as a whole on an unknown tab, and quietly skips
      // tabs that can't be hidden (active, pinned, sharing).
      async hide(value) {
        calls.hide.push(ids(value));
        if (faults.hide?.(ids(value))) throw new Error("Couldn't hide tabs");
        for (const id of ids(value)) if (!find(id)) throw new Error(`Invalid tab ID: ${id}`);
        const done = [];
        for (const id of ids(value)) {
          const tab = find(id);
          if (tab.active || tab.pinned || tab.sharingState?.camera) continue;
          tab.hidden = true;
          done.push(id);
        }
        return done;
      },
      async show(value) {
        calls.show.push(ids(value));
        for (const id of ids(value)) if (find(id)) find(id).hidden = false;
      },
      async discard(value) {
        for (const id of ids(value)) if (find(id)) find(id).discarded = true;
      },
    },
    sessions: {
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
    },
  };

  return { browser, tabs, local, session, calls, faults, find };
}

// Loads lib/settings.js and lib/model.js against a fresh mock, the way the
// background page runs them (changes run directly, one at a time).
function loadModel(options) {
  const env = createBrowser(options);
  const context = vm.createContext({ browser: env.browser, console, setTimeout, clearTimeout, structuredClone, URL });
  for (const file of ["lib/settings.js", "lib/model.js"]) {
    vm.runInContext(fs.readFileSync(path.join(EXTENSION, file), "utf8"), context, { filename: file });
  }
  const ZF = context.ZF;
  ZF.IS_BACKGROUND = true;
  // Values from the vm context have their own Array/Object prototypes;
  // round-trip through JSON so deepStrictEqual compares plain data.
  const plain = value => JSON.parse(JSON.stringify(value));
  return { ZF, plain, ...env };
}

module.exports = { loadModel };
