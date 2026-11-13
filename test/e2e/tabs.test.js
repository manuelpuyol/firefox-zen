// Real Firefox: the extension's items in Firefox's tab menu, the tab strip
// following the sidebar, Clear, unloading, and getting folders back from a
// backup or from Firefox's session data.

import { test, expect, beforeAll, afterAll } from "vitest";
import { launch, startServer, waitFor } from "./firefox.js";

let ff, site;

beforeAll(async () => {
  site = await startServer();
  ff = await launch();
  await ff.ext(
    `async ({ browser, windowId }, urls) => {
      for (const url of urls) await browser.tabs.create({ windowId, url, active: false });
    }`,
    ["alpha", "beta"].map(site.url)
  );
  // Loaded as far as Firefox's tab strip is concerned.
  await waitFor(
    () => ff.chrome(`async main => ["/alpha", "/beta"].every(end => main.gBrowser.tabs.some(t => t.linkedBrowser.currentURI.spec.endsWith(end)))`),
    { message: "pages to load" }
  );
});

afterAll(async () => {
  await ff?.quit();
  site?.server.close();
});

// The main window's tabs, in Firefox's order.
const strip = () =>
  ff.chrome(`async main => main.gBrowser.tabs.map(t => {
    // Unloaded (discarded) tabs have no page; Firefox keeps their address aside.
    const unloaded = !t.linkedPanel || t.hasAttribute("pending");
    const lazy = unloaded ? main.SessionStore.getLazyTabValue(t, "url") : null;
    return { url: lazy || t.linkedBrowser.currentURI.spec, pinned: t.pinned, selected: t.selected, unloaded };
  })`);
const urls = async () => (await strip()).map(t => t.url.replace(/^http:\/\/127\.0\.0\.1:\d+\//, ""));
const placeOf = name =>
  ff.ext(
    `async ({ browser, bg }, url) => {
      const tab = (await browser.tabs.query({})).find(t => t.url === url);
      return tab ? await bg.ZF.getPlace(tab.id) : "no tab";
    }`,
    site.url(name)
  );

test("Firefox's tab menu shows the items that apply, and they work", async () => {
  const menu = await ff.tabMenu("/alpha");
  expect(menu).toEqual(expect.arrayContaining(["Keep in Sidebar", "Move to New Folder", "Copy URL"]));
  expect(menu).not.toContain("Move to Regular Tabs");

  await ff.tabMenu("/alpha", "Keep in Sidebar");
  // Kept tabs come first in Firefox's tab strip.
  await waitFor(async () => (await urls())[0] === "alpha", { message: "alpha to move to the front" });
  expect(await placeOf("alpha")).toBe("root");
  const kept = await ff.tabMenu("/alpha");
  expect(kept).toContain("Move to Regular Tabs");
  expect(kept).not.toContain("Keep in Sidebar");

  await ff.tabMenu("/beta", "Move to New Folder");
  const folder = await waitFor(
    () => ff.ext(`async ({ bg }) => { const [f] = await bg.ZF.loadFolders(); return f && JSON.parse(JSON.stringify(f)); }`),
    { message: "the new folder" }
  );
  expect(await placeOf("beta")).toBe(folder.id);
  // The sidebar opens the folder's name for editing.
  await waitFor(() => ff.ext(`async ({ sidebar }) => sidebar.zfTest.renaming()`), { message: "the rename box" });
  await ff.ext(`async ({ sidebar }) => {
    const input = sidebar.document.querySelector(".rename");
    input.value = "Reading";
    input.dispatchEvent(new sidebar.KeyboardEvent("keydown", { key: "Enter" }));
  }`);
  await waitFor(() => ff.ext(`async ({ bg }) => (await bg.ZF.loadFolders())[0].name === "Reading"`), { message: "the folder's name" });
  expect((await urls()).slice(0, 2)).toEqual(["alpha", "beta"]);
});

test("Copy URL puts the tab's address on the clipboard", async () => {
  await ff.tabMenu("/alpha", "Copy URL");
  const copied = await waitFor(
    () => ff.chrome(`async main => {
      const t = Cc["@mozilla.org/widget/transferable;1"].createInstance(Ci.nsITransferable);
      t.init(null);
      t.addDataFlavor("text/plain");
      Services.clipboard.getData(t, Ci.nsIClipboard.kGlobalClipboard);
      const data = {};
      try { t.getTransferData("text/plain", data); } catch { return null; }
      return data.value.QueryInterface(Ci.nsISupportsString).data;
    }`),
    { message: "the clipboard" }
  );
  expect(copied).toBe(site.url("alpha"));
});

test("Clear in the sidebar closes the regular tabs in Firefox", async () => {
  await ff.ext(`async ({ browser, windowId }, url) => { await browser.tabs.create({ windowId, url, active: true }); }`, site.url("gamma"));
  await waitFor(async () => (await urls()).includes("gamma"), { message: "gamma" });
  await ff.ext(`async ({ sidebar }) => {
    sidebar.document.getElementById("clear").click();
    sidebar.document.getElementById("clear").click();
  }`);
  await waitFor(async () => !(await urls()).includes("gamma"), { message: "Clear" });
  const tabs = await strip();
  expect(tabs.map(t => t.url.replace(/^http:\/\/127\.0\.0\.1:\d+\//, ""))).toEqual(["alpha", "beta"]);
  // The last kept tab is selected instead.
  expect(tabs[1].selected).toBe(true);
});

test("auto-unload unloads real tabs, but not Essentials, which Firefox's own unloader is told to skip", async () => {
  await ff.ext(
    `async ({ browser, windowId }, [delta, epsilon]) => {
      await browser.tabs.create({ windowId, url: delta, active: false });
      const pinned = await browser.tabs.create({ windowId, url: epsilon, active: false, pinned: true });
      await new Promise(r => setTimeout(r, 500));
      return pinned.id;
    }`,
    [site.url("delta"), site.url("epsilon")]
  );
  await waitFor(
    () => ff.ext(`async ({ browser }, url) => (await browser.tabs.query({})).find(t => t.url === url)?.autoDiscardable === false`, site.url("epsilon")),
    { message: "the Essential to be kept loaded" }
  );
  const summary = await ff.ext(`async ({ bg }) => JSON.parse(JSON.stringify(await bg.ZF.unloadStaleTabs({ staleMs: 0 })))`);
  expect(summary.skipped.essential).toBe(1);
  const tabs = await strip();
  const byName = name => tabs.find(t => t.url.endsWith(`/${name}`));
  expect(byName("delta").unloaded).toBe(true);
  expect(byName("epsilon").unloaded).toBe(false);
  // The selected tab is never unloaded.
  expect(tabs.find(t => t.selected).unloaded).toBe(false);
});

test("a backup brings back a removed folder and reopens its closed tab, unloaded", async () => {
  const backup = await ff.ext(`async ({ bg }) => JSON.stringify(await bg.ZF.exportFolders())`);
  await ff.ext(
    `async ({ browser, bg }, url) => {
      const tab = (await browser.tabs.query({})).find(t => t.url === url);
      await browser.tabs.remove(tab.id);
      await bg.ZF.removeFolder((await bg.ZF.loadFolders())[0].id);
    }`,
    site.url("beta")
  );
  expect(await urls()).not.toContain("beta");
  const report = await ff.ext(`async ({ bg }, json) => JSON.parse(JSON.stringify(await bg.ZF.restoreFolders(JSON.parse(json))))`, backup);
  expect(report).toMatchObject({ foldersCreated: 1, tabsOpened: 1, tabsMoved: 1 });
  const folder = await ff.ext(`async ({ bg }) => JSON.parse(JSON.stringify((await bg.ZF.loadFolders())[0]))`);
  expect(folder.name).toBe("Reading");
  expect(await placeOf("beta")).toBe(folder.id);
  // Reopened in the last focused window (here, the one driving the test), unloaded.
  const beta = await ff.ext(
    `async ({ browser }, url) => {
      const tab = (await browser.tabs.query({})).find(t => t.url === url);
      return { discarded: tab.discarded, focusedWindow: tab.windowId === (await browser.windows.getLastFocused()).id };
    }`,
    site.url("beta")
  );
  expect(beta).toEqual({ discarded: true, focusedWindow: true });
});

test("if the extension's storage is wiped, folders come back from Firefox's session data", async () => {
  const before = await ff.ext(`async ({ bg }) => JSON.stringify(await bg.ZF.loadFolders())`);
  await ff.ext(`async ({ browser }) => browser.storage.local.clear()`);
  expect(await ff.ext(`async ({ bg }) => (await bg.ZF.loadFolders()).length`)).toBe(0);
  const report = await ff.ext(`async ({ bg }) => JSON.parse(JSON.stringify(await bg.ZF.restoreFoldersIfMissing()))`);
  expect(report.restoredFromBackup).toBe(1);
  expect(await ff.ext(`async ({ bg }) => JSON.stringify(await bg.ZF.loadFolders())`)).toBe(before);
  expect(await placeOf("beta")).toBe(JSON.parse(before)[0].id);
});
