// The settings page in happy-dom, talking to the real background script.

import { test, expect, beforeEach, afterEach } from "vitest";
import { createFirefox, loadBackground, loadPage, MANIFEST } from "../support/firefox.js";

let env, ZF, win, doc;

beforeEach(async () => {
  env = createFirefox();
  ZF = loadBackground(env).ZF;
  await env.events.runtime.onInstalled.trigger({ reason: "install" });
  await env.settle();
  win = await loadPage(env, "options/options.html");
  doc = win.document;
  await env.settle(60);
});

afterEach(async () => {
  await win.happyDOM.close();
});

const setting = name => doc.querySelector(`[data-setting="${name}"]`);
const change = (input, value) => {
  if (input.type === "checkbox") input.checked = value;
  else input.value = String(value);
  input.dispatchEvent(new win.Event("change", { bubbles: true }));
};
const chooseFile = async (input, json) => {
  Object.defineProperty(input, "files", { configurable: true, value: [new win.File([JSON.stringify(json)], "backup.json")] });
  input.dispatchEvent(new win.Event("change", { bubbles: true }));
  await env.settle(90);
};

test("controls show the stored settings and save changes", async () => {
  expect(setting("autoUnload.enabled").checked).toBe(true);
  expect(setting("autoUnload.staleMinutes").value).toBe("60");
  change(setting("autoUnload.staleMinutes"), 120);
  change(setting("sidebar.showCounts"), false);
  await env.settle(60);
  const s = await ZF.getSettings();
  expect([s.autoUnload.staleMinutes, s.sidebar.showCounts]).toEqual([120, false]);
  // Options that depend on a switch grey out when it's off.
  change(setting("autoUnload.enabled"), false);
  await env.settle(60);
  expect(doc.querySelector('[data-depends="autoUnload.enabled"]').classList.contains("disabled")).toBe(true);
});

test("a value stored outside the presets stays selectable", async () => {
  await ZF.updateSettings("autoUnload", { staleMinutes: 7 });
  await env.settle(60);
  expect(setting("autoUnload.staleMinutes").value).toBe("7");
});

test("Reset puts every setting back to its default", async () => {
  await ZF.updateSettings("glance", { size: 60 });
  doc.getElementById("reset").click();
  await env.settle(60);
  expect((await ZF.getSettings()).glance.size).toBe(80);
  expect(setting("glance.size").value).toBe("80");
});

test("shortcuts are listed with their keys", async () => {
  const items = [...doc.querySelectorAll("#shortcuts li")].map(li => li.textContent);
  expect(items.length).toBe(Object.keys(MANIFEST.commands).length);
  expect(items.some(text => text.includes("⌃⌥Right") || text.includes("⌘⌥Right"))).toBe(true);
});

test("Glance's site access can be granted and removed here", async () => {
  const button = doc.getElementById("glance-access");
  expect(button.textContent).toBe("Allow…");
  button.click();
  await env.settle(60);
  expect(env.granted.has("<all_urls>")).toBe(true);
  expect(button.textContent).toBe("Remove access");
  button.click();
  await env.settle(60);
  expect(env.granted.has("<all_urls>")).toBe(false);
  expect(button.textContent).toBe("Allow…");
});

test("Unload Now runs a scan and shows what it did", async () => {
  doc.getElementById("unload-now").click();
  await env.settle(60);
  expect(doc.getElementById("last-run").textContent).toMatch(/^Last run just now: unloaded 0 tabs/);
});

test("restoring a backup reports what it did, and a bad file says why", async () => {
  // A backup made by this version, of a Work space with a Docs folder.
  const work = await ZF.createSpace(null, { name: "Work" });
  const folder = await ZF.createFolder("Docs", null, work.id);
  const tab = await env.open("https://docs.test/");
  await ZF.moveTabs([tab], folder.id);
  const backup = await ZF.exportFolders();
  await ZF.deleteSpace(work.id);
  await ZF.removeFolder(folder.id);
  await env.browser.tabs.remove(tab);

  await chooseFile(doc.getElementById("restore-file"), backup);
  expect(doc.getElementById("backup-result").textContent).toMatch(/^Restored: 1 spaces created; 1 folders created, 0 already there; 0 open tabs moved, 1 reopened unloaded/);
  expect((await ZF.loadSpaces()).map(s => s.name)).toEqual(["Home", "Work"]);
  const reopened = env.tabs.find(t => t.url === "https://docs.test/");
  expect(await ZF.getPlace(reopened.id)).toBe((await ZF.loadFolders())[0].id);

  await chooseFile(doc.getElementById("restore-file"), { hello: "world" });
  expect(doc.getElementById("backup-result").textContent).toMatch(/^Couldn't restore: /);
});

test("sliders show their value at once and save when you pause; text saves after typing stops", async () => {
  const slider = setting("glance.size");
  slider.value = "60";
  slider.dispatchEvent(new win.Event("input", { bubbles: true }));
  expect(doc.querySelector('[data-output="glance.size"]').textContent).toBe("60%");
  expect((await ZF.getSettings()).glance.size).toBe(80);
  await new Promise(r => setTimeout(r, 350));
  await env.settle(60);
  expect((await ZF.getSettings()).glance.size).toBe(60);

  const text = setting("autoUnload.neverUnload");
  text.focus();
  text.value = "*mail*";
  text.dispatchEvent(new win.Event("input", { bubbles: true }));
  // A change from elsewhere doesn't overwrite what's being typed.
  await ZF.updateSettings("glance", { size: 70 });
  await env.settle(60);
  expect(text.value).toBe("*mail*");
  await new Promise(r => setTimeout(r, 350));
  await env.settle(60);
  expect((await ZF.getSettings()).autoUnload.neverUnload).toBe("*mail*");
});

test("turning Glance on asks for access to websites", async () => {
  change(setting("glance.enabled"), false);
  await env.settle(60);
  change(setting("glance.enabled"), true);
  await env.settle(60);
  expect(env.granted.has("<all_urls>")).toBe(true);
  expect(doc.getElementById("glance-access").textContent).toBe("Remove access");
});

test("the last unload run says what was kept loaded and why", async () => {
  await env.browser.storage.local.set({
    lastAutoUnload: { at: Date.now() - 5 * 60_000, unloaded: 1, skipped: { essential: 1, active: 2, audible: 1, sharing: 1, "never-unload": 3, recent: 9 } },
  });
  await env.settle(60);
  expect(doc.getElementById("last-run").textContent).toBe("Last run 5 minutes ago: unloaded 1 tab");
  expect(doc.getElementById("last-run-detail").textContent).toBe(
    "Kept loaded: 1 Essential, 2 current, 1 playing audio, 1 in a call, 3 on your never-unload list."
  );
});

test("Change shortcuts opens Firefox's shortcut settings, or the add-ons page", async () => {
  const opened = [];
  win.browser.commands.openShortcutSettings = () => opened.push("shortcuts");
  doc.getElementById("edit-shortcuts").click();
  delete win.browser.commands.openShortcutSettings;
  doc.getElementById("edit-shortcuts").click();
  await env.settle(60);
  expect(opened).toEqual(["shortcuts"]);
  expect(env.tabs.some(t => t.url === "about:addons")).toBe(true);
});

test("Import from Zen reports what it did, or why it couldn't", async () => {
  await env.open("https://docs.test/");
  let picked = 0;
  doc.getElementById("import-file").addEventListener("click", () => picked++);
  doc.getElementById("import-zen").click();
  expect(picked).toBe(1);
  await chooseFile(doc.getElementById("import-file"), { folders: [{ id: "z", name: "Zen" }], tabs: [{ folderId: "z", urls: ["https://docs.test/"] }] });
  expect(doc.getElementById("import-result").textContent).toBe("Imported 1 folders and moved 1 tabs into them.");
  await chooseFile(doc.getElementById("import-file"), { nope: true });
  expect(doc.getElementById("import-result").textContent).toBe("Couldn't import: Not a Zen folders export");
});

test("Export saves a dated backup file and says what's in it", async () => {
  const work = await ZF.createSpace(null, { name: "Work" });
  const kept = await env.open("https://docs.test/");
  await ZF.moveTabs([kept], (await ZF.createFolder("Docs", null, work.id)).id);
  await env.open(`https://long.test/?${"x".repeat(9000)}`, { pinned: true });
  const files = [];
  win.URL.createObjectURL = blob => (files.push(blob), "blob:backup");
  win.HTMLAnchorElement.prototype.click = function () {
    files.push(this.download);
  };
  doc.getElementById("export-backup").click();
  await env.settle(60);
  expect(files[1]).toMatch(/^zen-folder-tools-\d{4}-\d{2}-\d{2}\.json$/);
  const data = JSON.parse(await files[0].text());
  expect([data.format, data.spaces.length, data.folders.length, data.tabs.length]).toEqual(["zen-folder-tools-backup", 2, 1, 1]);
  expect(doc.getElementById("backup-result").textContent).toBe(
    "Exported 2 spaces, 1 folder, 1 kept tab and 0 Essentials. 1 tab with an address over 8,192 characters wasn't included."
  );
});

test("a restore mentions container tabs and long addresses it skipped", async () => {
  let picked = 0;
  doc.getElementById("restore-file").addEventListener("click", () => picked++);
  doc.getElementById("restore-backup").click();
  expect(picked).toBe(1);
  await chooseFile(doc.getElementById("restore-file"), {
    format: "zen-folder-tools-backup",
    version: 2,
    folders: [],
    tabs: [
      { url: "https://bank.test/", place: "root", container: "firefox-container-1" },
      { url: `https://a.test/?${"x".repeat(9000)}`, place: "root" },
    ],
    essentials: [],
  });
  const text = doc.getElementById("backup-result").textContent;
  expect(text).toContain("1 tabs from containers weren't reopened");
  expect(text).toContain("1 tab with an address over 8,192 characters was skipped.");
});

test("cancelling a file picker changes nothing", async () => {
  for (const id of ["import-file", "restore-file"]) {
    const input = doc.getElementById(id);
    Object.defineProperty(input, "files", { configurable: true, value: [] });
    input.dispatchEvent(new win.Event("change", { bubbles: true }));
  }
  await env.settle(60);
  expect([doc.getElementById("import-result").textContent, doc.getElementById("backup-result").textContent]).toEqual(["", ""]);
});
