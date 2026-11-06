"use strict";

// All user settings, stored as one object under "settings" in storage.local.
(() => {
  const ZF = (globalThis.ZF ??= {});

  ZF.SETTINGS_DEFAULTS = Object.freeze({
    sidebar: { compact: false, tileSize: 64, showCounts: true, showClear: true, unloadOnClose: true, animations: true },
    autoUnload: { enabled: true, staleMinutes: 60, scanIntervalMinutes: 5, keepEssentialsLoaded: true, neverUnload: "" },
    glance: { enabled: true, size: 80 },
  });

  const clamp = (value, min, max, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
  };
  const bool = (value, fallback) => (typeof value === "boolean" ? value : fallback);

  ZF.normalizeSettings = raw => {
    const d = ZF.SETTINGS_DEFAULTS;
    const s = raw ?? {};
    const sb = s.sidebar ?? {};
    const au = s.autoUnload ?? {};
    const gl = s.glance ?? {};
    return {
      sidebar: {
        compact: bool(sb.compact, d.sidebar.compact),
        tileSize: clamp(sb.tileSize, 44, 96, d.sidebar.tileSize),
        showCounts: bool(sb.showCounts, d.sidebar.showCounts),
        showClear: bool(sb.showClear, d.sidebar.showClear),
        unloadOnClose: bool(sb.unloadOnClose, d.sidebar.unloadOnClose),
        animations: bool(sb.animations, d.sidebar.animations),
      },
      autoUnload: {
        enabled: bool(au.enabled, d.autoUnload.enabled),
        staleMinutes: clamp(au.staleMinutes, 1, 43_200, d.autoUnload.staleMinutes),
        scanIntervalMinutes: clamp(au.scanIntervalMinutes, 1, 1_440, d.autoUnload.scanIntervalMinutes),
        keepEssentialsLoaded: bool(au.keepEssentialsLoaded, d.autoUnload.keepEssentialsLoaded),
        neverUnload: typeof au.neverUnload === "string" ? au.neverUnload.slice(0, 10_000) : d.autoUnload.neverUnload,
      },
      glance: {
        enabled: bool(gl.enabled, d.glance.enabled),
        size: clamp(gl.size, 50, 95, d.glance.size),
      },
    };
  };

  ZF.getSettings = async () => {
    const { settings, autoUnload } = await browser.storage.local.get(["settings", "autoUnload"]);
    // 0.4.0 stored auto-unload settings on their own.
    if (!settings && autoUnload) return ZF.normalizeSettings({ autoUnload });
    return ZF.normalizeSettings(settings);
  };

  ZF.updateSettings = async (section, changes) => {
    const current = await ZF.getSettings();
    current[section] = { ...current[section], ...changes };
    const next = ZF.normalizeSettings(current);
    await browser.storage.local.set({ settings: next });
    return next;
  };

  ZF.resetSettings = () => browser.storage.local.set({ settings: ZF.normalizeSettings({}) });
})();
