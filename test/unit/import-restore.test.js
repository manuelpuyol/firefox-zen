// Getting folders in and back: Zen's export, Firefox tab groups, backups
// (their checks and edge cases), recovery after a storage wipe, old
// placeholders, and positions that run out of room.

import { describe, test, expect, beforeEach } from "vitest";
import { createFirefox, loadBackground, plain } from "../support/firefox.js";

const W = 1;
let env, ZF;

function start(options) {
  env = createFirefox(options);
  ZF = loadBackground(env).ZF;
}
beforeEach(() => start());

const folderNamed = async name => (await ZF.loadFolders()).find(f => f.name === name);
const tag = id => env.browser.sessions.getTabValue(id, ZF.SPACE_KEY);

describe("importing from Zen", () => {
  test("recreates the folder tree in the current space and moves matching tabs in", async () => {
    const work = await ZF.createSpace(W, { name: "Work" });
    const docs = await env.open("https://docs.test/a#section");
    const mail = await env.open("https://mail.test/");
    const other = await env.open("https://other.test/");
    const result = await ZF.importZenFolders({
      format: "zen-folder-tools/zen-folders@1",
      // A child listed before its parent, and one whose parent is unknown.
      folders: [
        { id: "z2", name: "Specs", parentId: "z1", collapsed: true },
        { id: "z1", name: "Projects", parentId: null },
        { id: "z3", name: "", parentId: "missing" },
      ],
      tabs: [
        { folderId: "z2", urls: ["https://docs.test/a"] },
        { folderId: "z3", urls: ["https://old.test/", "https://mail.test/"] },
      ],
    });
    expect(result).toEqual({ folders: 3, tabs: 2 });
    const projects = await folderNamed("Projects");
    const specs = await folderNamed("Specs");
    expect([specs.parentId, specs.collapsed]).toEqual([projects.id, true]);
    expect(projects.spaceId).toBe(work.id);
    expect((await folderNamed("Folder")).parentId).toBeNull();
    // Matched without the #fragment, or by the tab's original Zen address.
    expect(await ZF.getPlace(docs)).toBe(specs.id);
    expect(await ZF.getPlace(mail)).toBe((await folderNamed("Folder")).id);
    expect(await tag(docs)).toBe(work.id);
    expect(await ZF.getPlace(other)).toBeNull();
  });

  test("refuses anything that isn't a Zen export", async () => {
    await expect(ZF.importZenFolders({ folders: [] })).rejects.toThrow("Not a Zen folders export");
  });

  test("empty Recovered folders are cleaned up afterwards", async () => {
    const tab = await env.open("https://a.test/");
    await env.browser.sessions.setTabValue(tab, ZF.FOLDER_KEY, "lost");
    await ZF.restoreFoldersIfMissing();
    expect((await ZF.loadFolders()).map(f => f.name)).toEqual(["Recovered folder 1"]);
    await ZF.importZenFolders({ folders: [{ id: "z", name: "Zen" }], tabs: [{ folderId: "z", urls: ["https://a.test/"] }] });
    expect((await ZF.loadFolders()).map(f => f.name)).toEqual(["Zen"]);
  });
});

describe("Firefox tab groups become folders", () => {
  const group = (id, title, tabIds, extra = {}) => {
    env.groups.push({ id, windowId: W, title, collapsed: false, ...extra });
    for (const tabId of tabIds) env.find(tabId).groupId = id;
  };

  test("groups convert in tab order; a leading space makes a subfolder", async () => {
    const work = await ZF.createSpace(W, { name: "Work" });
    const [a, b, c, d] = [await env.open("https://a.test/"), await env.open("https://b.test/"), await env.open("https://c.test/"), await env.open("https://d.test/")];
    group(10, "Research", [a, b], { collapsed: true });
    group(11, " Papers", [c]);
    group(12, "", [d]);
    expect(await ZF.migrateNativeGroups()).toBe(3);
    const research = await folderNamed("Research");
    const papers = await folderNamed("Papers");
    expect([research.collapsed, research.spaceId, papers.parentId]).toEqual([true, work.id, research.id]);
    expect(await folderNamed("Folder")).toBeDefined();
    expect([await ZF.getPlace(a), await ZF.getPlace(b), await ZF.getPlace(c)]).toEqual([research.id, research.id, papers.id]);
    // Ungrouped afterwards.
    expect(env.tabs.every(t => t.groupId === -1)).toBe(true);
  });

  test("only the named groups asked for; private windows and missing support are left alone", async () => {
    const a = await env.open("https://a.test/");
    group(1, "Named", [a]);
    group(2, "  ", []);
    expect(await ZF.migrateNativeGroups([2, 99])).toBe(0);
    expect(await ZF.loadFolders()).toEqual([]);

    const priv = await env.browser.windows.create({ incognito: true });
    env.groups.push({ id: 3, windowId: priv.id, title: "Secret" });
    env.groups.splice(0, 2);
    expect(await ZF.migrateNativeGroups()).toBe(0);

    env.browser.tabGroups.query = async () => {
      throw new Error("tabGroups isn't available");
    };
    expect(await ZF.migrateNativeGroups()).toBe(0);
  });

  test("the background converts a new group once its name has settled", async () => {
    await env.events.runtime.onInstalled.trigger({ reason: "install" });
    await env.settle();
    const a = await env.open("https://a.test/");
    group(5, "Typing…", [a]);
    await env.events.tabGroups.onCreated.trigger({ id: 5, title: "" });
    await env.events.tabGroups.onUpdated.trigger({ id: 5, title: "Typing…" });
    env.groups[0].title = "Reading";
    await env.events.tabGroups.onUpdated.trigger({ id: 5, title: "Reading" });
    await new Promise(r => setTimeout(r, 1100));
    await env.settle();
    expect((await ZF.loadFolders()).map(f => f.name)).toEqual(["Reading"]);

    // Turned off: new groups stay groups; turning it back on converts them.
    await ZF.updateSettings("folders", { convertTabGroups: false });
    const b = await env.open("https://b.test/");
    group(6, "Later", [b]);
    await env.events.tabGroups.onCreated.trigger({ id: 6, title: "Later" });
    await new Promise(r => setTimeout(r, 1100));
    await env.settle();
    expect(await folderNamed("Later")).toBeUndefined();
    await ZF.updateSettings("folders", { convertTabGroups: true });
    await env.settle(90);
    expect(await folderNamed("Later")).toBeDefined();
  });
});

describe("backups", () => {
  const backup = (extra = {}) => ({ format: "zen-folder-tools-backup", version: 2, spaces: [], folders: [], tabs: [], essentials: [], ...extra });
  const f = (id, extra = {}) => ({ id, name: id, parentId: null, ...extra });

  test.each([
    ["unknown format", { format: "other" }],
    ["unknown format", { version: 3 }],
    ["missing lists", { tabs: null }],
    ["too large", { folders: Array.from({ length: 5001 }, (_, i) => f(`f${i}`)) }],
    ["bad space", { spaces: [{ id: "", name: "x" }] }],
    ["duplicate space ids", { spaces: [{ id: "s", name: "a" }, { id: "s", name: "b" }] }],
    ["bad space reference", { folders: [f("a", { spaceId: 5 })] }],
    ["bad folder", { folders: [f("root")] }],
    ["bad folder parent", { folders: [f("a", { parentId: 7 })] }],
    ["duplicate folder ids", { folders: [f("a"), f("a")] }],
    ["folder parent missing", { folders: [f("a", { parentId: "b" })] }],
    ["folder loop", { folders: [f("a", { parentId: "b" }), f("b", { parentId: "a" })] }],
    ["bad tab", { tabs: [{ url: "https://a.test/", place: "nowhere" }] }],
    ["bad tab address", { tabs: [{ url: "https://a.test/", place: "root", originalUrl: 5 }] }],
    ["bad Essential", { essentials: [{ url: 5 }] }],
  ])("a file with %s is refused before anything changes", async (why, extra) => {
    expect(() => ZF.parseBackup(backup(extra))).toThrow(`Not a valid backup: ${why}`);
  });

  test("unknown icons, backgrounds and long names are cleaned up", () => {
    const data = ZF.parseBackup(
      backup({
        spaces: [{ id: "s", name: "  ", icon: "🦄", background: "neon" }],
        folders: [f("a", { name: "x".repeat(600), order: "high", spaceId: "unknown" })],
        tabs: [{ url: "https://a.test/", place: "a", order: 2, title: 5, container: "x".repeat(200) }],
      })
    );
    expect(plain(data.spaces)).toEqual([{ id: "s", name: "Space", icon: "🏠", background: null }]);
    expect([data.folders[0].name.length, data.folders[0].order, data.folders[0].spaceId]).toEqual([500, 0, null]);
    expect([data.tabs[0].title, data.tabs[0].container]).toEqual(["", "firefox-default"]);
  });

  test("export leaves out private windows and very long addresses, and says so", async () => {
    const long = `https://a.test/?q=${"x".repeat(9000)}`;
    const kept = await env.open(long);
    await ZF.moveTabs([kept], ZF.ROOT);
    await env.open(long, { pinned: true });
    await env.open("https://mail.test/", { pinned: true, title: "Mail" });
    const priv = await env.browser.windows.create({ incognito: true, url: "https://secret.test/" });
    await ZF.moveTabs([priv.tabs[0].id], ZF.ROOT);
    const data = await ZF.exportFolders();
    expect([data.tabs.length, data.skippedLongAddresses]).toEqual([0, 2]);
    expect(plain(data.essentials)).toEqual([{ url: "https://mail.test/", title: "Mail", container: "firefox-default" }]);
  });

  test("restore: Essentials, containers, long addresses and pages that aren't websites", async () => {
    const pinned = await env.open("https://mail.test/", { pinned: true });
    const regular = await env.open("https://cal.test/");
    const inContainer = await env.browser.tabs.create({ url: "https://bank.test/", active: false, cookieStoreId: "firefox-container-1" });
    const report = await ZF.restoreFolders(
      backup({
        folders: [f("a", { name: "Docs" })],
        tabs: [
          { url: "https://bank.test/", place: "a", container: "firefox-container-1" },
          { url: "https://shop.test/", place: "a", container: "firefox-container-2" },
          { url: "about:config", place: "a" },
          { url: `https://a.test/?${"x".repeat(9000)}`, place: "a" },
        ],
        essentials: [
          { url: "https://mail.test/" },
          { url: "https://cal.test/" },
          { url: "https://news.test/" },
          { url: "https://work.test/", container: "firefox-container-2" },
          { url: "about:robots" },
        ],
      })
    );
    expect(plain(report)).toMatchObject({ foldersCreated: 1, tabsMoved: 1, tabsOpened: 0, essentialsOpened: 1, skippedInContainers: 2, skippedLongAddresses: 1 });
    expect(await ZF.getPlace(inContainer.id)).toBe((await folderNamed("Docs")).id);
    expect(env.find(regular).pinned).toBe(true);
    expect(env.tabs.filter(t => t.pinned).map(t => t.url).sort()).toEqual(["https://cal.test/", "https://mail.test/", "https://news.test/"]);
    expect(env.find(pinned).pinned).toBe(true);
  });

  test("restore matches a kept tab by its original address, and twice changes nothing", async () => {
    const tab = await env.open("https://docs.test/moved-on");
    await env.browser.sessions.setTabValue(tab, ZF.ORIGINAL_URL_KEY, "https://docs.test/");
    const file = backup({
      spaces: [{ id: "s1", name: "Home" }, { id: "s2", name: "Work", icon: "💼" }],
      folders: [f("a", { name: "Docs", spaceId: "s2" }), f("b", { name: "Sub", parentId: "a" })],
      tabs: [{ url: "https://docs.test/", place: "b", originalUrl: "https://docs.test/", order: 3 }],
    });
    const first = await ZF.restoreFolders(file);
    expect(plain(first)).toMatchObject({ spacesCreated: 1, foldersCreated: 2, tabsMoved: 1 });
    const work = (await ZF.loadSpaces()).find(sp => sp.name === "Work");
    expect([await ZF.getPlace(tab), await tag(tab)]).toEqual([(await folderNamed("Sub")).id, work.id]);
    expect(await env.browser.sessions.getTabValue(tab, ZF.ORDER_KEY)).toBe(3);
    const second = await ZF.restoreFolders(file);
    expect(plain(second)).toMatchObject({ spacesCreated: 0, foldersCreated: 0, foldersMatched: 2 });
    expect(await ZF.loadFolders()).toHaveLength(2);
  });

  test("restore skips Glance popups and private windows when matching", async () => {
    const popup = await env.browser.windows.create({ type: "popup", url: "https://docs.test/" });
    const report = await ZF.restoreFolders(backup({ tabs: [{ url: "https://docs.test/", place: "root" }] }));
    expect([report.tabsMoved, report.tabsOpened]).toEqual([0, 1]);
    expect(await ZF.getPlace(popup.tabs[0].id)).toBeNull();
    const reopened = env.tabs.find(t => t.windowId === W && t.url === "https://docs.test/");
    expect([reopened.discarded, await ZF.getPlace(reopened.id)]).toEqual([true, ZF.ROOT]);
  });
});

describe("recovery after storage is wiped", () => {
  test("folders and spaces come back from the newest window backup", async () => {
    start({ windows: [1, 2] });
    const work = await ZF.createSpace(1, { name: "Work" });
    const folder = await ZF.createFolder("Saved", null, work.id);
    await env.fakeBrowser.storage.local.clear();
    expect(await ZF.loadFolders()).toEqual([]);
    const report = await ZF.restoreFoldersIfMissing();
    expect(plain(report)).toEqual({ restoredFromBackup: 1, recoveredFolders: 0, restoredSpaces: 2 });
    expect((await ZF.loadFolders())[0].id).toBe(folder.id);
    expect((await ZF.loadSpaces()).map(sp => sp.name)).toEqual(["Home", "Work"]);
  });

  test("tabs pointing at unknown folders get numbered Recovered folders in their space", async () => {
    await ZF.createSpace(W, { name: "Work" });
    await ZF.restoreFoldersIfMissing();
    const tabs = [await env.open("https://a.test/"), await env.open("https://b.test/"), await env.open("https://c.test/")];
    await env.browser.sessions.setTabValue(tabs[0], ZF.FOLDER_KEY, "x");
    await env.browser.sessions.setTabValue(tabs[1], ZF.FOLDER_KEY, "x");
    await env.browser.sessions.setTabValue(tabs[2], ZF.FOLDER_KEY, "y");
    await env.browser.sessions.setTabValue(tabs[2], ZF.SPACE_KEY, "home");
    expect((await ZF.restoreFoldersIfMissing()).recoveredFolders).toBe(2);
    const folders = await ZF.loadFolders();
    expect(folders.map(f => [f.id, f.name])).toEqual([["x", "Recovered folder 1"], ["y", "Recovered folder 2"]]);
    expect(folders[1].spaceId).toBe("home");
  });
});

test("0.2.0's placeholder tabs are closed once", async () => {
  const marked = await env.open("moz-extension://test/placeholder.html");
  await env.browser.sessions.setTabValue(marked, "folderPlaceholder", true);
  const looksLike = await env.open("moz-extension://test/p.html", { title: "Folder placeholder" });
  const normal = await env.open("https://a.test/", { title: "Folder placeholder" });
  await ZF.closeOldPlaceholders();
  expect([env.find(marked), env.find(looksLike), env.find(normal)?.id]).toEqual([undefined, undefined, normal]);
  const later = await env.open("moz-extension://test/p.html", { title: "Folder placeholder" });
  await ZF.closeOldPlaceholders();
  expect(env.find(later)).toBeDefined();
});

test("after many moves between the same tabs, the folder is renumbered, across windows", async () => {
  start({ windows: [1, 2] });
  const folder = await ZF.createFolder("F", null, "home");
  const [a, b, c] = [await env.open("https://a.test/"), await env.open("https://b.test/"), await env.open("https://c.test/")];
  const elsewhere = (await env.browser.tabs.create({ windowId: 2, url: "https://d.test/" })).id;
  await ZF.moveTabs([a, b, c], folder.id);
  await ZF.moveItems(2, [{ kind: "tab", id: elsewhere }], folder.id);
  // Last in the folder (window 2's own move gave it A's position).
  await env.browser.sessions.setTabValue(elsewhere, ZF.ORDER_KEY, 5);
  const order = id => env.browser.sessions.getTabValue(id, ZF.ORDER_KEY);
  // Each move halves the gap after A, until there's no room left and the
  // folder is renumbered with whole numbers.
  let [x, y] = [b, c];
  let moves = 0;
  let orders;
  do {
    await ZF.moveItems(W, [{ kind: "tab", id: y }], folder.id, { anchor: { kind: "tab", id: a }, after: true });
    [x, y] = [y, x];
    moves++;
    orders = await Promise.all([a, x, y, elsewhere].map(order));
  } while (!orders.every(Number.isInteger) && moves < 100);
  expect(moves).toBeGreaterThan(40);
  expect(moves).toBeLessThan(100);
  // Same order as before (the moved tab right after A), the other window's tab included.
  expect(orders).toEqual([0, 1, 2, 3]);
  const view = await ZF.buildView(W);
  expect(plain(view.byPlace.get(folder.id).map(t => t.id))).toEqual([a, x, y]);
});
