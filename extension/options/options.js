"use strict";

let settings;

const get = (obj, path) => path.split(".").reduce((o, k) => o?.[k], obj);

function render() {
  for (const input of document.querySelectorAll("[data-setting]")) {
    const value = get(settings, input.dataset.setting);
    if (input.type === "checkbox") input.checked = value;
    else input.value = String(value);
    // Keep values that aren't one of the presets selectable.
    if (input.tagName === "SELECT" && input.value !== String(value)) {
      input.append(new Option(`${value} minutes`, String(value)));
      input.value = String(value);
    }
  }
  for (const output of document.querySelectorAll("[data-output]")) {
    output.textContent = `${get(settings, output.dataset.output)}${output.dataset.unit ?? ""}`;
  }
  for (const row of document.querySelectorAll("[data-depends]")) {
    row.classList.toggle("disabled", !get(settings, row.dataset.depends));
  }
}

async function save(input) {
  const [section, key] = input.dataset.setting.split(".");
  let value = input.type === "checkbox" ? input.checked : input.value;
  if (input.type === "range" || "number" in input.dataset) value = Number(value);
  settings = await ZF.updateSettings(section, { [key]: value });
  render();
}

// Sliders and text update the label immediately but save once you pause or
// let go, rather than on every movement or keystroke.
const pending = new Map();
function saveSoon(input) {
  clearTimeout(pending.get(input));
  pending.set(input, setTimeout(() => save(input), 300));
}

for (const input of document.querySelectorAll("[data-setting]")) {
  if (input.type === "range" || input.tagName === "TEXTAREA") {
    input.addEventListener("input", () => {
      const output = document.querySelector(`[data-output="${input.dataset.setting}"]`);
      if (output) output.textContent = `${input.value}${output.dataset.unit ?? ""}`;
      saveSoon(input);
    });
  }
  input.addEventListener("change", () => {
    clearTimeout(pending.get(input));
    // Turning Glance on asks for the site access it needs. The request has
    // to be made right away, while handling the click.
    if (input.dataset.setting === "glance.enabled" && input.checked) {
      browser.permissions.request(ALL_SITES).then(showGlanceAccess, () => {});
    }
    save(input);
  });
}

// Auto-unload status
function describeRun(summary) {
  if (!summary) return ["No unload run yet.", ""];
  const minutes = Math.round((Date.now() - summary.at) / 60_000);
  const when = minutes < 1 ? "just now" : minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  const n = summary.unloaded;
  const kept = Object.entries(summary.skipped ?? {})
    .filter(([reason]) => ["essential", "active", "audible", "sharing", "never-unload"].includes(reason))
    .map(([reason, count]) => {
      if (reason === "essential") return `${count} Essential${count === 1 ? "" : "s"}`;
      return `${count} ${{ active: "current", audible: "playing audio", sharing: "in a call", "never-unload": "on your never-unload list" }[reason]}`;
    });
  return [`Last run ${when}: unloaded ${n} tab${n === 1 ? "" : "s"}`, kept.length ? `Kept loaded: ${kept.join(", ")}.` : ""];
}

async function showLastRun(summary) {
  summary ??= (await browser.storage.local.get("lastAutoUnload")).lastAutoUnload;
  const [label, detail] = describeRun(summary);
  document.getElementById("last-run").textContent = label;
  document.getElementById("last-run-detail").textContent = detail;
}

document.getElementById("unload-now").addEventListener("click", async event => {
  event.target.disabled = true;
  await showLastRun(await browser.runtime.sendMessage({ type: "zf-unload-now" }));
  event.target.disabled = false;
});

// Shortcuts
async function showShortcuts() {
  const list = document.getElementById("shortcuts");
  const commands = await browser.commands.getAll();
  const pretty = key =>
    key
      ? key.replace(/Alt/g, "⌥").replace(/Shift/g, "⇧").replace(/Command|MacCtrl/g, "⌘").replace(/Ctrl/g, "⌃").replace(/\+/g, "")
      : "Not set";
  list.replaceChildren(
    ...commands.map(c => {
      const li = document.createElement("li");
      const label = document.createElement("span");
      label.textContent = c.description;
      const kbd = document.createElement("kbd");
      kbd.textContent = pretty(c.shortcut);
      li.append(label, kbd);
      return li;
    })
  );
}

document.getElementById("edit-shortcuts").addEventListener("click", () => {
  if (browser.commands.openShortcutSettings) browser.commands.openShortcutSettings();
  else browser.tabs.create({ url: "about:addons" });
});

// Glance needs access to websites (an optional permission); nothing else does.
const ALL_SITES = { origins: ["<all_urls>"] };
async function showGlanceAccess() {
  const granted = await browser.permissions.contains(ALL_SITES);
  const button = document.getElementById("glance-access");
  button.textContent = granted ? "Remove access" : "Allow…";
  document.getElementById("glance-access-hint").textContent = granted
    ? "Granted. Glance's script runs in pages only while Glance is on. Removing access turns it off everywhere."
    : "Glance needs it to notice Option+click on links. Without it, the extension can't see or change any web page.";
}
document.getElementById("glance-access").addEventListener("click", () => {
  // No await before request: it must happen while handling the click.
  const granted = document.getElementById("glance-access").textContent !== "Allow…";
  (granted ? browser.permissions.remove(ALL_SITES) : browser.permissions.request(ALL_SITES)).then(showGlanceAccess, showGlanceAccess);
});
browser.permissions.onAdded.addListener(showGlanceAccess);
browser.permissions.onRemoved.addListener(showGlanceAccess);

document.getElementById("import-zen").addEventListener("click", () => document.getElementById("import-file").click());
document.getElementById("import-file").addEventListener("change", async event => {
  const file = event.target.files[0];
  const result = document.getElementById("import-result");
  if (!file) return;
  try {
    const { folders, tabs } = await ZF.importZenFolders(JSON.parse(await file.text()));
    result.textContent = `Imported ${folders} folders and moved ${tabs} tabs into them.`;
  } catch (error) {
    result.textContent = `Couldn't import: ${error.message}`;
  }
  event.target.value = "";
});

// Backup
document.getElementById("export-backup").addEventListener("click", async () => {
  const data = await ZF.exportFolders();
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const link = Object.assign(document.createElement("a"), { href: url, download: `zen-folder-tools-${data.exportedAt.slice(0, 10)}.json` });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  const n = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
  const k = data.skippedLongAddresses;
  const skipped = k ? ` ${n(k, "tab")} with an address over 8,192 characters ${k === 1 ? "wasn't" : "weren't"} included.` : "";
  document.getElementById("backup-result").textContent = `Exported ${n(data.spaces.length, "space")}, ${n(data.folders.length, "folder")}, ${n(data.tabs.length, "kept tab")} and ${n(data.essentials.length, "Essential")}.${skipped}`;
});
document.getElementById("restore-backup").addEventListener("click", () => document.getElementById("restore-file").click());
document.getElementById("restore-file").addEventListener("change", async event => {
  const file = event.target.files[0];
  const result = document.getElementById("backup-result");
  if (!file) return;
  try {
    const r = await ZF.restoreFolders(JSON.parse(await file.text()));
    let skipped = r.skippedInContainers ? ` ${r.skippedInContainers} tabs from containers weren't reopened (that needs access to cookies); open them in their container and restore again to put them back.` : "";
    const k = r.skippedLongAddresses;
    if (k) skipped += ` ${k} ${k === 1 ? "tab" : "tabs"} with an address over 8,192 characters ${k === 1 ? "was" : "were"} skipped.`;
    result.textContent = `Restored: ${r.spacesCreated} spaces created; ${r.foldersCreated} folders created, ${r.foldersMatched} already there; ${r.tabsMoved} open tabs moved, ${r.tabsOpened} reopened unloaded; ${r.essentialsOpened} Essentials reopened.${skipped}`;
  } catch (error) {
    result.textContent = `Couldn't restore: ${error.message}`;
  }
  event.target.value = "";
});

document.getElementById("reset").addEventListener("click", async () => {
  await ZF.resetSettings();
  settings = await ZF.getSettings();
  render();
});

browser.storage.onChanged.addListener(changes => {
  if (changes.lastAutoUnload) showLastRun(changes.lastAutoUnload.newValue);
  if (changes.settings) {
    settings = ZF.normalizeSettings(changes.settings.newValue);
    // Don't overwrite what's being typed.
    if (document.activeElement?.tagName !== "TEXTAREA") render();
  }
});

(async () => {
  settings = await ZF.getSettings();
  render();
  showLastRun();
  showShortcuts();
  showGlanceAccess();
  setInterval(showLastRun, 60_000);
})();
