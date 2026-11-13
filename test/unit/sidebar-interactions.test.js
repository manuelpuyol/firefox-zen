// The sidebar's interactions: drag and drop, context menus, selecting several
// tabs, in-place updates, buttons on rows, settings and backgrounds.

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { openSidebar } from "../support/sidebar.js";

const W = 1;
let s, env, ZF;

async function open(setup) {
  s = await openSidebar(setup);
  ({ env, ZF } = s);
}

afterEach(async () => {
  await s?.close();
  s = null;
});

// A drag from one node to another, dropped at (x, y) percent of the target.
async function dragTo(from, to, { x = 50, y = 50 } = {}) {
  const { win } = s;
  const transfer = new win.DataTransfer();
  const fire = (type, node, init = {}) => {
    const event = new win.MouseEvent(type, { bubbles: true, cancelable: true, ...init });
    Object.defineProperty(event, "dataTransfer", { value: transfer });
    node.dispatchEvent(event);
    return event;
  };
  fire("dragstart", from);
  const over = fire("dragover", to, { clientX: x, clientY: y });
  const marks = [...to.classList].filter(c => c.startsWith("drop-"));
  fire("drop", to, { clientX: x, clientY: y });
  fire("dragend", from);
  await s.redraw();
  return { accepted: over.defaultPrevented, marks };
}

describe("drag and drop", () => {
  let mail, a, b, c, folder, sub;
  beforeEach(async () => {
    await open(async env => {
      mail = await env.open("https://mail.test/", { pinned: true, title: "Mail" });
      a = await env.open("https://a.test/", { title: "A" });
      b = await env.open("https://b.test/", { title: "B" });
      c = await env.open("https://c.test/", { title: "C" });
    });
    folder = await ZF.createFolder("Work", null, "home");
    sub = await ZF.createFolder("Sub", folder.id);
    await s.redraw();
  });

  test("a tab dropped on the middle of a folder goes into it", async () => {
    const { accepted, marks } = await dragTo(s.row(a), s.folderRow(folder.id));
    expect([accepted, marks]).toEqual([true, ["drop-into"]]);
    expect(await ZF.getPlace(a)).toBe(folder.id);
    expect(s.$(`[data-folder-block="${folder.id}"] .row[data-tab-id="${a}"]`)).not.toBeNull();
  });

  test("dropped on the top or bottom edge of a folder, it goes beside it", async () => {
    await ZF.updateFolder(folder.id, { collapsed: true });
    await s.redraw();
    expect((await dragTo(s.row(a), s.folderRow(folder.id), { y: 10 })).marks).toEqual(["drop-before"]);
    expect(await ZF.getPlace(a)).toBe(ZF.ROOT);
    // Below a closed folder: after it, at the same level.
    expect((await dragTo(s.row(b), s.folderRow(folder.id), { y: 90 })).marks).toEqual(["drop-after"]);
    expect(await ZF.getPlace(b)).toBe(ZF.ROOT);
    // (A closed folder's rows stay in the page, hidden by CSS.)
    expect(s.titles("#pinned")).toEqual(["A", "Work", "Sub", "B"]);
  });

  test("below an open folder's name is the start of that folder", async () => {
    const { marks } = await dragTo(s.row(a), s.folderRow(folder.id), { y: 90 });
    expect(marks).toEqual(["drop-after", "drop-child"]);
    expect(await ZF.getPlace(a)).toBe(folder.id);
  });

  test("a folder can't go inside itself or its subfolders", async () => {
    expect((await dragTo(s.folderRow(folder.id), s.folderRow(sub.id))).accepted).toBe(false);
    expect((await dragTo(s.folderRow(folder.id), s.folderRow(folder.id))).accepted).toBe(false);
    expect((await ZF.loadFolders()).find(f => f.id === folder.id).parentId).toBeNull();
    // Nor among regular tabs, Essentials or the separator.
    expect((await dragTo(s.folderRow(sub.id), s.row(a))).accepted).toBe(false);
    expect((await dragTo(s.folderRow(sub.id), s.tile(mail))).accepted).toBe(false);
    expect((await dragTo(s.folderRow(sub.id), s.$("#separator"))).accepted).toBe(false);
  });

  test("a subfolder can be moved out to the top level, before its parent", async () => {
    await dragTo(s.folderRow(sub.id), s.folderRow(folder.id), { y: 10 });
    expect((await ZF.loadFolders()).find(f => f.id === sub.id).parentId).toBeNull();
    expect(s.titles("#pinned").slice(0, 2)).toEqual(["Sub", "Work"]);
  });

  test("tabs are placed before or after the tab they're dropped on", async () => {
    await ZF.moveTabs([a, b], folder.id);
    await s.redraw();
    await dragTo(s.row(b), s.row(a), { y: 10 });
    expect(s.titles(`[data-folder-block="${folder.id}"]`)).toEqual(["Work", "Sub", "B", "A"]);
    // Among regular tabs: back out of the folder, after C.
    await dragTo(s.row(a), s.row(c), { y: 90 });
    expect(await ZF.getPlace(a)).toBeNull();
    expect(s.titles("#regular")).toEqual(["C", "A"]);
    // A tab can't be dropped on itself.
    expect((await dragTo(s.row(c), s.row(c))).accepted).toBe(false);
  });

  test("Essentials: drop a tab on the strip or beside a tile; drag one out to unpin it", async () => {
    expect((await dragTo(s.row(a), s.tile(mail), { x: 10 })).marks).toEqual(["drop-before"]);
    expect(s.$$("#essentials .tile").map(t => Number(t.dataset.tabId))).toEqual([a, mail]);
    await dragTo(s.row(b), s.$("#essentials"));
    expect(env.find(b).pinned).toBe(true);
    expect((await dragTo(s.row(c), s.tile(mail), { x: 90 })).marks).toEqual(["drop-after"]);
    expect(s.$$("#essentials .tile").map(t => Number(t.dataset.tabId))).toEqual([a, mail, c, b]);

    await dragTo(s.tile(mail), s.$("#regular"));
    expect(env.find(mail).pinned).toBe(false);
    expect(s.titles("#regular")).toContain("Mail");
  });

  test("the separator puts tabs at the top of the regular tabs; the kept area keeps them", async () => {
    await ZF.moveTabs([a], folder.id);
    await s.redraw();
    await dragTo(s.row(a), s.$("#separator"));
    expect(s.titles("#regular")).toEqual(["A", "B", "C"]);
    await dragTo(s.row(c), s.$("#pinned"));
    expect(await ZF.getPlace(c)).toBe(ZF.ROOT);
  });

  test("dragging selected tabs moves them all and keeps them selected", async () => {
    s.click(s.row(a).querySelector(".title"));
    await s.redraw();
    s.click(s.row(b).querySelector(".title"), { metaKey: true });
    await s.redraw();
    await dragTo(s.row(b), s.folderRow(folder.id));
    expect([await ZF.getPlace(a), await ZF.getPlace(b)]).toEqual([folder.id, folder.id]);
    expect([env.find(a).highlighted, env.find(b).highlighted]).toEqual([true, true]);
    expect(s.$$(".row.selected").map(n => Number(n.dataset.tabId)).sort()).toEqual([a, b].sort());
  });

  test("dropping another space's sharing tab here brings it into this space", async () => {
    const calls = await ZF.createSpace(W, { name: "Calls" });
    const call = await env.open("https://meet.test/", { title: "Meet" });
    await ZF.switchSpace(W, "home");
    env.change(call, { hidden: false, sharingState: { camera: true } });
    await s.redraw();
    expect(s.row(call).querySelector(".space-badge")).not.toBeNull();
    await dragTo(s.row(call), s.folderRow(folder.id));
    expect(await env.browser.sessions.getTabValue(call, ZF.SPACE_KEY)).toBe("home");
    expect(await ZF.getPlace(call)).toBe(folder.id);
    expect(calls.id).not.toBe("home");
  });

  test("the drop marker follows the pointer and is cleared at the end", async () => {
    const { win } = s;
    const transfer = new win.DataTransfer();
    const fire = (type, node, init) => {
      const event = new win.MouseEvent(type, { bubbles: true, cancelable: true, ...init });
      Object.defineProperty(event, "dataTransfer", { value: transfer });
      node.dispatchEvent(event);
    };
    fire("dragstart", s.row(a));
    expect(s.row(a).classList.contains("dragging")).toBe(true);
    expect(JSON.parse(transfer.getData("application/x-zen-folder-tools"))).toMatchObject({ kind: "tab", id: a });
    fire("dragover", s.folderRow(folder.id), { clientY: 50 });
    fire("dragover", s.row(b), { clientY: 10 });
    expect(s.folderRow(folder.id).classList.contains("drop-into")).toBe(false);
    expect(s.row(b).classList.contains("drop-before")).toBe(true);
    fire("dragend", s.row(a));
    expect(s.$$(".dragging, .drop-before, .drop-after, .drop-into, .drop-zone")).toHaveLength(0);
    // A drop with no drag in progress (e.g. a link from a page) does nothing.
    fire("drop", s.folderRow(folder.id), { clientY: 50 });
    await s.redraw();
    expect(await ZF.getPlace(a)).toBeNull();
  });
});

describe("context menus", () => {
  let a, folder;
  beforeEach(async () => {
    await open(async env => {
      a = await env.open("https://a.test/", { title: "A" });
    });
    folder = await ZF.createFolder("Work", null, "home");
    await s.redraw();
  });
  const rightClick = node => node.dispatchEvent(new s.win.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  const menu = async node => {
    rightClick(node);
    await env.events.menus.onShown.trigger({ contexts: ["all"] });
  };
  const choose = async id => {
    await env.events.menus.onClicked.trigger({ menuItemId: id });
    await s.redraw();
  };
  const visible = id => env.menus.get(id).visible;

  test("a tab gets Firefox's own tab menu", async () => {
    rightClick(s.row(a));
    expect(env.calls.overrideContext.at(-1)).toEqual({ context: "tab", tabId: a });
  });

  test("a folder's menu: new subfolder, rename, remove, move to space", async () => {
    await menu(s.folderRow(folder.id));
    expect(env.calls.overrideContext.at(-1)).toEqual({ showDefaults: false });
    expect(["zf-new-folder", "zf-new-subfolder", "zf-rename-folder", "zf-remove-folder"].map(visible)).toEqual([true, true, true, true]);
    expect(visible("zf-folder-to-space")).toBe(false);
    expect(visible("zf-space-rename")).toBe(false);

    await choose("zf-new-subfolder");
    const child = (await ZF.loadFolders()).find(f => f.parentId === folder.id);
    expect(child.name).toBe("New Folder");
    const input = s.$(`[data-rename-for="${child.id}"]`);
    input.value = "Child";
    s.key(input, "Enter");
    await s.redraw();
    expect((await ZF.loadFolders()).find(f => f.id === child.id).name).toBe("Child");

    await menu(s.folderRow(folder.id));
    await choose("zf-rename-folder");
    expect(s.win.zfTest.renaming()).toBe(folder.id);
    s.key(s.$(`[data-rename-for="${folder.id}"]`), "Escape");
    await s.redraw();
    expect(s.win.zfTest.renaming()).toBeNull();

    await ZF.moveTabs([a], folder.id);
    await menu(s.folderRow(folder.id));
    await choose("zf-remove-folder");
    // Its tabs stay kept and its subfolder moves up, both at the top level.
    const left = await ZF.loadFolders();
    expect(left.map(f => [f.name, f.parentId, f.spaceId])).toEqual([["Child", null, "home"]]);
    expect(await ZF.getPlace(a)).toBe(ZF.ROOT);
  });

  test("with several spaces, a folder can move to another one", async () => {
    const work = await ZF.createSpace(null, { name: "Work" });
    await s.redraw();
    await menu(s.folderRow(folder.id));
    expect(visible("zf-folder-to-space")).toBe(true);
    expect(env.menus.get("zf-folder-to-space:home").enabled).toBe(false);
    await choose(`zf-folder-to-space:${work.id}`);
    expect(ZF.folderSpace(await ZF.loadFolders(), (await ZF.loadFolders())[0], await ZF.loadSpaces())).toBe(work.id);
    expect(s.folderRow(folder.id)).toBeNull();
  });

  test("empty space: only New Folder, which starts renaming it", async () => {
    await menu(s.$("#pinned"));
    expect([visible("zf-new-folder"), visible("zf-rename-folder")]).toEqual([true, false]);
    await choose("zf-new-folder");
    const created = (await ZF.loadFolders()).find(f => f.id !== folder.id);
    expect(s.win.zfTest.renaming()).toBe(created.id);
    s.$(`[data-rename-for="${created.id}"]`).dispatchEvent(new s.win.Event("blur"));
    await s.redraw();
    expect(s.win.zfTest.renaming()).toBeNull();
  });

  test("a space's menu: icon, background, order, delete, new", async () => {
    const work = await ZF.createSpace(W, { name: "Work" });
    await s.redraw();
    await menu(s.$(`#spaces [data-space-id="${work.id}"]`));
    expect(visible("zf-space-rename")).toBe(true);
    expect(visible("zf-new-folder")).toBe(false);
    expect([env.menus.get("zf-space-left").enabled, env.menus.get("zf-space-right").enabled]).toEqual([true, false]);
    expect(env.menus.get("zf-space-bg:default").checked).toBe(true);

    await choose("zf-space-icon:🎮");
    expect(s.$(`#spaces [data-space-id="${work.id}"]`).textContent).toBe("🎮");

    await menu(s.$("#space-label"));
    await choose("zf-space-bg:ocean");
    expect(s.doc.body.dataset.background).toBe("ocean");
    await menu(s.$("#space-label"));
    expect(env.menus.get("zf-space-bg:ocean").checked).toBe(true);
    await choose("zf-space-bg:default");
    expect(s.doc.body.dataset.background).toBe("aurora");

    await menu(s.$(`#spaces [data-space-id="${work.id}"]`));
    await choose("zf-space-left");
    expect((await ZF.loadSpaces()).map(sp => sp.name)).toEqual(["Work", "Home"]);

    await menu(s.$(`#spaces [data-space-id="${work.id}"]`));
    await choose("zf-space-new");
    expect(s.$("#space-dialog").open).toBe(true);
    s.$("#space-dialog").close();

    await menu(s.$(`#spaces [data-space-id="${work.id}"]`));
    await choose("zf-space-delete");
    expect((await ZF.loadSpaces()).map(sp => sp.name)).toEqual(["Home"]);
    expect(s.$$("#spaces .space")).toHaveLength(0);
  });

  test("Rename on another space switches to it and opens the name box", async () => {
    await ZF.createSpace(W, { name: "Work" });
    await s.redraw();
    await menu(s.$('#spaces [data-space-id="home"]'));
    await choose("zf-space-rename");
    expect(await s.activeSpace()).toBe("home");
    const input = s.$("#space-label .rename");
    expect(input.value).toBe("Home");
    s.key(input, "Escape");
    await s.redraw();
    expect(s.$("#space-label .rename")).toBeNull();
    expect((await ZF.loadSpaces())[0].name).toBe("Home");
  });

  test("the New Space dialog has no context menu, and menus from elsewhere are ignored", async () => {
    rightClick(s.$("#space-name"));
    await env.events.menus.onShown.trigger({ contexts: ["all"] });
    await choose("zf-new-folder");
    expect(await ZF.loadFolders()).toHaveLength(1);
  });
});

describe("selecting several tabs", () => {
  let a, b, c, d;
  beforeEach(async () => {
    await open(async env => {
      a = await env.open("https://a.test/", { title: "A" });
      b = await env.open("https://b.test/", { title: "B" });
      c = await env.open("https://c.test/", { title: "C" });
      d = await env.open("https://d.test/", { title: "D" });
    });
    s.click(s.row(b).querySelector(".title"));
    await s.redraw();
  });
  const selected = () => s.$$(".row.selected").map(n => Number(n.dataset.tabId));
  const highlighted = () => env.tabs.filter(t => t.highlighted).map(t => t.id);

  test("Cmd+click adds and removes tabs; the active tab stays", async () => {
    s.click(s.row(d), { metaKey: true });
    await s.redraw();
    expect(selected()).toEqual([b, d]);
    expect(highlighted()).toEqual([b, d]);
    expect(env.find(b).active).toBe(true);
    s.click(s.row(d), { metaKey: true });
    await s.redraw();
    expect(selected()).toEqual([]);
    expect(highlighted()).toEqual([b]);
  });

  test("Shift+click selects the range from the last clicked tab, in sidebar order", async () => {
    s.click(s.row(d), { shiftKey: true });
    await s.redraw();
    expect(selected()).toEqual([b, c, d]);
    s.click(s.row(a), { shiftKey: true });
    await s.redraw();
    expect(selected()).toEqual([a, b]);
  });

  test("tabs inside a closed folder are skipped by a range", async () => {
    const folder = await ZF.createFolder("Closed", null, "home");
    await ZF.moveTabs([c], folder.id);
    await ZF.updateFolder(folder.id, { collapsed: true });
    await ZF.moveTabs([a], ZF.ROOT);
    await s.redraw();
    s.click(s.row(a));
    await s.redraw();
    s.click(s.row(d), { shiftKey: true });
    await s.redraw();
    expect(selected().sort()).toEqual([a, b, d].sort());
  });

  test("Escape, or a plain click, goes back to one tab", async () => {
    s.click(s.row(c), { metaKey: true });
    await s.redraw();
    s.key(s.doc, "Escape");
    await s.redraw();
    expect(selected()).toEqual([]);
    expect(highlighted()).toEqual([b]);

    s.click(s.row(c), { metaKey: true });
    await s.redraw();
    s.click(s.row(d));
    await s.redraw();
    expect(highlighted()).toEqual([d]);
    expect(env.find(d).active).toBe(true);
  });

  test("closing one of the selected tabs closes them all", async () => {
    s.click(s.row(c), { metaKey: true });
    await s.redraw();
    s.click(s.row(c).querySelector(".close"));
    await s.redraw();
    expect([env.find(b), env.find(c)]).toEqual([undefined, undefined]);
    expect(env.find(a)).toBeDefined();
  });

  test("a selection made in Firefox's tab strip shows here", async () => {
    await env.browser.tabs.highlight({ windowId: W, tabs: [env.find(b).index, env.find(a).index] });
    await s.redraw();
    expect(selected()).toEqual([a, b]);
  });
});

describe("rows update in place", () => {
  let a, kept;
  beforeEach(async () => {
    await open(async env => {
      a = await env.open("https://a.test/", { title: "A" });
      kept = await env.open("https://docs.test/", { title: "Docs" });
    });
    await ZF.moveTabs([kept], ZF.ROOT);
    await s.redraw();
  });

  test("title, address and unloading change the row without redrawing the list", async () => {
    const node = s.row(kept);
    env.change(kept, { title: "Docs (2)" });
    await s.redraw();
    expect(s.row(kept)).toBe(node);
    expect(node.querySelector(".title").textContent).toBe("Docs (2)");
    expect(node.title).toBe("Docs (2)");

    // Away from its original address, its reset button lights up; it goes back.
    env.change(kept, { url: "https://docs.test/page-2" });
    await s.redraw();
    expect(node.querySelector(".reset").classList.contains("changed")).toBe(true);
    s.click(node.querySelector(".reset"));
    await s.redraw();
    expect(env.find(kept).url).toBe("https://docs.test/");

    expect(s.row(kept).querySelector(".close").title).toBe("Unload tab (close again to remove)");
    env.change(kept, { discarded: true });
    await s.redraw();
    expect(s.row(kept).classList.contains("discarded")).toBe(true);
    expect(s.row(kept).querySelector(".close").title).toBe("Close tab");
  });

  test("favicons: the page's icon, or a globe for unusable or broken ones", async () => {
    env.change(a, { favIconUrl: "https://a.test/icon.png" });
    await s.redraw();
    expect(s.row(a).querySelector(".favicon").src).toBe("https://a.test/icon.png");
    s.row(a).querySelector(".favicon").dispatchEvent(new s.win.Event("error"));
    expect(s.row(a).querySelector(".favicon").src).toMatch(/^data:image\/svg/);
    env.change(a, { favIconUrl: "chrome://branding/icon.png" });
    await s.redraw();
    expect(s.row(a).querySelector(".favicon").src).toMatch(/^data:image\/svg/);
  });

  test("switching tabs moves the highlight without redrawing", async () => {
    const node = s.row(a);
    await env.browser.tabs.update(a, { active: true });
    await s.redraw();
    expect(s.row(a)).toBe(node);
    expect(s.$$(".row.active").map(n => Number(n.dataset.tabId))).toEqual([a]);
  });

  test("a playing tab gets a mute button", async () => {
    env.change(a, { audible: true });
    await s.redraw();
    const button = s.row(a).querySelector(".audio");
    expect(button.textContent).toBe("🔊");
    s.click(button);
    await s.redraw();
    expect(env.find(a).mutedInfo.muted).toBe(true);
    expect(s.row(a).querySelector(".audio").textContent).toBe("🔇");
  });

  test("another space's hidden tab changing doesn't touch the list", async () => {
    await ZF.createSpace(W);
    const x = await env.open("https://x.test/", { title: "X" });
    await ZF.switchSpace(W, "home");
    await s.redraw();
    const node = s.row(a);
    env.change(x, { title: "X (1)", audible: true });
    await s.redraw();
    expect(s.row(a)).toBe(node);
    expect(s.row(x)).toBeNull();
  });

  test("a new active tab out of view is scrolled to", async () => {
    const list = s.$("#scroll");
    list.getBoundingClientRect = () => ({ top: 0, bottom: 50, height: 50, left: 0, right: 100, width: 100 });
    list.scrollBy = vi.fn();
    const fresh = await env.browser.tabs.create({ url: "https://new.test/" });
    await s.redraw();
    expect(s.row(fresh.id).classList.contains("active")).toBe(true);
    expect(list.scrollBy).toHaveBeenCalledWith({ top: 50, behavior: "smooth" });
  });
});

describe("the rest of the sidebar", () => {
  beforeEach(() => open());

  test("+ New Tab opens a tab in this window", async () => {
    s.click(s.$("#new-tab"));
    await s.redraw();
    const [tab] = env.tabs.filter(t => t.windowId === W);
    expect(tab.active).toBe(true);
    expect(s.$$("#regular .row")).toHaveLength(1);
  });

  test("settings apply straight away", async () => {
    await ZF.updateSettings("sidebar", { showCounts: false, showClear: false, animations: false, showScrollbar: false, tileSize: 80 });
    await ZF.updateSettings("appearance", { rowHeight: 30, background: "sunset" });
    await s.redraw();
    const body = s.doc.body.classList;
    expect([body.contains("hide-counts"), body.contains("hide-clear"), body.contains("no-animations")]).toEqual([true, true, true]);
    expect(s.doc.documentElement.classList.contains("hide-scrollbar")).toBe(true);
    const css = s.doc.documentElement.style;
    expect([css.getPropertyValue("--tile-size"), css.getPropertyValue("--row-height"), css.getPropertyValue("--radius")]).toEqual(["80px", "30px", "11px"]);
    expect(s.doc.body.dataset.background).toBe("sunset");
  });

  test("Clear without confirmation closes at once", async () => {
    await env.open("https://a.test/");
    await ZF.updateSettings("sidebar", { confirmClear: false });
    await s.redraw();
    s.click(s.$("#clear"));
    await s.redraw();
    expect(env.tabs.map(t => t.url)).toEqual(["about:newtab"]);
  });

  test("closing a kept tab with unload-on-close off closes it straight away", async () => {
    const kept = await env.open("https://a.test/", { title: "A" });
    await ZF.moveTabs([kept], ZF.ROOT);
    await ZF.updateSettings("sidebar", { unloadOnClose: false });
    await s.redraw();
    expect(s.row(kept).querySelector(".close").title).toBe("Close tab");
    s.click(s.row(kept).querySelector(".close"));
    await s.redraw();
    expect(env.find(kept)).toBeUndefined();
  });

  test("clicking an Essential switches to it; middle-click doesn't scroll", async () => {
    const mail = await env.open("https://mail.test/", { pinned: true });
    await s.redraw();
    s.click(s.tile(mail));
    await s.redraw();
    expect(env.find(mail).active).toBe(true);
    const down = new s.win.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 1 });
    s.tile(mail).dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
  });

  test("a folder being renamed that disappears ends the rename", async () => {
    const folder = await ZF.createFolder("Gone", null, "home");
    await s.redraw();
    s.win.zfTest.startRename(folder.id);
    await s.redraw();
    s.$(`[data-rename-for="${folder.id}"]`).value = "Typed";
    // A redraw mid-rename keeps what was typed.
    await s.win.zfTest.render();
    expect(s.$(`[data-rename-for="${folder.id}"]`).value).toBe("Typed");
    await ZF.removeFolder(folder.id);
    await s.win.zfTest.render();
    await s.redraw();
    expect(s.win.zfTest.renaming()).toBeNull();
  });

  test("switching space mid-rename keeps the name that was typed", async () => {
    const work = await ZF.createSpace(W, { name: "Work" });
    await s.redraw();
    s.$("#space-label").dispatchEvent(new s.win.MouseEvent("dblclick", { bubbles: true }));
    await s.redraw();
    s.$("#space-label .rename").value = "Job";
    await ZF.switchSpace(W, "home");
    await s.redraw();
    expect((await ZF.loadSpaces()).find(sp => sp.id === work.id).name).toBe("Job");
    expect(s.$("#space-label").textContent).toContain("Home");
  });

  test("a tab opened in another window doesn't redraw this one", async () => {
    const node = s.$("#regular");
    const before = node.innerHTML;
    await env.browser.windows.create({ url: "https://elsewhere.test/" });
    await s.redraw();
    expect(node.innerHTML).toBe(before);
    expect(s.$$("#regular .row")).toHaveLength(0);
  });
});

describe("redraws wait for the pointer and for drags", () => {
  let a;
  beforeEach(() =>
    open(async env => {
      a = await env.open("https://a.test/", { title: "A" });
    })
  );
  const pointer = (type, target = s.row(a)) => target.dispatchEvent(new s.win.PointerEvent(type, { bubbles: true }));

  test("while a button is held, changes wait until it's released", async () => {
    pointer("pointerdown");
    const b = await s.env.open("https://b.test/", { title: "B" });
    env.change(a, { title: "A (1)" });
    await s.redraw();
    expect(s.row(b)).toBeNull();
    expect(s.row(a).querySelector(".title").textContent).toBe("A");
    s.win.dispatchEvent(new s.win.PointerEvent("pointerup", { bubbles: true }));
    await s.redraw();
    expect(s.titles("#regular")).toEqual(["A (1)", "B"]);
  });

  test("during a drag, changes wait until it ends; drops outside any target do nothing", async () => {
    const transfer = new s.win.DataTransfer();
    const fire = (type, node, init) => {
      const event = new s.win.MouseEvent(type, { bubbles: true, cancelable: true, ...init });
      Object.defineProperty(event, "dataTransfer", { value: transfer });
      node.dispatchEvent(event);
      return event;
    };
    fire("dragstart", s.row(a));
    const b = await s.env.open("https://b.test/", { title: "B" });
    await s.redraw();
    expect(s.row(b)).toBeNull();
    expect(fire("dragover", s.$("#settings")).defaultPrevented).toBe(false);
    fire("dragend", s.row(a));
    await s.redraw();
    expect(s.row(b)).not.toBeNull();
  });

  test("overlapping redraws: only the newest draws, and one started before a local change is redone", async () => {
    const folder = await ZF.createFolder("F", null, "home");
    await s.redraw();
    await Promise.all([s.win.zfTest.render(), s.win.zfTest.render()]);
    const drawing = s.win.zfTest.render();
    // A folder toggled while that redraw is reading state.
    s.click(s.folderRow(folder.id));
    await drawing;
    await s.redraw();
    expect(s.$(`[data-folder-block="${folder.id}"] > .children`).classList.contains("collapsed")).toBe(true);
    expect((await ZF.loadFolders())[0].collapsed).toBe(true);
  });

  test("Enter saves a space's new name", async () => {
    s.$("#space-label").dispatchEvent(new s.win.MouseEvent("dblclick", { bubbles: true }));
    await s.redraw();
    s.$("#space-label .rename").value = "Personal";
    s.key(s.$("#space-label .rename"), "Enter");
    await s.redraw();
    expect((await ZF.loadSpaces())[0].name).toBe("Personal");
  });

  test("a tab dragged in from another window shows up", async () => {
    const other = await env.browser.windows.create({ url: "https://elsewhere.test/" });
    await s.redraw();
    await env.browser.tabs.move(other.tabs[0].id, { windowId: W, index: -1 });
    await s.redraw();
    expect(s.row(other.tabs[0].id)).not.toBeNull();
  });
});
