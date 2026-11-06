"use strict";

const fields = ["enabled", "staleMinutes", "scanIntervalMinutes"];
const $ = id => document.getElementById(id);

function describe(summary) {
  if (!summary) return "No unload run yet.";
  const when = new Date(summary.at).toLocaleTimeString();
  return `Last run ${when}: unloaded ${summary.unloaded} tab${summary.unloaded === 1 ? "" : "s"}${summary.failed ? `, ${summary.failed} failed` : ""}.`;
}

async function load() {
  const { autoUnload = {}, lastAutoUnload } = await browser.storage.local.get(["autoUnload", "lastAutoUnload"]);
  const settings = { enabled: true, staleMinutes: 60, scanIntervalMinutes: 5, ...autoUnload };
  $("enabled").checked = settings.enabled !== false;
  $("staleMinutes").value = settings.staleMinutes;
  $("scanIntervalMinutes").value = settings.scanIntervalMinutes;
  $("last").textContent = describe(lastAutoUnload);
}

async function save() {
  await browser.storage.local.set({
    autoUnload: {
      enabled: $("enabled").checked,
      staleMinutes: Number($("staleMinutes").value) || 60,
      scanIntervalMinutes: Number($("scanIntervalMinutes").value) || 5,
    },
  });
}

for (const id of fields) $(id).addEventListener("change", save);
$("now").addEventListener("click", async () => {
  $("last").textContent = describe(await browser.runtime.sendMessage({ type: "zf-unload-now" }));
});
browser.storage.onChanged.addListener(changes => {
  if (changes.lastAutoUnload) $("last").textContent = describe(changes.lastAutoUnload.newValue);
});
load();
