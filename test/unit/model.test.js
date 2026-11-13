// lib/model.js: spaces, folders, tab order, Clear and backups.

import { describe, test, expect, beforeEach } from "vitest";
import { createFirefox, loadModel, plain } from "../support/firefox.js";

const W = 1;
let env, ZF, a, b, c;

// A window with regular tabs a, b, c (c active).
beforeEach(async () => {
  env = createFirefox();
  ({ ZF } = loadModel(env));
  a = await env.open("https://a.test/");
  b = await env.open("https://b.test/");
  c = await env.open("https://c.test/");
  await env.browser.tabs.update(c, { active: true });
});

const visible = () => env.tabs.filter(t => !t.hidden && !t.pinned).map(t => t.id).sort((x, y) => x - y);
const regular = async () => plain((await ZF.buildView(W)).regular.map(t => t.id));
const tag = id => env.browser.sessions.getTabValue(id, ZF.SPACE_KEY);
const share = id => Object.assign(env.find(id), { hidden: false, sharingState: { camera: true } });

describe("spaces", () => {
  test("creating a space switches to it and hides the previous space's tabs", async () => {
    const work = await ZF.createSpace(W, { name: "Work", icon: "💼" });
    const view = await ZF.buildView(W);
    expect(view.spaceId).toBe(work.id);
    expect(view.space.name).toBe("Work");
    expect(view.regular).toHaveLength(1);
    expect(visible()).toEqual([view.regular[0].id]);
    for (const id of [a, b, c]) expect(env.find(id).hidden).toBe(true);
    expect(await tag(a)).toBe("home");
  });

  test("new space names and icons are cleaned up, with a default for each", async () => {
    const named = await ZF.createSpace(null, { name: "  Work  ", icon: "🚀" });
    const plainOne = await ZF.createSpace(null, { name: " ", icon: "not an icon" });
    expect([named.name, named.icon]).toEqual(["Work", "🚀"]);
    expect(plainOne.name).toBe("Space 3");
    expect(ZF.SPACE_ICONS).toContain(plainOne.icon);
    expect(plainOne.icon).not.toBe("🏠");
  });

  test("new tabs join the shown space; switching back goes to the space's last used tab", async () => {
    const work = await ZF.createSpace(W);
    const x = await env.open("https://x.test/");
    expect(await regular()).toContain(x);
    await env.browser.tabs.update(b, { active: true });
    await ZF.switchSpace(W, "home");
    const view = await ZF.buildView(W);
    expect(plain(view.regular.map(t => t.id)).sort()).toEqual([a, b, c].sort());
    expect(env.find(x).hidden).toBe(true);
    expect(view.activeId).toBe(b);
    await ZF.switchSpace(W, work.id);
    expect(await regular()).toContain(x);
  });

  test("switching by one stops at the ends", async () => {
    const work = await ZF.createSpace(W);
    await ZF.switchSpaceBy(W, 1);
    expect(await ZF.activeSpaceId(W, await ZF.loadSpaces())).toBe(work.id);
    await ZF.switchSpaceBy(W, -1);
    await ZF.switchSpaceBy(W, -1);
    expect(await ZF.activeSpaceId(W, await ZF.loadSpaces())).toBe("home");
  });

  test("folders belong to a space; a tab whose folder is elsewhere shows at the top level", async () => {
    const homeFolder = await ZF.createFolder("Home folder", null, "home");
    await ZF.moveItems(W, [{ kind: "tab", id: a }], homeFolder.id);
    const work = await ZF.createSpace(W);
    const workFolder = await ZF.createFolder("Work folder", null, work.id);
    const sub = await ZF.createFolder("Sub", workFolder.id);
    const view = await ZF.buildView(W);
    expect(plain(view.folders.map(f => f.name)).sort()).toEqual(["Sub", "Work folder"]);
    expect(ZF.folderSpace(view.folders, sub, view.spaces)).toBe(work.id);
    await ZF.setMeta(a, ZF.SPACE_KEY, work.id);
    await ZF.showSpaceIn(W);
    expect(plain((await ZF.buildView(W)).byPlace.get(ZF.ROOT).map(t => t.id))).toEqual([a]);
  });

  test("deleting a space moves its tabs and folders to its neighbour", async () => {
    const work = await ZF.createSpace(W);
    const x = await env.open("https://x.test/");
    const folder = await ZF.createFolder("Work folder", null, work.id);
    await ZF.deleteSpace(work.id);
    const view = await ZF.buildView(W);
    expect(view.spaceId).toBe("home");
    expect(plain(view.spaces.map(s => s.id))).toEqual(["home"]);
    expect(await regular()).toEqual(expect.arrayContaining([x, a]));
    expect(view.folders.some(f => f.id === folder.id)).toBe(true);
    expect(visible()).toHaveLength(env.tabs.length);
    await ZF.deleteSpace("home");
    expect(await ZF.loadSpaces()).toHaveLength(1);
  });

  test("reordering the first space keeps unassigned folders and windows where they were", async () => {
    env = createFirefox({ windows: [1, 2] });
    ({ ZF } = loadModel(env));
    a = await env.open("https://a.test/");
    const old = await ZF.createFolder("Old folder", null, null);
    await ZF.moveItems(W, [{ kind: "tab", id: a }], old.id);
    const work = await ZF.createSpace(W);
    await ZF.moveSpace(work.id, -1);
    expect(plain((await ZF.loadSpaces()).map(s => s.id))).toEqual([work.id, "home"]);
    expect(await ZF.activeSpaceId(2, await ZF.loadSpaces())).toBe("home");
    await ZF.switchSpace(W, "home");
    const view = await ZF.buildView(W);
    expect(plain(view.folders.map(f => f.name))).toEqual(["Old folder"]);
    expect(plain(view.byPlace.get(old.id).map(t => t.id))).toEqual([a]);
  });

  test("renaming, icons and backgrounds are validated", async () => {
    const work = await ZF.createSpace(null);
    await ZF.updateSpace(work.id, { name: "  Deep work ", icon: "🔥", background: "ocean" });
    await ZF.updateSpace(work.id, { name: "   ", icon: "nope", background: "neon" });
    const saved = (await ZF.loadSpaces()).find(s => s.id === work.id);
    expect([saved.name, saved.icon, saved.background]).toEqual(["Deep work", "🔥", null]);
  });

  test("moving a kept tab to another space takes it to that space's top level", async () => {
    const folder = await ZF.createFolder("Home folder", null, "home");
    await ZF.moveItems(W, [{ kind: "tab", id: a }], folder.id);
    const work = await ZF.createSpace(W);
    await ZF.switchSpace(W, "home");
    await ZF.moveTabsToSpace([a], work.id);
    expect(env.find(a).hidden).toBe(true);
    await ZF.switchSpace(W, work.id);
    expect(plain((await ZF.buildView(W)).byPlace.get(ZF.ROOT).map(t => t.id))).toEqual([a]);
  });

  test("moving a folder to another space takes its subfolders and tabs along", async () => {
    const parent = await ZF.createFolder("Parent", null, "home");
    const child = await ZF.createFolder("Child", parent.id);
    await ZF.moveItems(W, [{ kind: "tab", id: a }], parent.id);
    await ZF.moveItems(W, [{ kind: "tab", id: b }], child.id);
    const work = await ZF.createSpace(W);
    await ZF.switchSpace(W, "home");
    await ZF.moveFolderToSpace(parent.id, work.id);
    expect([env.find(a).hidden, env.find(b).hidden]).toEqual([true, true]);
    await ZF.switchSpace(W, work.id);
    const view = await ZF.buildView(W);
    expect(plain(view.folders.map(f => f.name)).sort()).toEqual(["Child", "Parent"]);
    expect(plain(view.byPlace.get(child.id).map(t => t.id))).toEqual([b]);
  });

  test("a tab from another window joins this window's space", async () => {
    env = createFirefox({ windows: [1, 2] });
    ({ ZF } = loadModel(env));
    a = await env.open("https://a.test/");
    const folder = await ZF.createFolder("F", null, "home");
    await ZF.moveItems(W, [{ kind: "tab", id: a }], folder.id);
    const work = await ZF.createSpace(2);
    await env.browser.tabs.move(a, { windowId: 2, index: -1 });
    await ZF.adoptTab(a, 2);
    const view = await ZF.buildView(2);
    expect(view.spaceId).toBe(work.id);
    expect(plain(view.byPlace.get(ZF.ROOT).map(t => t.id))).toEqual([a]);
  });

  test("hiding retries without tabs that closed, and reports a lasting failure", async () => {
    const work = await ZF.createSpace(W);
    await ZF.switchSpace(W, "home");
    let failures = 0;
    ZF.onHideFailed = () => failures++;
    let fail = 1;
    env.faults.hide = () => fail-- > 0;
    await ZF.switchSpace(W, work.id);
    expect(failures).toBe(0);
    expect(visible()).toHaveLength(1);
    env.faults.hide = () => true;
    await ZF.switchSpace(W, "home");
    expect(failures).toBe(1);
    expect(await ZF.showAllSpaces()).toBe(false);
    env.faults.hide = null;
    expect(await ZF.showAllSpaces()).toBe(true);
  });
});

describe("sharing tabs from another space", () => {
  let work, call;
  beforeEach(async () => {
    work = await ZF.createSpace(W);
    call = await env.open("https://meet.test/");
    await ZF.switchSpace(W, "home");
    share(call);
  });

  test("are listed and marked, but left out of the tab order and Clear", async () => {
    const view = await ZF.buildView(W);
    expect(view.regular.find(t => t.id === call).zfForeignSpace.id).toBe(work.id);
    expect(plain(ZF.desiredOrder(view))).not.toContain(call);
    expect(await ZF.clearRegular(W, work.id)).toBe(0);
    await ZF.clearRegular(W, "home");
    expect(env.find(call)).toBeDefined();
    for (const id of [a, b, c]) expect(env.find(id)).toBeUndefined();
  });

  test("only a drag (claim) brings one into the shown space", async () => {
    await ZF.moveTabs([call], ZF.ROOT);
    expect(await tag(call)).toBe(work.id);
    await ZF.moveTabs([call], null, { beforeId: a, claim: true });
    expect(await tag(call)).toBe("home");
    expect((await regular()).slice(0, 2)).toEqual([call, a]);
  });

  test("a drop next to one uses this space's nearest neighbour", async () => {
    await ZF.moveTabs([a], null, { afterId: call });
    expect((await regular()).filter(id => id !== call)).toEqual([b, c, a]);
    await ZF.moveTabs([a], null, { beforeId: b });
    await ZF.moveTabs([c], null, { beforeId: call });
    expect((await regular()).filter(id => id !== call)).toEqual([a, b, c]);
  });
});

describe("folders and tab order", () => {
  test("Firefox's tab order follows the sidebar: kept tabs first, then regular", async () => {
    const folder = await ZF.createFolder("Folder", null, "home");
    await ZF.moveItems(W, [{ kind: "tab", id: c }], folder.id);
    await ZF.moveItems(W, [{ kind: "tab", id: a }], folder.id, { anchor: { kind: "tab", id: c } });
    expect(env.tabs.filter(t => !t.pinned).sort((x, y) => x.index - y.index).map(t => t.id)).toEqual([a, c, b]);
  });

  test("subfolders sit among a folder's tabs and can't go inside themselves", async () => {
    const parent = await ZF.createFolder("Parent", null, "home");
    const child = await ZF.createFolder("Child", parent.id);
    await ZF.moveItems(W, [{ kind: "tab", id: a }, { kind: "tab", id: b }], parent.id);
    await ZF.moveItems(W, [{ kind: "folder", id: child.id }], parent.id, { anchor: { kind: "tab", id: b } });
    const items = ZF.itemsOf(await ZF.buildView(W), parent.id).map(i => (i.kind === "tab" ? i.id : i.folder.name));
    expect(plain(items)).toEqual([a, "Child", b]);
    await ZF.moveItems(W, [{ kind: "folder", id: parent.id }], child.id);
    expect((await ZF.loadFolders()).find(f => f.id === parent.id).parentId).toBeNull();
  });

  test("removing a folder keeps its tabs and subfolders, one level up, in the same space", async () => {
    const work = await ZF.createSpace(W);
    const x = await env.open("https://x.test/");
    const parent = await ZF.createFolder("Parent", null, work.id);
    const child = await ZF.createFolder("Child", parent.id);
    await ZF.moveItems(W, [{ kind: "tab", id: x }], parent.id);
    await ZF.removeFolder(parent.id);
    const folders = await ZF.loadFolders();
    const kept = folders.find(f => f.id === child.id);
    expect(kept.parentId).toBeNull();
    expect(ZF.folderSpace(folders, kept, await ZF.loadSpaces())).toBe(work.id);
    expect(await ZF.getPlace(x)).toBe(ZF.ROOT);
  });

  test("Collapse all only touches the given folders", async () => {
    const f1 = await ZF.createFolder("One", null, "home");
    const f2 = await ZF.createFolder("Two", null, "home");
    await ZF.setAllCollapsed(true, [f1.id]);
    const folders = await ZF.loadFolders();
    expect([folders.find(f => f.id === f1.id).collapsed, folders.find(f => f.id === f2.id).collapsed]).toEqual([true, false]);
  });

  test("closing a kept tab unloads it first, then closes it; regular tabs just close", async () => {
    await ZF.moveItems(W, [{ kind: "tab", id: c }], ZF.ROOT);
    await ZF.closeOrUnload(c, await ZF.buildView(W));
    expect(env.find(c).discarded).toBe(true);
    expect(env.find(c).active).toBe(false);
    await ZF.closeOrUnload(c, await ZF.buildView(W));
    expect(env.find(c)).toBeUndefined();
    await ZF.closeOrUnload(a, await ZF.buildView(W));
    expect(env.find(a)).toBeUndefined();
  });
});

describe("backups", () => {
  test("round-trip spaces, folders and each tab's space", async () => {
    const homeFolder = await ZF.createFolder("Home folder", null, "home");
    await ZF.moveItems(W, [{ kind: "tab", id: a }], homeFolder.id);
    const work = await ZF.createSpace(W, { name: "Work", icon: "🚀" });
    await ZF.updateSpace(work.id, { background: "ocean" });
    const x = await env.open("https://x.test/");
    const workFolder = await ZF.createFolder("Work folder", null, work.id);
    await ZF.moveItems(W, [{ kind: "tab", id: x }], workFolder.id);

    const backup = plain(await ZF.exportFolders());
    expect(backup.version).toBe(2);
    expect(backup.spaces.map(s => [s.name, s.icon, s.background])).toEqual([["Home", "🏠", null], ["Work", "🚀", "ocean"]]);

    const again = await ZF.restoreFolders(backup);
    expect([again.spacesCreated, again.foldersCreated, again.foldersMatched]).toEqual([0, 0, 2]);

    await env.browser.storage.local.remove(["spaces", "folders"]);
    for (const id of [a, x]) for (const key of [ZF.SPACE_KEY, ZF.FOLDER_KEY, ZF.ORDER_KEY]) await env.browser.sessions.removeTabValue(id, key);
    const fresh = await ZF.restoreFolders(backup);
    expect(fresh.spacesCreated).toBe(1);
    const spaces = await ZF.loadSpaces();
    const restoredWork = spaces.find(s => s.name === "Work");
    expect(restoredWork.background).toBe("ocean");
    expect(await tag(x)).toBe(restoredWork.id);
    expect(await tag(a)).toBe("home");
    const folders = await ZF.loadFolders();
    const spaceOf = name => ZF.folderSpace(folders, folders.find(f => f.name === name), spaces);
    expect([spaceOf("Work folder"), spaceOf("Home folder")]).toEqual([restoredWork.id, "home"]);
  });

  test("missing kept tabs reopen unloaded, and Essentials come back pinned", async () => {
    await ZF.moveItems(W, [{ kind: "tab", id: a }], ZF.ROOT);
    await env.browser.tabs.update(b, { pinned: true });
    const backup = plain(await ZF.exportFolders());
    await env.browser.tabs.remove([a, b]);
    const report = await ZF.restoreFolders(backup);
    expect([report.tabsOpened, report.essentialsOpened]).toEqual([1, 1]);
    const reopened = env.tabs.find(t => t.url === "https://a.test/");
    expect(reopened.discarded).toBe(true);
    expect(await ZF.getPlace(reopened.id)).toBe(ZF.ROOT);
    expect(env.tabs.find(t => t.url === "https://b.test/").pinned).toBe(true);
  });

  test("files are checked before anything changes", () => {
    const base = { format: ZF.BACKUP_FORMAT, folders: [], tabs: [], essentials: [] };
    expect(() => ZF.parseBackup({ ...base, version: 1 })).not.toThrow();
    expect(() => ZF.parseBackup({ ...base, version: 3 })).toThrow(/unknown format/);
    expect(() => ZF.parseBackup({ ...base, version: 2, spaces: [{ id: "s", name: "A" }, { id: "s", name: "B" }] })).toThrow(/duplicate space ids/);
    expect(() => ZF.parseBackup({ ...base, version: 2, folders: [{ id: "f", name: "F", parentId: "f" }] })).toThrow(/loop/);
    expect(() => ZF.parseBackup({ ...base, version: 2, tabs: [{ url: "https://x.test/", place: "nowhere" }] })).toThrow(/bad tab/);
    const parsed = ZF.parseBackup({
      ...base,
      version: 2,
      spaces: [{ id: "s", name: "  Work  ", icon: "not an icon", background: "neon" }],
      folders: [{ id: "f", name: "F", parentId: null, spaceId: "missing" }],
    });
    expect([parsed.spaces[0].name, parsed.spaces[0].icon, parsed.spaces[0].background]).toEqual(["Work", ZF.SPACE_ICONS[0], null]);
    expect(parsed.folders[0].spaceId).toBeNull();
  });

  test("spaces and folders come back from the session when storage is wiped", async () => {
    const work = await ZF.createSpace(W, { name: "Work" });
    await ZF.createFolder("Kept", null, work.id);
    await env.browser.storage.local.remove(["spaces", "folders"]);
    expect(plain((await ZF.loadSpaces()).map(s => s.id))).toEqual(["home"]);
    const report = await ZF.restoreFoldersIfMissing();
    expect([report.restoredSpaces, report.restoredFromBackup]).toEqual([2, 1]);
    expect(plain((await ZF.loadSpaces()).map(s => s.id))).toEqual(["home", work.id]);
  });

  test("tabs pointing at a lost folder get a Recovered folder in their space", async () => {
    const work = await ZF.createSpace(W);
    const x = await env.open("https://x.test/");
    await ZF.setMeta(x, ZF.FOLDER_KEY, "gone");
    await ZF.setMeta(x, ZF.SPACE_KEY, work.id);
    const report = await ZF.restoreFoldersIfMissing();
    expect(report.recoveredFolders).toBe(1);
    const recovered = (await ZF.loadFolders()).find(f => f.id === "gone");
    expect([recovered.name, recovered.spaceId]).toEqual(["Recovered folder 1", work.id]);
  });
});
