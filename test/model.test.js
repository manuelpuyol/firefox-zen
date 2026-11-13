"use strict";

// Run with: node --test test/

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadModel } = require("./browser-mock");

const W = 1;

// Values made inside the model's vm context have that context's Array and
// Object; compare plain copies.
const plainCopy = value => JSON.parse(JSON.stringify(value));
const eq = (actual, expected, message) => assert.deepEqual(plainCopy(actual), plainCopy(expected), message);

// A window with regular tabs a, b, c (c active), as Firefox opens them.
async function setUp(options) {
  const env = loadModel(options);
  const { browser } = env;
  const open = async (url, extra = {}) => (await browser.tabs.create({ windowId: W, url, active: false, ...extra })).id;
  const a = await open("https://a.test/");
  const b = await open("https://b.test/");
  const c = await open("https://c.test/");
  await browser.tabs.update(c, { active: true });
  return { ...env, open, a, b, c };
}

const visible = env => env.tabs.filter(t => !t.hidden && !t.pinned).map(t => t.id).sort((x, y) => x - y);
const regularIds = view => view.regular.map(t => t.id);

test("creating a space switches to it and hides the previous space's tabs", async () => {
  const env = await setUp();
  const { ZF, a, b, c } = env;
  const work = await ZF.createSpace(W, { name: "Work", icon: "💼" });
  const view = await ZF.buildView(W);
  assert.equal(view.spaceId, work.id);
  assert.equal(view.space.name, "Work");
  // The empty space got a new tab, which is the only visible one.
  assert.equal(view.regular.length, 1);
  eq(visible(env), [view.regular[0].id]);
  for (const id of [a, b, c]) assert.equal(env.find(id).hidden, true);
  // The previous tabs were tagged with Home before the switch.
  assert.equal(await env.browser.sessions.getTabValue(a, ZF.SPACE_KEY), "home");
});

test("new tabs join the shown space; switching back goes to the space's last used tab", async () => {
  const env = await setUp();
  const { ZF, a, b, c, open } = env;
  const work = await ZF.createSpace(W);
  const x = await open("https://x.test/");
  assert.ok(regularIds(await ZF.buildView(W)).includes(x));
  await env.browser.tabs.update(b, { active: true }).catch(() => {});
  await ZF.switchSpace(W, "home");
  const view = await ZF.buildView(W);
  eq(regularIds(view).sort(), [a, b, c].sort());
  assert.equal(env.find(x).hidden, true);
  // b was the most recently used Home tab.
  assert.equal(view.activeId, b);
  await ZF.switchSpace(W, work.id);
  assert.ok(regularIds(await ZF.buildView(W)).includes(x));
});

test("folders belong to a space; a tab whose folder is elsewhere shows at the top level", async () => {
  const env = await setUp();
  const { ZF, a } = env;
  const homeFolder = await ZF.createFolder("Home folder", null, "home");
  await ZF.moveItems(W, [{ kind: "tab", id: a }], homeFolder.id);
  const work = await ZF.createSpace(W);
  const workFolder = await ZF.createFolder("Work folder", null, work.id);
  const sub = await ZF.createFolder("Sub", workFolder.id);
  const view = await ZF.buildView(W);
  eq(view.folders.map(f => f.name).sort(), ["Sub", "Work folder"]);
  assert.equal(ZF.folderSpace(view.folders, sub, view.spaces), work.id);
  // Tag a with Work while it still points at Home's folder.
  await ZF.setMeta(a, ZF.SPACE_KEY, work.id);
  await ZF.showSpaceIn(W);
  const after = await ZF.buildView(W);
  eq(after.byPlace.get(ZF.ROOT).map(t => t.id), [a]);
});

test("a sharing tab from another space is listed but never cleared or reordered", async () => {
  const env = await setUp();
  const { ZF, a, b, c, open } = env;
  const work = await ZF.createSpace(W);
  const call = await open("https://meet.test/");
  await ZF.switchSpace(W, "home");
  // Firefox can't hide it while it's sharing.
  Object.assign(env.find(call), { hidden: false, sharingState: { camera: true } });
  const view = await ZF.buildView(W);
  const listed = view.regular.find(t => t.id === call);
  assert.equal(listed.zfForeignSpace.id, work.id);
  assert.ok(!ZF.desiredOrder(view).includes(call));
  // Clear asked in another space does nothing.
  assert.equal(await ZF.clearRegular(W, work.id), 0);
  await ZF.clearRegular(W, "home");
  assert.ok(env.find(call), "the call survives Clear");
  for (const id of [a, b, c]) assert.equal(env.find(id), undefined);
});

test("only a drag (claim) brings another space's listed tab into the shown space", async () => {
  const env = await setUp();
  const { ZF, a, b, open } = env;
  const work = await ZF.createSpace(W);
  const call = await open("https://meet.test/");
  await ZF.switchSpace(W, "home");
  Object.assign(env.find(call), { hidden: false, sharingState: { camera: true } });
  await ZF.moveTabs([call], ZF.ROOT);
  assert.equal(await env.browser.sessions.getTabValue(call, ZF.SPACE_KEY), work.id, "Keep leaves its space");
  await ZF.moveTabs([call], null, { beforeId: a, claim: true });
  assert.equal(await env.browser.sessions.getTabValue(call, ZF.SPACE_KEY), "home");
  // Now it's an ordinary Home tab, placed where it was dropped.
  eq(regularIds(await ZF.buildView(W)).slice(0, 2), [call, a]);
  void b;
});

test("dropping next to another space's listed tab uses this space's nearest neighbour", async () => {
  const env = await setUp();
  const { ZF, a, b, c, open } = env;
  await ZF.createSpace(W);
  const call = await open("https://meet.test/");
  await ZF.switchSpace(W, "home");
  Object.assign(env.find(call), { hidden: false, sharingState: { camera: true } });
  // Order on screen: a b c call. Drop a just after the call (the last row).
  await ZF.moveTabs([a], null, { afterId: call });
  const home = regularIds(await ZF.buildView(W)).filter(id => id !== call);
  eq(home, [b, c, a]);
  // Drop c just before the call: right after b, not at the end.
  await ZF.moveTabs([a], null, { beforeId: b });
  await ZF.moveTabs([c], null, { beforeId: call });
  eq(regularIds(await ZF.buildView(W)).filter(id => id !== call), [a, b, c]);
});

test("deleting a space moves its tabs and folders to its neighbour", async () => {
  const env = await setUp();
  const { ZF, a, open } = env;
  const work = await ZF.createSpace(W);
  const x = await open("https://x.test/");
  const folder = await ZF.createFolder("Work folder", null, work.id);
  await ZF.deleteSpace(work.id);
  const view = await ZF.buildView(W);
  assert.equal(view.spaceId, "home");
  eq(view.spaces.map(s => s.id), ["home"]);
  assert.ok(regularIds(view).includes(x) && regularIds(view).includes(a));
  assert.ok(view.folders.some(f => f.id === folder.id));
  eq(visible(env).length, env.tabs.length);
  // The last space can't be deleted.
  await ZF.deleteSpace("home");
  assert.equal((await ZF.loadSpaces()).length, 1);
});

test("reordering the first space keeps unassigned folders and windows where they were", async () => {
  const env = await setUp({ windows: [1, 2] });
  const { ZF, a } = env;
  const old = await ZF.createFolder("Old folder", null, null);
  await ZF.moveItems(W, [{ kind: "tab", id: a }], old.id);
  const work = await ZF.createSpace(W);
  await ZF.moveSpace(work.id, -1);
  eq((await ZF.loadSpaces()).map(s => s.id), [work.id, "home"]);
  assert.equal(await ZF.activeSpaceId(2, await ZF.loadSpaces()), "home", "window 2 stays on Home");
  await ZF.switchSpace(W, "home");
  const view = await ZF.buildView(W);
  eq(view.folders.map(f => f.name), ["Old folder"]);
  eq(view.byPlace.get(old.id).map(t => t.id), [a]);
});

test("moving a kept tab to another space takes it to that space's top level", async () => {
  const env = await setUp();
  const { ZF, a } = env;
  const folder = await ZF.createFolder("Home folder", null, "home");
  await ZF.moveItems(W, [{ kind: "tab", id: a }], folder.id);
  const work = await ZF.createSpace(W);
  await ZF.switchSpace(W, "home");
  await ZF.moveTabsToSpace([a], work.id);
  assert.equal(env.find(a).hidden, true);
  await ZF.switchSpace(W, work.id);
  const view = await ZF.buildView(W);
  eq(view.byPlace.get(ZF.ROOT).map(t => t.id), [a]);
});

test("moving a folder to another space takes its subfolders and tabs along", async () => {
  const env = await setUp();
  const { ZF, a, b } = env;
  const parent = await ZF.createFolder("Parent", null, "home");
  const child = await ZF.createFolder("Child", parent.id);
  await ZF.moveItems(W, [{ kind: "tab", id: a }], parent.id);
  await ZF.moveItems(W, [{ kind: "tab", id: b }], child.id);
  const work = await ZF.createSpace(W);
  await ZF.switchSpace(W, "home");
  await ZF.moveFolderToSpace(parent.id, work.id);
  assert.equal(env.find(a).hidden, true);
  assert.equal(env.find(b).hidden, true);
  await ZF.switchSpace(W, work.id);
  const view = await ZF.buildView(W);
  eq(view.folders.map(f => f.name).sort(), ["Child", "Parent"]);
  eq(view.byPlace.get(child.id).map(t => t.id), [b]);
});

test("hiding retries without tabs that closed, and reports a lasting failure", async () => {
  const env = await setUp();
  const { ZF } = env;
  const work = await ZF.createSpace(W);
  await ZF.switchSpace(W, "home");
  let failures = 0;
  ZF.onHideFailed = () => failures++;

  // Fails once (as when a tab closes mid-call): the retry succeeds.
  let fail = 1;
  env.faults.hide = () => fail-- > 0;
  await ZF.switchSpace(W, work.id);
  assert.equal(failures, 0);
  assert.equal(env.calls.hide.length >= 2, true);
  eq(visible(env).length, 1);

  // Fails every time: reported, and showAllSpaces says so.
  env.faults.hide = () => true;
  await ZF.switchSpace(W, "home");
  assert.equal(failures, 1);
  assert.equal(await ZF.showAllSpaces(), false);
  env.faults.hide = null;
  assert.equal(await ZF.showAllSpaces(), true);
});

test("Firefox's tab order follows the sidebar: kept tabs first, then regular", async () => {
  const env = await setUp();
  const { ZF, a, b, c } = env;
  const folder = await ZF.createFolder("Folder", null, "home");
  await ZF.moveItems(W, [{ kind: "tab", id: c }], folder.id);
  await ZF.moveItems(W, [{ kind: "tab", id: a }], folder.id, { anchor: { kind: "tab", id: c } });
  const order = env.tabs.filter(t => !t.pinned).sort((x, y) => x.index - y.index).map(t => t.id);
  eq(order, [a, c, b]);
});

test("backups round-trip spaces, folders and each tab's space", async () => {
  const env = await setUp();
  const { ZF, plain, a, open } = env;
  const homeFolder = await ZF.createFolder("Home folder", null, "home");
  await ZF.moveItems(W, [{ kind: "tab", id: a }], homeFolder.id);
  const work = await ZF.createSpace(W, { name: "Work", icon: "🚀" });
  await ZF.updateSpace(work.id, { background: "ocean" });
  const x = await open("https://x.test/");
  const workFolder = await ZF.createFolder("Work folder", null, work.id);
  await ZF.moveItems(W, [{ kind: "tab", id: x }], workFolder.id);

  const backup = plain(await ZF.exportFolders());
  assert.equal(backup.version, 2);
  eq(backup.spaces.map(s => [s.name, s.icon, s.background]), [["Home", "🏠", null], ["Work", "🚀", "ocean"]]);

  // Restoring into the same profile duplicates nothing.
  const again = await ZF.restoreFolders(backup);
  eq([again.spacesCreated, again.foldersCreated, again.foldersMatched], [0, 0, 2]);

  // Into a profile that forgot everything: spaces, folders and memberships come back.
  delete env.local.spaces;
  delete env.local.folders;
  for (const id of [a, x]) for (const key of [ZF.SPACE_KEY, ZF.FOLDER_KEY, ZF.ORDER_KEY]) await env.browser.sessions.removeTabValue(id, key);
  const fresh = await ZF.restoreFolders(backup);
  assert.equal(fresh.spacesCreated, 1);
  const spaces = await ZF.loadSpaces();
  const restoredWork = spaces.find(s => s.name === "Work");
  assert.equal(restoredWork.background, "ocean");
  assert.equal(await env.browser.sessions.getTabValue(x, ZF.SPACE_KEY), restoredWork.id);
  assert.equal(await env.browser.sessions.getTabValue(a, ZF.SPACE_KEY), "home");
  const folders = await ZF.loadFolders();
  const space = name => ZF.folderSpace(folders, folders.find(f => f.name === name), spaces);
  assert.equal(space("Work folder"), restoredWork.id);
  assert.equal(space("Home folder"), "home");
});

test("backup files are checked before anything changes", () => {
  const { ZF } = loadModel();
  const base = { format: ZF.BACKUP_FORMAT, folders: [], tabs: [], essentials: [] };
  assert.doesNotThrow(() => ZF.parseBackup({ ...base, version: 1 }));
  assert.throws(() => ZF.parseBackup({ ...base, version: 3 }), /unknown format/);
  assert.throws(() => ZF.parseBackup({ ...base, version: 2, spaces: [{ id: "s", name: "A" }, { id: "s", name: "B" }] }), /duplicate space ids/);
  const parsed = ZF.parseBackup({
    ...base,
    version: 2,
    spaces: [{ id: "s", name: "  Work  ", icon: "not an icon", background: "neon" }],
    folders: [{ id: "f", name: "F", parentId: null, spaceId: "missing" }],
  });
  eq([parsed.spaces[0].name, parsed.spaces[0].icon, parsed.spaces[0].background], ["Work", ZF.SPACE_ICONS[0], null]);
  // A space the file doesn't define means the current one.
  assert.equal(parsed.folders[0].spaceId, null);
});

test("spaces come back from the session backup when the extension's storage is wiped", async () => {
  const env = await setUp();
  const { ZF } = env;
  const work = await ZF.createSpace(W, { name: "Work" });
  delete env.local.spaces;
  eq((await ZF.loadSpaces()).map(s => s.id), ["home"]);
  const report = await ZF.restoreFoldersIfMissing();
  assert.equal(report.restoredSpaces, 2);
  eq((await ZF.loadSpaces()).map(s => s.id), ["home", work.id]);
  assert.equal(await ZF.activeSpaceId(W, await ZF.loadSpaces()), work.id);
});
