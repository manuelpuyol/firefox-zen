// lib/settings.js and lib/unload.js.

import { describe, test, expect, beforeEach } from "vitest";
import { createFirefox, loadBackground, plain } from "../support/firefox.js";

let env, ZF;
beforeEach(() => {
  env = createFirefox();
  ZF = loadBackground(env).ZF;
});

describe("settings", () => {
  test("missing or broken values fall back to the defaults", () => {
    expect(plain(ZF.normalizeSettings(undefined))).toEqual(plain(ZF.SETTINGS_DEFAULTS));
    const s = ZF.normalizeSettings({ sidebar: { tileSize: "big", showCounts: "yes" }, appearance: { background: "neon" }, glance: { size: null } });
    expect([s.sidebar.tileSize, s.sidebar.showCounts, s.appearance.background, s.glance.size]).toEqual([64, true, "aurora", 80]);
  });

  test("numbers are clamped and rounded to their step", () => {
    const s = ZF.normalizeSettings({
      sidebar: { tileSize: 500 },
      appearance: { textSize: 13.6, rowHeight: 1, indent: 9 },
      autoUnload: { staleMinutes: 0, scanIntervalMinutes: 1e9, neverUnload: "x".repeat(20_000) },
      glance: { size: 10 },
    });
    expect([s.sidebar.tileSize, s.appearance.textSize, s.appearance.rowHeight, s.appearance.indent]).toEqual([96, 13.5, 28, 10]);
    expect([s.autoUnload.staleMinutes, s.autoUnload.scanIntervalMinutes, s.autoUnload.neverUnload.length, s.glance.size]).toEqual([1, 1440, 10_000, 50]);
  });

  test("older settings carry over: Compact rows and 0.4.0's auto-unload", async () => {
    const compact = ZF.normalizeSettings({ sidebar: { compact: true } });
    expect([compact.appearance.rowHeight, compact.appearance.textSize]).toEqual([32, 13]);
    await env.browser.storage.local.set({ autoUnload: { enabled: false, staleMinutes: 30 } });
    const s = await ZF.getSettings();
    expect([s.autoUnload.enabled, s.autoUnload.staleMinutes]).toEqual([false, 30]);
  });

  test("updating a section keeps the rest and stores normalised values", async () => {
    await ZF.updateSettings("glance", { size: 70 });
    const s = await ZF.updateSettings("sidebar", { tileSize: 1 });
    expect([s.glance.size, s.sidebar.tileSize]).toEqual([70, 44]);
    expect((await env.browser.storage.local.get("settings")).settings.sidebar.tileSize).toBe(44);
    await ZF.resetSettings();
    expect((await ZF.getSettings()).glance.size).toBe(80);
  });
});

describe("auto-unload", () => {
  const HOUR = 60 * 60_000;
  const now = 10 * HOUR;
  const stale = (extra = {}) => ({ id: 1, url: "https://a.test/", lastAccessed: now - 2 * HOUR, ...extra });

  test("skips tabs that are in use, protected or recent, and says why", () => {
    const reason = (extra, options) => ZF.unloadSkipReason(stale(extra), HOUR, now, options);
    expect(reason({})).toBeNull();
    expect(reason({ pinned: true })).toBe("essential");
    expect(reason({ pinned: true }, { keepEssentials: false })).toBeNull();
    expect(reason({ sharingState: { microphone: true } })).toBe("sharing");
    expect(reason({ autoDiscardable: false })).toBe("protected");
    expect(reason({ active: true })).toBe("active");
    expect(reason({ highlighted: true })).toBe("selected");
    expect(reason({ discarded: true })).toBe("already-unloaded");
    expect(reason({ status: "loading" })).toBe("loading");
    expect(reason({ audible: true })).toBe("audible");
    expect(reason({ incognito: true })).toBe("private");
    expect(reason({ attention: true })).toBe("attention");
    expect(reason({ url: "about:preferences" })).toBe("internal-page");
    expect(reason({ lastAccessed: now - 10 })).toBe("recent");
  });

  test("Never unload patterns: * wildcards, comments, no regex surprises", () => {
    const patterns = ZF.compileNeverUnload("# work\n*mail.google.com*\n\n  https://app.slack.com/*  \na.b");
    expect(patterns).toHaveLength(3);
    const skip = url => ZF.unloadSkipReason(stale({ url }), HOUR, now, { neverUnload: patterns });
    expect(skip("https://mail.google.com/mail/u/0")).toBe("never-unload");
    expect(skip("https://APP.SLACK.COM/client")).toBe("never-unload");
    expect(skip("a.b")).toBe("never-unload");
    expect(skip("axb")).toBeNull();
    expect(skip("https://slack.com/")).toBeNull();
  });

  test("a scan unloads stale tabs and records a summary", async () => {
    const old = await env.browser.tabs.create({ url: "https://old.test/", active: false });
    env.find(old.id).lastAccessed = Date.now() - 2 * HOUR;
    await env.browser.tabs.create({ url: "https://new.test/" });
    const summary = await ZF.unloadStaleTabs();
    expect([summary.unloaded, summary.skipped.active]).toEqual([1, 1]);
    expect(env.find(old.id).discarded).toBe(true);
    expect((await env.browser.storage.local.get("lastAutoUnload")).lastAutoUnload.unloaded).toBe(1);
  });

  test("the scan alarm follows the setting, and essentials are kept loaded", async () => {
    const pinned = await env.browser.tabs.create({ url: "https://mail.test/", pinned: true });
    await ZF.configureAutoUnload();
    expect((await env.browser.alarms.get(ZF.UNLOAD_ALARM)).periodInMinutes).toBe(5);
    expect(env.find(pinned.id).autoDiscardable).toBe(false);

    await ZF.updateSettings("autoUnload", { enabled: false, keepEssentialsLoaded: false });
    await ZF.configureAutoUnload();
    expect(await env.browser.alarms.get(ZF.UNLOAD_ALARM)).toBeUndefined();
    expect(env.find(pinned.id).autoDiscardable).toBe(true);
  });

  test("another extension's protection is left alone", async () => {
    const pinned = await env.browser.tabs.create({ url: "https://mail.test/", pinned: true });
    env.find(pinned.id).autoDiscardable = false;
    await ZF.keepEssentialLoaded(await env.browser.tabs.get(pinned.id), true);
    await ZF.keepEssentialLoaded(await env.browser.tabs.get(pinned.id), false);
    expect(env.find(pinned.id).autoDiscardable).toBe(false);
  });
});
