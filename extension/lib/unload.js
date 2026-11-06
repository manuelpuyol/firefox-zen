"use strict";

// Auto-unload (ported from Zen Stale Tabs): every few minutes, unload tabs
// that haven't been looked at for a while. Essentials (pinned tabs) are never
// unloaded automatically, and Firefox's own low-memory unloader is told to
// skip them too (autoDiscardable: false).

(() => {
const ZF = (globalThis.ZF ??= {});

ZF.UNLOAD_DEFAULTS = Object.freeze({ enabled: true, staleMinutes: 60, scanIntervalMinutes: 5 });
ZF.UNLOAD_ALARM = "zf-auto-unload";

const INTERNAL_URL = /^(?:about|chrome|data|file|moz-extension|resource|view-source):/i;

ZF.getUnloadSettings = async () => {
  const { autoUnload } = await browser.storage.local.get("autoUnload");
  const s = { ...ZF.UNLOAD_DEFAULTS, ...(autoUnload ?? {}) };
  const clamp = (v, min, max, fallback) => (Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Math.round(Number(v)))) : fallback);
  return {
    enabled: s.enabled !== false,
    staleMinutes: clamp(s.staleMinutes, 1, 43_200, ZF.UNLOAD_DEFAULTS.staleMinutes),
    scanIntervalMinutes: clamp(s.scanIntervalMinutes, 1, 1_440, ZF.UNLOAD_DEFAULTS.scanIntervalMinutes),
  };
};

// Why a tab isn't unloaded, or null if it should be.
ZF.unloadSkipReason = (tab, staleMs, now = Date.now()) => {
  if (tab.pinned) return "essential";
  if (tab.active) return "active";
  if (tab.highlighted) return "selected";
  if (tab.discarded) return "already-unloaded";
  if (tab.status === "loading") return "loading";
  if (tab.audible) return "audible";
  if (tab.incognito) return "private";
  if (tab.attention) return "attention";
  if (INTERNAL_URL.test(tab.url ?? "")) return "internal-page";
  if (now - (tab.lastAccessed ?? now) < staleMs) return "recent";
  return null;
};

ZF.unloadStaleTabs = async ({ staleMs } = {}) => {
  if (staleMs === undefined) staleMs = (await ZF.getUnloadSettings()).staleMinutes * 60_000;
  const summary = { at: Date.now(), unloaded: 0, failed: 0, skipped: {} };
  for (const tab of await browser.tabs.query({})) {
    const reason = ZF.unloadSkipReason(tab, staleMs, summary.at);
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

ZF.keepEssentialLoaded = async tab => {
  if (tab.pinned && tab.autoDiscardable !== false) await browser.tabs.update(tab.id, { autoDiscardable: false });
  if (!tab.pinned && tab.autoDiscardable === false) await browser.tabs.update(tab.id, { autoDiscardable: true });
};

ZF.configureAutoUnload = async () => {
  const settings = await ZF.getUnloadSettings();
  await browser.alarms.clear(ZF.UNLOAD_ALARM);
  if (settings.enabled) {
    await browser.alarms.create(ZF.UNLOAD_ALARM, {
      delayInMinutes: settings.scanIntervalMinutes,
      periodInMinutes: settings.scanIntervalMinutes,
    });
  }
  for (const tab of await browser.tabs.query({})) await ZF.keepEssentialLoaded(tab).catch(() => {});
};
})();
