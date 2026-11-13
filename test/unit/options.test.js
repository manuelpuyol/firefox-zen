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
