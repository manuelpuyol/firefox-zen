// The sidebar page in happy-dom, talking to the real background script.

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createFirefox, loadBackground, loadPage } from "../support/firefox.js";

const W = 1;
let env, ZF, win, doc;

async function open(setup = async () => {}) {
  env = createFirefox();
  await setup();
  ZF = loadBackground(env).ZF;
  await env.events.runtime.onInstalled.trigger({ reason: "install" });
  await env.settle();
  win = await loadPage(env, "sidebar/sidebar.html");
  doc = win.document;
  await redraw();
}

// Renders are debounced by 50 ms.
const redraw = () => env.settle(150);
const $ = selector => doc.querySelector(selector);
const $$ = selector => [...doc.querySelectorAll(selector)];
const titles = selector => $$(`${selector} .title`).map(n => n.textContent);
const row = id => $(`.row[data-tab-id="${id}"]`);
const click = (node, init = {}) => node.dispatchEvent(new win.MouseEvent("click", { bubbles: true, ...init }));
const activeSpace = async () => ZF.activeSpaceId(W, await ZF.loadSpaces());

afterEach(async () => {
  await win?.happyDOM.close();
  win = null;
});

describe("the list", () => {
  let mail, docs, news;
  beforeEach(async () => {
    await open(async () => {
      mail = await env.open("https://mail.test/", { pinned: true, title: "Mail" });
      docs = await env.open("https://docs.test/", { title: "Docs" });
      news = await env.open("https://news.test/", { title: "News" });
    });
  });

  test("shows Essentials, kept tabs in folders, and regular tabs", async () => {
    const folder = await ZF.createFolder("Work", null, "home");
    await ZF.moveTabs([docs], folder.id);
    await redraw();
    expect($$("#essentials .tile").map(t => Number(t.dataset.tabId))).toEqual([mail]);
    expect(titles("#pinned")).toEqual(["Work", "Docs"]);
    expect($(`[data-folder-id="${folder.id}"] .count`).textContent).toBe("+1");
    expect(titles("#regular")).toEqual(["News"]);
  });

  test("clicking a tab switches to it; the close button closes a regular tab", async () => {
    click(row(news).querySelector(".title"));
    await redraw();
    expect(env.find(news).active).toBe(true);
    expect(row(news).classList.contains("active")).toBe(true);
    click(row(docs).querySelector(".close"));
    await redraw();
    expect(env.find(docs)).toBeUndefined();
    expect(row(docs)).toBeNull();
  });

  test("closing a kept tab unloads it first; middle-click does the same", async () => {
    await ZF.moveTabs([docs], ZF.ROOT);
    await redraw();
    doc.querySelector(`.row[data-tab-id="${docs}"]`).dispatchEvent(new win.MouseEvent("auxclick", { bubbles: true, button: 1 }));
    await redraw();
    expect(env.find(docs).discarded).toBe(true);
    click(row(docs).querySelector(".close"));
    await redraw();
    expect(env.find(docs)).toBeUndefined();
  });

  test("folders open and close, one at a time or all at once", async () => {
    const a = await ZF.createFolder("A", null, "home");
    await ZF.createFolder("B", null, "home");
    await redraw();
    expect($("#collapse-all").textContent).toBe("Collapse all");
    click($(`.row[data-folder-id="${a.id}"]`));
    await redraw();
    expect((await ZF.loadFolders()).find(f => f.id === a.id).collapsed).toBe(true);
    click($("#collapse-all"));
    await redraw();
    expect((await ZF.loadFolders()).every(f => f.collapsed)).toBe(true);
    expect($("#collapse-all").textContent).toBe("Expand all");
  });

  test("Clear asks first, then closes this space's regular tabs", async () => {
    click($("#clear"));
    expect($("#clear").textContent).toBe("Close 2 tabs?");
    expect(env.find(news)).toBeDefined();
    click($("#clear"));
    await redraw();
    // Only Essentials are left; the first one becomes the active tab.
    expect(env.tabs.filter(t => !t.pinned)).toEqual([]);
    expect(env.find(mail).active).toBe(true);
    expect($$("#regular .row")).toHaveLength(0);
  });

  test("the hide button closes the sidebar and the gear opens settings", async () => {
    click($("#hide-sidebar"));
    click($("#settings"));
    expect(env.calls.sidebarClosed).toBe(1);
    expect(env.calls.optionsOpened).toBe(1);
  });

  test("renaming a folder from the background's request", async () => {
    const folder = await ZF.createFolder("Untitled", null, "home");
    await env.browser.runtime.sendMessage({ type: "zf-rename", windowId: W, folderId: folder.id });
    await redraw();
    const input = $(`[data-rename-for="${folder.id}"]`);
    expect(input).not.toBeNull();
    input.value = "Reading";
    input.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await redraw();
    expect((await ZF.loadFolders())[0].name).toBe("Reading");
    expect(titles("#pinned")).toContain("Reading");
  });
});

describe("spaces", () => {
  let a;
  beforeEach(async () => {
    await open(async () => {
      a = await env.open("https://a.test/", { title: "A" });
    });
  });

  const createSpace = async ({ name, icon } = {}) => {
    click($("#new-space"));
    expect($("#space-dialog").open).toBe(true);
    if (name !== undefined) $("#space-name").value = name;
    if (icon) click($(`#space-icons [data-icon="${icon}"]`));
    const submit = $('#space-dialog button[value="create"]');
    $("#space-dialog").close(submit.value);
    await redraw();
  };

  test("with one space there's no switcher, only the + button", async () => {
    expect($$("#spaces .space")).toHaveLength(0);
    expect($("#new-space")).not.toBeNull();
    expect($("#space-label").textContent).toContain("Home");
  });

  test("New Space asks for a name and icon, then switches to the new space", async () => {
    click($("#new-space"));
    expect($("#space-name").placeholder).toBe("Space 2");
    // The first icon no space uses yet starts selected.
    expect($("#space-icons .selected").dataset.icon).not.toBe("🏠");
    $("#space-dialog").close();
    await createSpace({ name: "Side project", icon: "🎨" });
    const spaces = await ZF.loadSpaces();
    expect(spaces.map(s => [s.name, s.icon])).toEqual([["Home", "🏠"], ["Side project", "🎨"]]);
    expect($$("#spaces .space").map(b => b.textContent)).toEqual(["🏠", "🎨"]);
    expect($("#spaces .space.active").dataset.spaceId).toBe(spaces[1].id);
    expect($("#space-label").textContent).toContain("Side project");
    // The earlier tabs stay in Home, hidden; the new space gets a fresh tab.
    expect(env.find(a).hidden).toBe(true);
    expect(row(a)).toBeNull();
  });

  test("cancelling, or clicking outside the dialog, creates nothing", async () => {
    click($("#new-space"));
    click($("#space-cancel"));
    expect($("#space-dialog").open).toBe(false);
    click($("#new-space"));
    click($("#space-dialog"));
    expect($("#space-dialog").open).toBe(false);
    await redraw();
    expect(await ZF.loadSpaces()).toHaveLength(1);
  });

  test("clicking a space in the switcher shows its tabs", async () => {
    await createSpace({ name: "Work" });
    click($('#spaces [data-space-id="home"]'));
    await redraw();
    expect(await activeSpace()).toBe("home");
    expect($("#spaces .space.active").dataset.spaceId).toBe("home");
    expect(titles("#regular")).toEqual(["A"]);
    expect(env.find(a).hidden).toBe(false);
  });

  test("a horizontal swipe switches space once per swipe", async () => {
    await createSpace({ name: "Work" });
    const wheel = deltaX => $("#scroll").dispatchEvent(new win.WheelEvent("wheel", { deltaX, deltaY: 0, bubbles: true, cancelable: true }));
    for (let i = 0; i < 6; i++) wheel(-40);
    await redraw();
    expect(await activeSpace()).toBe("home");
    // Vertical scrolling doesn't switch.
    $("#scroll").dispatchEvent(new win.WheelEvent("wheel", { deltaX: 10, deltaY: 200, bubbles: true }));
    await new Promise(r => setTimeout(r, 300));
    await redraw();
    expect(await activeSpace()).toBe("home");
  });

  test("double-clicking the space name renames it; pressing elsewhere saves", async () => {
    $("#space-label").dispatchEvent(new win.MouseEvent("dblclick", { bubbles: true }));
    await redraw();
    const input = $("#space-label .rename");
    expect(input.value).toBe("Home");
    input.value = "Personal";
    // macOS: a click on a button doesn't blur the box, so pointerdown ends it.
    $("#new-tab").dispatchEvent(new win.PointerEvent("pointerdown", { bubbles: true }));
    win.dispatchEvent(new win.PointerEvent("pointerup", { bubbles: true }));
    await redraw();
    expect((await ZF.loadSpaces())[0].name).toBe("Personal");
    expect($("#space-label .rename")).toBeNull();
    expect($("#space-label").textContent).toContain("Personal");
  });

  test("the list keeps updating while a space is being renamed", async () => {
    $("#space-label").dispatchEvent(new win.MouseEvent("dblclick", { bubbles: true }));
    await redraw();
    await env.open("https://b.test/", { title: "B" });
    await redraw();
    expect(titles("#regular")).toContain("B");
    expect($("#space-label .rename")).not.toBeNull();
  });

  test("a Clear confirmation doesn't carry over to another space", async () => {
    await createSpace({ name: "Work" });
    click($('#spaces [data-space-id="home"]'));
    await redraw();
    click($("#clear"));
    expect($("#clear").classList.contains("confirming")).toBe(true);
    const work = (await ZF.loadSpaces())[1];
    click($(`#spaces [data-space-id="${work.id}"]`));
    await redraw();
    expect($("#clear").classList.contains("confirming")).toBe(false);
    click($("#clear"));
    expect(env.find(a)).toBeDefined();
  });

  test("another space's tab that's sharing is listed here with its space's icon", async () => {
    await createSpace({ name: "Calls", icon: "💬" });
    const call = await env.open("https://meet.test/", { title: "Meet" });
    click($('#spaces [data-space-id="home"]'));
    await redraw();
    Object.assign(env.find(call), { hidden: false, sharingState: { camera: true } });
    env.events.tabs.onUpdated.emit(call, { sharingState: { camera: true } }, { ...env.find(call) });
    await redraw();
    expect(titles("#regular")).toEqual(["A", "Meet"]);
    expect(row(call).querySelector(".space-badge").textContent).toBe("💬");
    // Clear leaves it alone.
    expect($("#clear").textContent).toBe("↓ Clear");
    click($("#clear"));
    expect($("#clear").textContent).toBe("Close 1 tab?");
  });
});
