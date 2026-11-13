// Real Firefox: the theme, the sidebar, spaces in the real tab strip, an
// extension restart, and Glance on a real page.

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { launch, startServer, waitFor, Key } from "./firefox.js";

let ff, site;

beforeAll(async () => {
  site = await startServer();
  ff = await launch();
});

afterAll(async () => {
  await ff?.quit();
  site?.server.close();
});

// Firefox's tab strip in the main window.
const strip = () =>
  ff.chrome(`async main => main.gBrowser.tabs.map(t => ({ url: t.linkedBrowser.currentURI.spec, hidden: t.hidden, pinned: t.pinned, selected: t.selected }))`);
const visibleUrls = async () => (await strip()).filter(t => !t.hidden).map(t => t.url);
const sidebarState = () =>
  ff.ext(`async ({ sidebar }) => {
    const d = sidebar.document;
    return {
      label: d.getElementById("space-label").textContent,
      switcher: [...d.querySelectorAll("#spaces .space")].map(b => ({ icon: b.textContent, active: b.classList.contains("active") })),
      regular: [...d.querySelectorAll("#regular .row .title")].map(n => n.textContent),
      essentials: d.querySelectorAll("#essentials .tile").length,
    };
  }`);
const openTabs = names =>
  ff.ext(
    `async ({ browser, windowId }, urls) => {
      for (const url of urls) await browser.tabs.create({ windowId, url, active: false });
      await new Promise(r => setTimeout(r, 300));
    }`,
    names.map(site.url)
  );

describe("in real Firefox", () => {
  test("the theme hides Firefox's own sidebar header, and the sidebar lists the window's tabs", async () => {
    const header = await ff.chrome(`async main => {
      const header = main.document.getElementById("sidebar-panel-header") ?? main.document.getElementById("sidebar-header");
      return { open: main.SidebarController.isOpen, display: header ? main.getComputedStyle(header).display : "none" };
    }`);
    expect(header).toEqual({ open: true, display: "none" });

    await openTabs(["alpha", "beta"]);
    const state = await waitFor(async () => {
      const s = await sidebarState();
      return s.regular.includes("alpha") && s.regular.includes("beta") && s;
    }, { message: "tabs in the sidebar" });
    expect(state.label).toContain("Home");
    expect(state.switcher).toEqual([]);
  });

  test("New Space hides the other space's tabs in Firefox's tab strip; switching back shows them", async () => {
    const before = await visibleUrls();
    await ff.ext(`async ({ sidebar }) => {
      const d = sidebar.document;
      d.getElementById("new-space").click();
      d.getElementById("space-name").value = "Work";
      d.querySelector('#space-icons [data-icon="💼"]').click();
      d.querySelector('#space-dialog button[value="create"]').click();
    }`);
    const work = await waitFor(async () => {
      const s = await sidebarState();
      return s.label.includes("Work") && s;
    }, { message: "the Work space" });
    expect(work.switcher).toEqual([{ icon: "🏠", active: false }, { icon: "💼", active: true }]);

    const tabs = await strip();
    // Home's tabs are hidden for real; Work starts with one new tab.
    for (const url of before) expect(tabs.find(t => t.url === url).hidden).toBe(true);
    expect(tabs.filter(t => !t.hidden)).toHaveLength(1);
    expect(tabs.find(t => !t.hidden).selected).toBe(true);

    await openTabs(["gamma"]);
    await ff.ext(`async ({ sidebar }) => sidebar.document.querySelector('#spaces [data-space-id="home"]').click()`);
    await waitFor(async () => (await sidebarState()).label.includes("Home"), { message: "back in Home" });
    const home = await strip();
    expect(home.filter(t => !t.hidden).map(t => t.url).sort()).toEqual(before.sort());
    expect(home.find(t => t.url === site.url("gamma")).hidden).toBe(true);
  });

  test("Essentials stay visible in every space", async () => {
    await ff.chrome(`async main => main.gBrowser.pinTab(main.gBrowser.tabs.find(t => t.linkedBrowser.currentURI.spec.endsWith("/alpha")))`);
    await ff.ext(`async ({ sidebar }) => sidebar.document.querySelectorAll("#spaces .space")[1].click()`);
    await waitFor(async () => (await sidebarState()).label.includes("Work"), { message: "Work" });
    const tabs = await strip();
    expect(tabs.find(t => t.url === site.url("alpha"))).toMatchObject({ pinned: true, hidden: false });
    expect((await sidebarState()).essentials).toBe(1);
  });

  test("turned off and on again, the extension keeps its spaces and hides other spaces' tabs again", async () => {
    const before = await strip();
    const spaces = (await sidebarState()).switcher;
    expect(spaces.map(sp => sp.active)).toEqual([false, true]);
    await ff.ext(`async ({ bg }) => { bg.zfBeforeRestart = true; }`);
    await ff.chrome(
      `async (main, id) => {
        const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
        const addon = await AddonManager.getAddonByID(id);
        await addon.disable();
        // Firefox shows an extension's hidden tabs when it's turned off.
        if (main.gBrowser.tabs.some(t => t.hidden)) throw new Error("Tabs still hidden while the extension is off");
        await addon.enable();
      }`,
      ff.id
    );
    // The extension hides them again when it starts. (A reload wouldn't
    // test this: Firefox keeps the tabs hidden through a reload.)
    const after = await waitFor(async () => {
      const restarted = await ff
        .ext(`async ({ bg, browser }) => !bg.zfBeforeRestart && (await browser.storage.session.get("spacesStarted")).spacesStarted === true`)
        .catch(() => false);
      if (!restarted) return false;
      const tabs = await strip();
      return JSON.stringify(tabs.map(t => t.hidden)) === JSON.stringify(before.map(t => t.hidden)) && tabs;
    }, { timeout: 20_000, message: "the same tabs hidden as before" });
    expect(after.map(t => t.url)).toEqual(before.map(t => t.url));
    // The sidebar comes back with the same spaces once it's reopened.
    await ff.chrome(`async main => {
      for (let i = 0; i < 100 && !main.SidebarController.isOpen; i++) await new Promise(r => main.setTimeout(r, 100));
    }`);
    const state = await waitFor(async () => {
      try {
        const s = await sidebarState();
        return s.switcher.length === spaces.length && s;
      } catch {
        return false;
      }
    }, { timeout: 20_000, message: "the sidebar after the restart" }).catch(async () => {
      // A temporary add-on's sidebar may not reopen by itself; open it.
      await ff.chrome(
        `async (main, id) => main.SidebarController.show(id.toLowerCase().replace(/[^a-z0-9_-]/g, "_") + "-sidebar-action")`,
        ff.id
      );
      return waitFor(async () => {
        const s = await sidebarState().catch(() => null);
        return s?.switcher.length === spaces.length && s;
      }, { timeout: 20_000, message: "the reopened sidebar" });
    });
    expect(state.switcher).toEqual(spaces);
  });
});

describe("Glance in real Firefox", () => {
  test("Option+click on a link opens it in a popup, and Escape closes it", async () => {
    // Stands in for the user allowing access to websites.
    await ff.chrome(
      `async (main, id) => {
        const { ExtensionPermissions } = ChromeUtils.importESModule("resource://gre/modules/ExtensionPermissions.sys.mjs");
        const policy = WebExtensionPolicy.getByID(id);
        await ExtensionPermissions.add(id, { permissions: [], origins: ["<all_urls>"] }, policy.extension);
      }`,
      ff.id
    );
    await waitFor(() => ff.ext(`async ({ browser }) => (await browser.scripting.getRegisteredContentScripts()).length > 0`), {
      message: "the Glance script to be registered",
    });

    // The page goes in the main window. (Focusing the window a Glance came
    // from closes the Glance, so the test drives it from another window.)
    const pageTab = await ff.openInMain(site.url("page"));
    await waitFor(
      () =>
        ff.ext(
          `async ({ browser }, url) => {
            const tab = (await browser.tabs.query({})).find(t => t.url === url);
            if (!tab) return false;
            const [loaded] = await browser.scripting.executeScript({ target: { tabId: tab.id }, func: () => globalThis.zfGlanceLoaded === true });
            return loaded.result;
          }`,
          site.url("page")
        ),
      { message: "the Glance script in the page" }
    );
    // Its question to the background ("is Glance on here?") is answered by now.
    await new Promise(r => setTimeout(r, 300));

    const glanceUrl = () =>
      ff.ext(`async ({ browser }) => {
        const [win] = await browser.windows.getAll({ windowTypes: ["popup"], populate: true });
        return win ? { url: win.tabs[0].url, status: win.tabs[0].status } : null;
      }`);
    // The popup starts on about:blank, then loads the link (in a new
    // browsing context: wait for it to finish before driving it).
    const glanceLoaded = async () => {
      const glance = await glanceUrl();
      return glance?.status === "complete" && glance.url !== "about:blank" && glance.url;
    };
    const altClick = async () => {
      await ff.driver.setContext("content");
      await ff.driver.switchTo().window(pageTab);
      await ff.driver.actions().keyDown(Key.ALT).click(await ff.driver.findElement({ id: "link" })).keyUp(Key.ALT).perform();
    };

    await ff.driver.setContext("content");
    const handlesBefore = new Set(await ff.driver.getAllWindowHandles());
    await altClick();
    expect(await waitFor(glanceLoaded, { message: "the Glance popup" })).toBe(site.url("page-story"));
    // The page the link was on didn't navigate.
    expect((await strip()).some(t => t.url === site.url("page"))).toBe(true);

    // Escape inside the Glance closes it. (Its handle is the new one:
    // switching to any tab in the main window would close it.)
    await ff.driver.setContext("content");
    const glanceHandle = (await ff.driver.getAllWindowHandles()).find(h => !handlesBefore.has(h));
    await ff.driver.switchTo().window(glanceHandle);
    expect(await ff.driver.getCurrentUrl()).toBe(site.url("page-story"));
    // The key-down closes the window, so the key-up can find it gone.
    await ff.driver
      .actions()
      .sendKeys(Key.ESCAPE)
      .perform()
      .catch(error => {
        if (error.name !== "NoSuchWindowError") throw error;
      });
    await waitFor(async () => (await glanceUrl()) === null, { message: "Escape to close the Glance" });

    // So does going back to the window it came from.
    await new Promise(r => setTimeout(r, 600));
    await altClick();
    await waitFor(glanceLoaded, { message: "the second Glance" });
    await ff.driver.setContext("content");
    await ff.driver.switchTo().window(pageTab);
    await waitFor(async () => (await glanceUrl()) === null, { message: "focusing the window to close the Glance" });
  });
});
