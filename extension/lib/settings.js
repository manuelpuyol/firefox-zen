"use strict";

// All user settings, stored as one object under "settings" in storage.local.
(() => {
  const ZF = (globalThis.ZF ??= {});

  ZF.SETTINGS_DEFAULTS = Object.freeze({
    sidebar: {
      tileSize: 64,
      showCounts: true,
      showClear: true,
      confirmClear: true,
      unloadOnClose: true,
      animations: true,
      showScrollbar: true,
    },
    appearance: { textSize: 13.75, rowHeight: 40, indent: 14, essentialsMaxHeight: 50, background: "aurora" },
    folders: { convertTabGroups: true },
    autoUnload: { enabled: true, staleMinutes: 60, scanIntervalMinutes: 5, keepEssentialsLoaded: true, neverUnload: "" },
    glance: { enabled: true, size: 80 },
  });

  const clamp = (value, min, max, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
  };
  const bool = (value, fallback) => (typeof value === "boolean" ? value : fallback);
  const oneOf = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);
  ZF.BACKGROUNDS = ["aurora", "sunset", "ocean", "forest", "graphite", "plain"];
  // Like clamp, but rounds to a step (e.g. 0.25 for text sizes).
  const stepped = (value, min, max, step, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n / step) * step)) : fallback;
  };

  ZF.normalizeSettings = raw => {
    const d = ZF.SETTINGS_DEFAULTS;
    const s = raw ?? {};
    const sb = s.sidebar ?? {};
    const au = s.autoUnload ?? {};
    const gl = s.glance ?? {};
    // Before 0.9.0, "Compact rows" was a single switch: it becomes its sizes.
    const ap = s.appearance ?? (sb.compact === true ? { rowHeight: 32, textSize: 13 } : {});
    return {
      sidebar: {
        tileSize: clamp(sb.tileSize, 44, 96, d.sidebar.tileSize),
        showCounts: bool(sb.showCounts, d.sidebar.showCounts),
        showClear: bool(sb.showClear, d.sidebar.showClear),
        unloadOnClose: bool(sb.unloadOnClose, d.sidebar.unloadOnClose),
        animations: bool(sb.animations, d.sidebar.animations),
        confirmClear: bool(sb.confirmClear, d.sidebar.confirmClear),
        showScrollbar: bool(sb.showScrollbar, d.sidebar.showScrollbar),
      },
      appearance: {
        textSize: stepped(ap.textSize, 11, 20, 0.25, d.appearance.textSize),
        rowHeight: stepped(ap.rowHeight, 28, 56, 2, d.appearance.rowHeight),
        indent: stepped(ap.indent, 4, 32, 2, d.appearance.indent),
        essentialsMaxHeight: stepped(ap.essentialsMaxHeight, 20, 80, 5, d.appearance.essentialsMaxHeight),
        background: oneOf(ap.background, ZF.BACKGROUNDS, d.appearance.background),
      },
      folders: {
        convertTabGroups: bool(s.folders?.convertTabGroups, d.folders.convertTabGroups),
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
