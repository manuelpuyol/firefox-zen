// background.js: messages from pages, menus, shortcuts, the events that keep
// spaces consistent, start-up and retries, Glance, auto-unload.

import { describe, test, expect, beforeEach } from "vitest";
import { createFirefox, loadBackground, plain, ORIGIN } from "../support/firefox.js";

const W = 1;
let env, bg, ZF;

async function start(setup = async () => {}) {
  await setup();
  bg = loadBackground(env);
  ZF = bg.ZF;
  await env.events.runtime.onInstalled.trigger({ reason: "install" });
  await env.settle();
}

beforeEach(() => {
  env = createFirefox();
});

const activeSpace = async (windowId = W) => ZF.activeSpaceId(windowId, await ZF.loadSpaces());
const tag = id => env.browser.sessions.getTabValue(id, ZF.SPACE_KEY);

describe("messages from pages", () => {
  test("the extension's pages run changes in the background", async () => {
    await start();
    const page = env.newRealm(`${ORIGIN}sidebar/sidebar.html`, W);
    const folder = await page.browser.runtime.sendMessage({ type: "zf-call", name: "createFolder", args: ["From the sidebar", null, "home"] });
    expect(folder.name).toBe("From the sidebar");
    expect((await ZF.loadFolders()).map(f => f.name)).toContain("From the sidebar");
  });

  test("content scripts, other senders and internal calls are refused", async () => {
    await start();
    const site = env.newRealm("https://evil.test/", W, { tab: { id: 99, windowId: W }, frameId: 0 });
    expect(await site.browser.runtime.sendMessage({ type: "zf-call", name: "createFolder", args: ["x"] })).toBeUndefined();
    const page = env.newRealm(`${ORIGIN}sidebar/sidebar.html`, W);
    expect(await page.browser.runtime.sendMessage({ type: "zf-call", name: "followTab", args: [W, 1] })).toBeUndefined();
    expect(await page.browser.runtime.sendMessage({ type: "zf-call", name: "nonsense" })).toBeUndefined();
    expect(await ZF.loadFolders()).toHaveLength(0);
  });

  test("every change tells the sidebars which tabs changed", async () => {
    await start();
    const tab = await env.open("https://a.test/");
    const sidebar = env.newRealm(`${ORIGIN}sidebar/sidebar.html`, W);
    const heard = [];
    sidebar.browser.runtime.onMessage.addListener(message => void (message.type === "zf-changed" && heard.push(message)));
    await sidebar.browser.runtime.sendMessage({ type: "zf-call", name: "moveTabs", args: [[tab], ZF.ROOT] });
    await env.settle(60);
    expect(heard.at(-1).tabIds).toContain(tab);
  });
});

describe("start-up", () => {
  test("re-hides other spaces' tabs once per run of the extension", async () => {
    let a, x;
    await start(async () => {
      a = await env.open("https://a.test/");
      x = await env.open("https://x.test/");
      // Left over from before: two spaces, the window showing Work.
      await env.fakeBrowser.storage.local.set({ spaces: [{ id: "home", name: "Home", icon: "🏠", background: null }, { id: "work", name: "Work", icon: "💼", background: null }] });
      await env.browser.sessions.setTabValue(a, "zfSpace", "home");
      await env.browser.sessions.setTabValue(x, "zfSpace", "work");
      await env.browser.sessions.setWindowValue(W, "zfActiveSpace", "work");
    });
    expect([env.find(a).hidden, env.find(x).hidden]).toEqual([true, false]);
    expect((await env.browser.storage.session.get("spacesStarted")).spacesStarted).toBe(true);
  });

  test("builds the menus, with a Move to Space entry per space", async () => {
    await start();
    expect(env.menus.has("zf-keep")).toBe(true);
    expect(env.menus.has("zf-tab-to-space:home")).toBe(true);
    const work = await ZF.createSpace(null, { name: "Work" });
    await env.settle(60);
    expect(env.menus.get(`zf-tab-to-space:${work.id}`).title).toBe("💼 Work");
  });

  test("when hiding fails it retries on an alarm, with a limit, until it works", async () => {
    await start(async () => {
      await env.open("https://a.test/");
    });
    await ZF.createSpace(W);
    env.faults.hide = () => true;
    await ZF.switchSpace(W, "home");
    await env.settle();
    const alarm = await env.browser.alarms.get("zf-retry-hiding");
    expect(alarm).toBeDefined();
    expect((await env.browser.storage.session.get("hideRetries")).hideRetries).toBe(1);

    // Still failing: the next retry waits longer.
    await env.fakeBrowser.alarms.onAlarm.trigger({ name: "zf-retry-hiding" });
    await env.browser.alarms.clear("zf-retry-hiding");
    await bg.ZF.onHideFailed();
    expect((await env.browser.storage.session.get("hideRetries")).hideRetries).toBe(2);

    env.faults.hide = null;
    await env.fakeBrowser.alarms.onAlarm.trigger({ name: "zf-retry-hiding" });
    await env.settle();
    expect((await env.browser.storage.session.get("hideRetries")).hideRetries).toBe(0);
  });
});

describe("menus", () => {
  let a, b;
  beforeEach(async () => {
    await start(async () => {
      a = await env.open("https://a.test/");
      b = await env.open("https://b.test/");
    });
  });
  const show = async id => env.events.menus.onShown.trigger({ contexts: ["tab"] }, await env.browser.tabs.get(id));
  const click = async (menuItemId, id) => env.events.menus.onClicked.trigger({ menuItemId }, await env.browser.tabs.get(id));

  test("the tab menu shows what applies to the tab", async () => {
    await show(a);
    expect([env.menus.get("zf-keep").visible, env.menus.get("zf-unkeep").visible]).toEqual([true, false]);
    expect(env.menus.get("zf-tab-to-space").visible).toBe(false);
    expect(env.menus.get("zf-new-folder").visible).toBe(false);
    await click("zf-keep", a);
    await ZF.createSpace(null);
    await show(a);
    expect([env.menus.get("zf-keep").visible, env.menus.get("zf-unkeep").visible]).toEqual([false, true]);
    expect(env.menus.get("zf-tab-to-space").visible).toBe(true);
    expect(env.menus.get("zf-tab-to-space:home").enabled).toBe(false);
  });

  test("Copy URL copies every selected tab, in tab order", async () => {
    await env.browser.tabs.highlight({ windowId: W, tabs: [env.find(b).index, env.find(a).index] });
    await show(b);
    expect(env.menus.get("zf-copy-urls").title).toBe("Copy 2 URLs");
    await click("zf-copy-urls", b);
    expect(env.calls.clipboard).toEqual(["https://a.test/\nhttps://b.test/"]);
  });

  test("Keep and Move to Regular Tabs act on the selected tabs they apply to", async () => {
    await env.browser.tabs.highlight({ windowId: W, tabs: [env.find(a).index, env.find(b).index] });
    await click("zf-keep", a);
    await env.settle();
    expect([await ZF.getPlace(a), await ZF.getPlace(b)]).toEqual([ZF.ROOT, ZF.ROOT]);
    await click("zf-unkeep", a);
    await env.settle();
    expect([await ZF.getPlace(a), await ZF.getPlace(b)]).toEqual([null, null]);
  });

  test("Move to New Folder makes a folder in the tab's space and asks to name it", async () => {
    const heard = [];
    env.newRealm(`${ORIGIN}sidebar/sidebar.html`, W).messageListeners.push(m => void heard.push(m));
    await click("zf-folder-with-tab", a);
    await env.settle();
    const folder = (await ZF.loadFolders())[0];
    expect(await ZF.getPlace(a)).toBe(folder.id);
    expect(ZF.folderSpace([folder], folder, await ZF.loadSpaces())).toBe("home");
    expect(heard.some(m => m.type === "zf-rename" && m.folderId === folder.id)).toBe(true);
  });

  test("Move to New Folder on another space's sharing tab keeps it in its own space", async () => {
    const work = await ZF.createSpace(W);
    const call = await env.open("https://meet.test/");
    await ZF.switchSpace(W, "home");
    Object.assign(env.find(call), { hidden: false, sharingState: { camera: true } });
    await click("zf-folder-with-tab", call);
    await env.settle();
    const folders = await ZF.loadFolders();
    const folder = folders.find(f => f.id === (env.find(call) && folders[0].id));
    expect(ZF.folderSpace(folders, folder, await ZF.loadSpaces())).toBe(work.id);
    expect(await tag(call)).toBe(work.id);
    expect(await ZF.getPlace(call)).toBe(folder.id);
  });

  test("Move to Space moves the selected tabs", async () => {
    const work = await ZF.createSpace(W);
    await ZF.switchSpace(W, "home");
    await click(`zf-tab-to-space:${work.id}`, a);
    await env.settle();
    expect(await tag(a)).toBe(work.id);
    expect(env.find(a).hidden).toBe(true);
  });

  test("Reset to Original URL and Use Current Page", async () => {
    await click("zf-keep", a);
    await env.settle();
    await env.browser.tabs.update(a, { url: "https://a.test/elsewhere" });
    await show(a);
    expect(env.menus.get("reset-tab").enabled).toBe(true);
    await click("reset-tab", a);
    await env.settle();
    expect(env.find(a).url).toBe("https://a.test/");
    await env.browser.tabs.update(a, { url: "https://a.test/new-home" });
    await click("set-original", a);
    await env.settle();
    expect(await env.browser.sessions.getTabValue(a, ZF.ORIGINAL_URL_KEY)).toBe("https://a.test/new-home");
  });
});

describe("keeping spaces consistent", () => {
  let a;
  beforeEach(async () => {
    await start(async () => {
      a = await env.open("https://a.test/");
    });
  });

  test("activating another space's tab switches to its space", async () => {
    const work = await ZF.createSpace(W);
    const x = await env.open("https://x.test/");
    await ZF.switchSpace(W, "home");
    await env.settle();
    await env.browser.tabs.update(x, { active: true });
    await env.settle(90);
    expect(await activeSpace()).toBe(work.id);
    expect(env.find(a).hidden).toBe(true);
  });

  test("pinning or unpinning a tab makes it forget its space", async () => {
    await ZF.createSpace(W);
    await ZF.switchSpace(W, "home");
    await env.settle();
    expect(await tag(a)).toBe("home");
    await env.browser.tabs.update(a, { pinned: true });
    await env.settle();
    expect(await tag(a)).toBeUndefined();
  });

  test("a tab dragged to another window joins that window's space", async () => {
    env = createFirefox({ windows: [1, 2] });
    await start(async () => {
      a = await env.open("https://a.test/");
    });
    const work = await ZF.createSpace(2);
    await ZF.switchSpace(W, "home");
    await env.settle();
    await env.browser.tabs.move(a, { windowId: 2, index: -1 });
    await env.settle(90);
    expect(plain((await ZF.buildView(2)).regular.map(t => t.id))).toContain(a);
    expect((await ZF.buildView(2)).spaceId).toBe(work.id);
  });

  test("a new window starts in the space of the window it came from", async () => {
    const work = await ZF.createSpace(W);
    await env.events.windows.onFocusChanged.trigger(W);
    const win = await env.browser.windows.create({});
    await env.settle(90);
    expect(await activeSpace(win.id)).toBe(work.id);
  });

  test("a tab that stops sharing is hidden then", async () => {
    await ZF.createSpace(W);
    const call = await env.open("https://meet.test/");
    await ZF.switchSpace(W, "home");
    await env.settle();
    const tab = env.find(call);
    Object.assign(tab, { hidden: false, sharingState: { camera: true } });
    await ZF.showSpaceIn(W);
    expect(tab.hidden).toBe(false);
    tab.sharingState = { camera: false, microphone: false, screen: false };
    env.events.tabs.onUpdated.emit(call, { sharingState: tab.sharingState }, structuredClone(tab));
    await env.settle(90);
    expect(tab.hidden).toBe(true);
  });

  test("the next and previous space shortcuts switch spaces", async () => {
    const work = await ZF.createSpace(W);
    await ZF.switchSpace(W, "home");
    await env.events.commands.onCommand.trigger("space-next", await env.browser.tabs.get(a));
    await env.settle();
    expect(await activeSpace()).toBe(work.id);
    await env.events.commands.onCommand.trigger("space-previous", (await env.browser.tabs.query({ windowId: W, active: true }))[0]);
    await env.settle();
    expect(await activeSpace()).toBe("home");
  });
});

describe("Glance", () => {
  let source, content;
  beforeEach(async () => {
    await start(async () => {
      source = await env.browser.tabs.create({ url: "https://news.test/" });
    });
    content = (tab = source) => env.newRealm(tab.url, tab.windowId, { tab, frameId: 0 });
  });
  const grant = async () => {
    await env.browser.permissions.request({ origins: ["<all_urls>"] });
    await env.settle(90);
  };

  test("its script is only registered while access to websites is granted", async () => {
    expect(env.scripts.size).toBe(0);
    await grant();
    expect([...env.scripts.keys()]).toEqual(["glance"]);
    await env.browser.permissions.remove({ origins: ["<all_urls>"] });
    await env.settle(90);
    expect(env.scripts.size).toBe(0);
  });

  test("Option+click opens a centred popup; Escape closes it", async () => {
    await grant();
    const page = content();
    expect((await page.browser.runtime.sendMessage({ type: "glance-context" })).enabled).toBe(true);
    await page.browser.runtime.sendMessage({ type: "glance-open", url: "https://news.test/story" });
    const popup = env.windows.find(w => w.type === "popup");
    expect(popup).toBeDefined();
    expect(env.tabs.find(t => t.windowId === popup.id).url).toBe("https://news.test/story");
    const inGlance = content(env.tabs.find(t => t.windowId === popup.id));
    await inGlance.browser.runtime.sendMessage({ type: "glance-escape" });
    expect(env.windows.some(w => w.type === "popup")).toBe(false);
  });

  test("nothing opens without access, in a container tab, or for a non-web address", async () => {
    const page = content();
    await page.browser.runtime.sendMessage({ type: "glance-open", url: "https://news.test/a" });
    await grant();
    await page.browser.runtime.sendMessage({ type: "glance-open", url: "javascript:alert(1)" });
    const container = await env.browser.tabs.create({ url: "https://bank.test/" });
    env.find(container.id).cookieStoreId = "firefox-container-1";
    await content({ ...container, cookieStoreId: "firefox-container-1" }).browser.runtime.sendMessage({ type: "glance-open", url: "https://bank.test/a" });
    expect(env.windows.some(w => w.type === "popup")).toBe(false);
  });

  test("the expand shortcut turns the Glance into a tab next to where it came from", async () => {
    await grant();
    await content().browser.runtime.sendMessage({ type: "glance-open", url: "https://news.test/story" });
    const popup = env.windows.find(w => w.type === "popup");
    const glanceTab = env.tabs.find(t => t.windowId === popup.id);
    env.windows.splice(env.windows.indexOf(popup), 1);
    env.windows.unshift(popup);
    await env.events.commands.onCommand.trigger("glance-expand");
    expect(glanceTab.windowId).toBe(W);
    expect(glanceTab.index).toBe(env.find(source.id).index + 1);
  });
});

describe("auto-unload", () => {
  test("the alarm unloads tabs that haven't been used for a while", async () => {
    let old;
    await start(async () => {
      old = await env.open("https://old.test/");
      await env.open("https://current.test/", { active: true });
    });
    env.find(old).lastAccessed = Date.now() - 2 * 60 * 60_000;
    await env.fakeBrowser.alarms.onAlarm.trigger({ name: "zf-auto-unload" });
    await env.settle();
    expect(env.find(old).discarded).toBe(true);
    expect((await env.browser.storage.local.get("lastAutoUnload")).lastAutoUnload.unloaded).toBe(1);
  });
});

describe("the rest of the background", () => {
  let a, b;
  beforeEach(async () => {
    await start(async () => {
      a = await env.open("https://a.test/", { title: "A" });
      b = await env.open("https://b.test/", { title: "B" });
    });
  });

  test("the reset shortcut takes a kept tab back to its original address, and leaves others alone", async () => {
    await ZF.moveTabs([a], ZF.ROOT);
    await env.browser.tabs.update(a, { url: "https://a.test/away" });
    await env.browser.tabs.update(b, { url: "https://b.test/away" });
    await env.events.commands.onCommand.trigger("reset-tab", await env.browser.tabs.get(a));
    await env.events.commands.onCommand.trigger("reset-tab", await env.browser.tabs.get(b));
    expect([env.find(a).url, env.find(b).url]).toEqual(["https://a.test/", "https://b.test/away"]);
  });

  test("Move to New Folder takes every selected tab, in tab order", async () => {
    await env.browser.tabs.highlight({ windowId: W, tabs: [env.find(b).index, env.find(a).index] });
    await env.events.menus.onClicked.trigger({ menuItemId: "zf-folder-with-tab" }, await env.browser.tabs.get(b));
    await env.settle();
    const folder = (await ZF.loadFolders())[0];
    expect(plain((await ZF.buildView(W)).byPlace.get(folder.id).map(t => t.id))).toEqual([a, b]);
  });

  test("one hiding retry at a time, and at most five", async () => {
    await ZF.onHideFailed();
    await ZF.onHideFailed();
    expect((await env.browser.storage.session.get("hideRetries")).hideRetries).toBe(1);
    await env.browser.storage.session.set({ hideRetries: 5 });
    await env.browser.alarms.clear("zf-retry-hiding");
    await ZF.onHideFailed();
    expect(await env.browser.alarms.get("zf-retry-hiding")).toBeUndefined();
  });

  test("waking from idle doesn't redo the start-up work", async () => {
    await ZF.createSpace(W);
    await ZF.switchSpace(W, "home");
    await env.settle();
    // Shown by hand meanwhile; a second background page start (idle wake-up)
    // must not hide it again.
    const [x] = env.tabs.filter(t => t.hidden);
    await env.browser.tabs.show(x.id);
    loadBackground(env);
    await env.settle();
    expect(env.find(x.id).hidden).toBe(false);
  });

  test("focus leaving every window is ignored; popups get no space", async () => {
    const work = await ZF.createSpace(W);
    await env.events.windows.onFocusChanged.trigger(W);
    await env.events.windows.onFocusChanged.trigger(-1);
    const popup = await env.browser.windows.create({ type: "popup" });
    const win = await env.browser.windows.create({});
    await env.settle(90);
    expect(await env.browser.sessions.getWindowValue(popup.id, ZF.WINDOW_SPACE_KEY)).toBeUndefined();
    expect(await env.browser.sessions.getWindowValue(win.id, ZF.WINDOW_SPACE_KEY)).toBe(work.id);
  });

  test("after tabs are shown or hidden, Firefox's tab order is put back in line", async () => {
    await ZF.moveTabs([b], ZF.ROOT);
    // Something else moves the kept tab after the regular one.
    await env.browser.tabs.move(b, { windowId: W, index: -1 });
    expect(env.find(b).index).toBe(1);
    // (The active tab can't be hidden; another one is.)
    const c = await env.open("https://c.test/");
    await env.browser.tabs.hide(c);
    expect(env.find(c).hidden).toBe(true);
    await env.browser.tabs.show(c);
    await new Promise(r => setTimeout(r, 250));
    await env.settle();
    expect(env.find(b).index).toBe(0);
  });

  test("a native group is only converted once its name has stayed the same for a second", async () => {
    env.groups.push({ id: 9, windowId: W, title: "Rea" });
    env.find(a).groupId = 9;
    await env.events.tabGroups.onCreated.trigger({ id: 9, title: "Rea" });
    // Still being typed: the name has changed by the time the second is up,
    // and Firefox's update for it hasn't arrived yet.
    env.groups[0].title = "Reading";
    await new Promise(r => setTimeout(r, 1100));
    await env.settle();
    expect(await ZF.loadFolders()).toEqual([]);
    await env.events.tabGroups.onUpdated.trigger({ id: 9, title: "Reading" });
    await new Promise(r => setTimeout(r, 1100));
    await env.settle();
    expect((await ZF.loadFolders()).map(f => f.name)).toEqual(["Reading"]);
  });

  test("a native group removed before its name settles is left alone", async () => {
    env.groups.push({ id: 8, windowId: W, title: "Gone" });
    await env.events.tabGroups.onCreated.trigger({ id: 8, title: "Gone" });
    env.groups.length = 0;
    await new Promise(r => setTimeout(r, 1100));
    await env.settle();
    expect(await ZF.loadFolders()).toEqual([]);
  });

  test("a tab that can't be unloaded is counted as failed", async () => {
    env.find(a).lastAccessed = 0;
    const discard = env.browser.tabs.discard;
    env.browser.tabs.discard = async () => {
      throw new Error("Can't discard");
    };
    const summary = await ZF.unloadStaleTabs({ staleMs: 1 });
    env.browser.tabs.discard = discard;
    expect(summary.failed).toBe(1);
  });
});
