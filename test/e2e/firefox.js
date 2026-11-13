// End-to-end: real Firefox through geckodriver (fetched by Selenium Manager),
// with a throwaway profile built from this repo's user.js and userChrome.css,
// and the extension installed as a temporary add-on.
//
// Two contexts are used:
// - chrome: Firefox's own UI (the tab strip, the sidebar box, add-ons).
// - an extension page in a second window, which reaches the sidebar through
//   browser.extension.getViews(): the sidebar runs in the extension process,
//   out of reach of chrome code.

import { Builder, Key } from "selenium-webdriver";
import firefox from "selenium-webdriver/firefox.js";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

export const KIT = path.resolve(import.meta.dirname, "..", "..");
export { Key };

export async function waitFor(check, { timeout = 10_000, interval = 100, message = "condition" } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await check();
    if (last) return last;
    await new Promise(r => setTimeout(r, interval));
  }
  throw new Error(`Timed out waiting for ${message} (last: ${JSON.stringify(last)})`);
}

// Simple pages to open: /<name> has a title and a link to /<name>/story.
export function startServer() {
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(req.url.split("/")[1] || "home");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><title>${name}</title><a id="link" href="/${name}-story">A story on ${name}</a>`);
  });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve({ server, url: name => `http://127.0.0.1:${server.address().port}/${name}` })));
}

// Runs `body` (an async function's source) with `args` in the given context;
// errors thrown there are rethrown here.
async function run(driver, context, body, args) {
  await driver.setContext(context);
  const result = await driver.executeAsyncScript(
    `const done = arguments[arguments.length - 1];
     (${body})(...Array.from(arguments).slice(0, -1)).then(
       value => done({ value }),
       error => done({ error: String(error) + "\\n" + (error?.stack ?? "") })
     );`,
    ...args
  );
  if (result?.error) throw new Error(`In ${context}: ${result.error}`);
  return result?.value;
}

// prefs: extra Firefox preferences for this run, e.g. { "network.proxy.type": 1 }.
export async function launch({ prefs = {} } = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "zf-e2e-"));
  fs.copyFileSync(path.join(KIT, "user.js"), path.join(profile, "user.js"));
  const extra = Object.entries(prefs).map(([name, value]) => `user_pref(${JSON.stringify(name)}, ${JSON.stringify(value)});`);
  if (extra.length) fs.appendFileSync(path.join(profile, "user.js"), `\n${extra.join("\n")}\n`);
  fs.mkdirSync(path.join(profile, "chrome"));
  fs.copyFileSync(path.join(KIT, "chrome", "userChrome.css"), path.join(profile, "chrome", "userChrome.css"));

  const options = new firefox.Options().setProfile(profile);
  if (!process.env.HEADED) options.addArguments("-headless");
  // Chrome-context scripts need system access (Firefox 138+).
  const service = new firefox.ServiceBuilder().addArguments("--allow-system-access");
  const driver = await new Builder().forBrowser("firefox").setFirefoxOptions(options).setFirefoxService(service).build();

  const quit = async () => {
    await driver.quit().catch(() => {});
    fs.rmSync(profile, { recursive: true, force: true });
  };

  try {
    const { id } = await driver.installWebExtension(path.join(KIT, "extension"), { permanent: false });

    // Chrome code; `main` is the first browser window (where the sidebar is).
    const chrome = (body, ...args) =>
      run(
        driver,
        "chrome",
        `async (...args) => {
          const main = [...Services.wm.getEnumerator("navigator:browser")].find(w => w.zfMain);
          return (${body})(main, ...args);
        }`,
        args
      );

    await run(driver, "chrome", `async () => { window.zfMain = true; }`, []);
    const host = await chrome(
      `async (main, id) => {
        const policy = WebExtensionPolicy.getByID(id);
        const sidebarId = id.toLowerCase().replace(/[^a-z0-9_-]/g, "_") + "-sidebar-action";
        for (let i = 0; ; i++) {
          try {
            if (main.SidebarController.sidebars.has(sidebarId)) {
              await main.SidebarController.show(sidebarId);
              break;
            }
          } catch (error) {
            if (i > 100) throw error;
          }
          await new Promise(r => main.setTimeout(r, 100));
        }
        return policy.mozExtensionHostname;
      }`,
      id
    );

    // The extension page that drives the sidebar, in its own window. It's
    // opened again when it's gone (a reload of the extension closes it).
    // Opened from chrome code: switching WebDriver to a tab selects it, and
    // selecting another space's tab switches the window to that space.
    let pageHandle = null;
    const pageUrl = `moz-extension://${host}/options/options.html`;
    const openPage = async () => {
      await driver.setContext("content");
      const handles = await driver.getAllWindowHandles();
      if (pageHandle && handles.includes(pageHandle)) return driver.switchTo().window(pageHandle);
      pageHandle = await newTab(handles, `async (main, url) => { main.openTrustedLinkIn(url, "window"); }`, pageUrl);
    };
    // Runs chrome code that opens one tab, and switches to it once loaded.
    const newTab = async (handlesBefore, body, url) => {
      await chrome(body, url);
      const handle = await waitFor(async () => {
        await driver.setContext("content");
        return (await driver.getAllWindowHandles()).find(h => !handlesBefore.includes(h));
      }, { message: `a tab for ${url}` });
      await driver.switchTo().window(handle);
      await waitFor(async () => (await driver.getCurrentUrl()) === url && (await driver.executeScript("return document.readyState")) === "complete", {
        message: `${url} to load`,
      });
      return handle;
    };
    await openPage();

    // Extension code; gets the main window's id, its sidebar window and the
    // background page.
    const ext = async (body, ...args) => {
      await openPage();
      return run(
        driver,
        "content",
        `async (...args) => {
          const w = window.wrappedJSObject ?? window;
          const windowId = (await w.browser.windows.getAll({ windowTypes: ["normal"] }))
            .map(x => x.id)
            .sort((a, b) => a - b)[0];
          const sidebar = () => w.browser.extension.getViews({ type: "sidebar", windowId })[0];
          for (let i = 0; i < 100 && !sidebar()?.zfTest?.view(); i++) await new Promise(r => setTimeout(r, 100));
          const bg = await w.browser.runtime.getBackgroundPage();
          return (${body})({ browser: w.browser, windowId, sidebar: sidebar(), bg }, ...args);
        }`,
        args
      );
    };

    // Opens `url` in a new tab in the main window, without selecting any
    // other tab first, and switches to it.
    const openInMain = async url => {
      await driver.setContext("content");
      return newTab(
        await driver.getAllWindowHandles(),
        `async (main, url) => {
          main.gBrowser.selectedTab = main.gBrowser.addTab(url, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
        }`,
        url
      );
    };

    // Opens Firefox's tab context menu on the first tab whose address ends
    // with `suffix`, and returns the extension's items that are showing.
    // With `choose`, picks that item, as a click would.
    const tabMenu = (suffix, choose = null) =>
      chrome(
        `async (main, suffix, choose) => {
          const tab = main.gBrowser.tabs.find(t => t.linkedBrowser.currentURI.spec.endsWith(suffix));
          const menu = main.document.getElementById("tabContextMenu");
          const shown = new Promise(r => menu.addEventListener("popupshown", r, { once: true }));
          const trigger = new main.MouseEvent("contextmenu", { button: 2 });
          tab.dispatchEvent(trigger);
          menu.openPopupAtScreen(100, 100, true, trigger);
          await shown;
          // The extension hides what doesn't apply from its onShown listener,
          // just after the menu opens: wait until the items stop changing.
          const visible = () => [...menu.querySelectorAll("menuitem[id*='-menuitem-']")].filter(m => !m.hidden);
          let labels = "";
          for (let same = 0; same < 4; ) {
            await new Promise(r => main.setTimeout(r, 50));
            const now = visible().map(m => m.label).join("|");
            same = now === labels ? same + 1 : 0;
            labels = now;
          }
          const items = visible();
          labels = items.map(m => m.label);
          if (choose) items.find(m => m.label === choose).doCommand();
          menu.hidePopup();
          return labels;
        }`,
        suffix,
        choose
      );

    return { driver, id, host, chrome, ext, openInMain, tabMenu, quit };
  } catch (error) {
    await quit();
    throw error;
  }
}
