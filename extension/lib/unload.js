"use strict";

// Auto-unload (ported from Zen Stale Tabs): every few minutes, unload tabs
// that haven't been looked at for a while. Essentials (pinned tabs) are never
// unloaded automatically, and Firefox's own low-memory unloader is told to
// skip them too (autoDiscardable: false).

(() => {
const ZF = (globalThis.ZF ??= {});

ZF.UNLOAD_ALARM = "zf-auto-unload";

const INTERNAL_URL = /^(?:about|chrome|data|file|moz-extension|resource|view-source):/i;

ZF.getUnloadSettings = async () => (await ZF.getSettings()).autoUnload;

// "Never unload" patterns: one per line, * matches anything, # comments.
ZF.compileNeverUnload = text =>
  String(text ?? "")
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith("#"))
    .map(glob => new RegExp(`^${glob.replace(/[\\^$+?.()|{}[\]]/gu, "\\$&").replace(/\*+/gu, ".*")}$`, "iu"));

// Why a tab isn't unloaded, or null if it should be.
ZF.unloadSkipReason = (tab, staleMs, now = Date.now(), { keepEssentials = true, neverUnload = [] } = {}) => {
  if (tab.pinned && keepEssentials) return "essential";
  const sharing = tab.sharingState;
  if (sharing && (sharing.camera || sharing.microphone || sharing.screen)) return "sharing";
  // Protected by the user or another extension; this one only protects pinned tabs.
  if (tab.autoDiscardable === false && !tab.pinned) return "protected";
  if (tab.active) return "active";
  if (tab.highlighted) return "selected";
  if (tab.discarded) return "already-unloaded";
  if (tab.status === "loading") return "loading";
  if (tab.audible) return "audible";
  if (tab.incognito) return "private";
  if (tab.attention) return "attention";
  if (INTERNAL_URL.test(tab.url ?? "")) return "internal-page";
  if (neverUnload.some(re => re.test(tab.url ?? ""))) return "never-unload";
  if (now - (tab.lastAccessed ?? now) < staleMs) return "recent";
  return null;
};

ZF.unloadStaleTabs = async ({ staleMs } = {}) => {
  const settings = await ZF.getUnloadSettings();
  if (staleMs === undefined) staleMs = settings.staleMinutes * 60_000;
  const options = { keepEssentials: settings.keepEssentialsLoaded, neverUnload: ZF.compileNeverUnload(settings.neverUnload) };
  const summary = { at: Date.now(), unloaded: 0, failed: 0, skipped: {} };
  for (const tab of await browser.tabs.query({})) {
    const reason = ZF.unloadSkipReason(tab, staleMs, summary.at, options);
    if (reason) {
      summary.skipped[reason] = (summary.skipped[reason] ?? 0) + 1;
      continue;
    }
    try {
      await browser.tabs.discard(tab.id);
      summary.unloaded++;
    } catch {
      summary.failed++;
    }
  }
  await browser.storage.local.set({ lastAutoUnload: summary });
  return summary;
};

// Firefox's own low-memory unloader skips tabs with autoDiscardable: false.
// Only flags this extension set (marked with a session value) are ever
// cleared, so other extensions' protection is left alone.
const OWNED_KEY = "zfKeepsLoaded";

ZF.keepEssentialLoaded = async (tab, keep) => {
  keep ??= (await ZF.getUnloadSettings()).keepEssentialsLoaded;
  const owned = await browser.sessions.getTabValue(tab.id, OWNED_KEY).catch(() => false);
  if (tab.pinned && keep) {
    if (tab.autoDiscardable !== false) {
      await browser.tabs.update(tab.id, { autoDiscardable: false });
      await browser.sessions.setTabValue(tab.id, OWNED_KEY, true);
    }
  } else if (owned) {
    await browser.tabs.update(tab.id, { autoDiscardable: true });
    await browser.sessions.removeTabValue(tab.id, OWNED_KEY);
  }
};

// Serialised: overlapping calls (quick setting changes) could otherwise leave
// an older "enabled" alarm behind after a newer "disabled".
let configuring = Promise.resolve();
ZF.configureAutoUnload = () => {
  configuring = configuring.then(async () => {
    const settings = await ZF.getUnloadSettings();
    await browser.alarms.clear(ZF.UNLOAD_ALARM);
    if (settings.enabled) {
      await browser.alarms.create(ZF.UNLOAD_ALARM, {
        delayInMinutes: settings.scanIntervalMinutes,
        periodInMinutes: settings.scanIntervalMinutes,
      });
    }
    for (const tab of await browser.tabs.query({})) {
      await ZF.keepEssentialLoaded(tab, settings.keepEssentialsLoaded).catch(() => {});
    }
  }).catch(() => {});
  return configuring;
};
})();
