// Takes the README's screenshots and GIFs: `npm run screenshots`.
//
// Real Firefox (headless, through the end-to-end harness), with this repo's
// user.js, userChrome.css and extension, filled with made-up local pages.
// Writes docs/images/*.png and *.gif; needs ffmpeg for the GIFs.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { launch, waitFor, KIT, Key } from "../test/e2e/firefox.js";

const OUT = path.join(KIT, "docs", "images");
const FRAMES = fs.mkdtempSync(path.join(os.tmpdir(), "zf-frames-"));
const WIDTH = 1280;
const HEIGHT = 800;

// Made-up pages: a title, an icon (a coloured letter) and some text.
const PAGES = {
  mail: ["Inbox (3)", "#3b82f6", "M"],
  calendar: ["Calendar – This week", "#ef4444", "C"],
  chat: ["Chat – #general", "#8b5cf6", "T"],
  music: ["Music – Focus mix", "#22c55e", "♪"],
  roadmap: ["Q3 roadmap", "#f59e0b", "R"],
  "research-notes": ["Research notes", "#14b8a6", "N"],
  "user-interviews": ["User interviews", "#06b6d4", "U"],
  "survey-results": ["Survey results", "#0ea5e9", "S"],
  "reading-1": ["How browsers paint pages", "#64748b", "A"],
  "reading-2": ["A short history of tabs", "#64748b", "A"],
  "reading-3": ["Designing for focus", "#64748b", "A"],
  journal: ["Journal", "#a855f7", "J"],
  weather: ["Weather – Lisbon", "#eab308", "W"],
  recipe: ["Recipe: Weeknight ramen", "#f97316", "R"],
  news: ["Morning briefing", "#e11d48", "B"],
  sprint: ["Sprint board", "#2563eb", "S"],
  standup: ["Standup notes", "#0d9488", "N"],
  "design-review": ["Design review", "#db2777", "D"],
  "pull-requests": ["Pull requests (4)", "#4b5563", "P"],
  docs: ["API reference", "#7c3aed", "A"],
  "story-1": ["Why tabs pile up", "#64748b", "A"],
};

// Each page is shown at a made-up .example address (reserved for
// documentation); a proxy pref sends them all to the local server.
const HOSTS = { mail: "mail", calendar: "calendar", chat: "chat", music: "music", weather: "weather", recipe: "recipes", news: "news" };
const hostOf = slug =>
  `${HOSTS[slug] ?? (/^reading|^story/.test(slug) ? "blog" : ["sprint", "standup", "design-review", "pull-requests", "docs"].includes(slug) ? "work" : "notes")}.example`;
const pageUrl = slug => `http://${hostOf(slug)}/${slug}`;

const ARTICLE = `
  <p>Most of the time a browser is a pile of tabs. Some are things you come back to every day, some
  belong to one project, and the rest are just passing through. Giving each kind its own place
  keeps the pile manageable (<a id="link" href="/story-1">why tabs pile up</a>).</p>
  <h2>This quarter</h2>
  <ul><li>Ship the new onboarding flow</li><li>Cut page load time in half on slow networks</li>
  <li>Retire the old settings screens</li></ul>
  <p>Everything else waits for next quarter. If something new comes up, it replaces an item above
  rather than joining the list.</p>
  <h2>Open questions</h2>
  <p>Which of these need research first, and who owns each one? Notes from the last review are
  linked in the project folder.</p>`;

function startServer() {
  const server = http.createServer((req, res) => {
    const slug = new URL(req.url, "http://notes.example").pathname.slice(1) || "roadmap";
    const [title, colour, letter] = PAGES[slug] ?? ["Untitled", "#64748b", "?"];
    const icon = `data:image/svg+xml,${encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="${colour}"/><text x="16" y="22" font-family="-apple-system,Helvetica,sans-serif" font-size="17" font-weight="700" fill="white" text-anchor="middle">${letter}</text></svg>`
    )}`;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><meta charset="utf-8"><title>${title}</title><link rel="icon" href="${icon}">
      <style>
        :root { color-scheme: light dark; font: 16px/1.6 -apple-system, BlinkMacSystemFont, sans-serif; }
        body { margin: 0; background: light-dark(#fafafa, #1c1b22); color: light-dark(#1f2937, #e5e7eb); }
        header { padding: 28px 56px; display: flex; gap: 14px; align-items: center; border-bottom: 1px solid light-dark(#e5e7eb, #2e2d36); }
        header img { width: 32px; height: 32px; }
        header span { font-weight: 600; }
        main { max-width: 640px; padding: 8px 56px 40px; }
        h1 { font-size: 30px; margin: 28px 0 8px; }
        h2 { font-size: 19px; margin-top: 28px; }
        a { color: ${colour}; }
      </style>
      <header><img src="${icon}" alt=""><span>${title.replace(/ [–(].*/, "")}</span></header>
      <main><h1>${title}</h1>${ARTICLE}</main>`);
  });
  // HTTPS-First's attempts (CONNECT) fail at once, so the http address loads.
  server.on("connect", (_req, socket) => socket.destroy());
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve({ server, url: pageUrl, port: server.address().port })));
}

const site = await startServer();
const ff = await launch({
  prefs: {
    "network.proxy.type": 1,
    "network.proxy.http": "127.0.0.1",
    "network.proxy.http_port": site.port,
    "network.proxy.no_proxies_on": "",
    "dom.security.https_first": false,
    "dom.security.https_first_schemeless": false,
  },
});
const pause = ms => new Promise(r => setTimeout(r, ms));

// Headless Firefox can't draw macOS's translucent sidebar material (it paints
// it light grey): a dark colour like it stands in. Also hidden: the robot
// icon Firefox shows while WebDriver drives it, and the "Not Secure" label
// the made-up http pages get (real sites are https). An agent sheet, because
// userChrome.css's !important rules outrank a page's.
const PAINT = `
  if (!window.zfPainted) {
    const css = ":root { background-color: rgb(32, 31, 38) !important; }" +
      ":root, #navigator-toolbox, #browser, #sidebar-main, #sidebar-box { appearance: none !important; }" +
      "#remote-control-box, #trust-label { display: none !important; }";
    window.windowUtils.loadSheetUsingURIString("data:text/css," + encodeURIComponent(css), window.windowUtils.AGENT_SHEET);
    window.zfPainted = true;
  }`;

// The main browser window, in chrome context, for screenshots.
async function toMain() {
  await ff.driver.setContext("chrome");
  for (const handle of await ff.driver.getAllWindowHandles()) {
    await ff.driver.switchTo().window(handle);
    if (await ff.driver.executeScript("return Boolean(window.zfMain)")) {
      await ff.driver.executeScript(PAINT);
      return handle;
    }
  }
  throw new Error("No main window");
}
async function capture(file) {
  await toMain();
  const png = Buffer.from(await ff.driver.takeScreenshot(), "base64");
  fs.writeFileSync(file, png);
  return file;
}
const shot = name => capture(path.join(OUT, `${name}.png`));

// Frames with how long each is shown, made into a looping GIF.
async function gif(name, frames) {
  const list = frames.flatMap(([file, seconds]) => [`file '${file}'`, `duration ${seconds}`]);
  list.push(`file '${frames.at(-1)[0]}'`);
  const listFile = path.join(FRAMES, `${name}.txt`);
  fs.writeFileSync(listFile, list.join("\n"));
  execFileSync("ffmpeg", [
    "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", listFile,
    "-vf", "fps=12,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle",
    path.join(OUT, `${name}.gif`),
  ]);
}
let frameNo = 0;
const frame = async (seconds = 0.08) => [await capture(path.join(FRAMES, `${String(frameNo++).padStart(4, "0")}.png`)), seconds];

// Runs in the extension's settings page; gets { browser, windowId, sidebar, bg }.
const ext = (body, ...args) => ff.ext(body, ...args);

async function open(slugs, extra = {}) {
  return ext(
    `async ({ browser, windowId }, [urls, extra]) => {
      const ids = [];
      for (const url of urls) ids.push((await browser.tabs.create({ windowId, url, active: false, ...extra })).id);
      return ids;
    }`,
    [slugs.map(site.url), extra]
  );
}

let MAIN;
try {
  MAIN = await toMain();
  await ff.driver.manage().window().setRect({ width: WIDTH, height: HEIGHT });

  // Essentials, then Home's tabs.
  await open(["mail", "calendar", "chat", "music"], { pinned: true });
  const [roadmap, notes, interviews, survey, r1, r2, r3, journal] = await open([
    "roadmap", "research-notes", "user-interviews", "survey-results", "reading-1", "reading-2", "reading-3", "journal",
  ]);
  await open(["weather", "recipe", "news"]);
  await ext(
    `async ({ browser, windowId, bg }, [roadmap, notes, interviews, survey, r1, r2, r3, journal]) => {
      const ZF = bg.ZF;
      const projects = await ZF.createFolder("Projects", null, "home");
      const research = await ZF.createFolder("Research", projects.id);
      const reading = await ZF.createFolder("Reading list", null, "home");
      await ZF.moveTabs([roadmap], projects.id);
      await ZF.moveItems(windowId, [{ kind: "folder", id: research.id }], projects.id, { anchor: { kind: "tab", id: roadmap }, after: true });
      await ZF.moveTabs([notes, interviews, survey], research.id);
      await ZF.moveTabs([r1, r2, r3], reading.id);
      await ZF.updateFolder(reading.id, { collapsed: true });
      await ZF.moveTabs([journal], ZF.ROOT);
      // Close what Firefox opened with.
      const ours = new Set([roadmap, notes, interviews, survey, r1, r2, r3, journal]);
      for (const tab of await browser.tabs.query({ windowId })) {
        if (!tab.pinned && !ours.has(tab.id) && !/weather|recipe|news/.test(tab.url)) await browser.tabs.remove(tab.id);
      }
      await browser.tabs.update(roadmap, { active: true });
    }`,
    [roadmap, notes, interviews, survey, r1, r2, r3, journal]
  );

  // A second space, Work, with its own background.
  await ext(`async ({ bg, windowId }) => {
    const work = await bg.ZF.createSpace(windowId, { name: "Work", icon: "💼" });
    await bg.ZF.updateSpace(work.id, { background: "ocean" });
  }`);
  const [sprint, standup, review, prs, docs] = await open(["sprint", "standup", "design-review", "pull-requests", "docs"]);
  await ext(
    `async ({ browser, windowId, bg }, [sprint, standup, review, prs, docs]) => {
      const ZF = bg.ZF;
      const space = await ZF.activeSpaceId(windowId, await ZF.loadSpaces());
      const folder = await ZF.createFolder("Sprint 42", null, space);
      await ZF.moveTabs([sprint, standup, review], folder.id);
      await ZF.moveTabs([docs], ZF.ROOT);
      for (const tab of await browser.tabs.query({ windowId, url: "about:newtab" })) await browser.tabs.remove(tab.id);
      await browser.tabs.update(prs, { active: true });
      await ZF.switchSpace(windowId, "home");
    }`,
    [sprint, standup, review, prs, docs]
  );
  await waitFor(() => ext(`async ({ browser }) => (await browser.tabs.query({})).every(t => t.status === "complete" && (t.favIconUrl || !t.url.startsWith("http")))`), {
    timeout: 20_000,
    message: "pages and icons",
  });
  await pause(1500);

  // 1. The sidebar.
  await shot("sidebar");

  // 2. Switching spaces.
  const spaceFrames = [await frame(1.8)];
  await ext(`async ({ sidebar }) => sidebar.document.querySelectorAll("#spaces .space")[1].click()`);
  for (let i = 0; i < 6; i++) spaceFrames.push(await frame());
  await pause(400);
  spaceFrames.push(await frame(1.8));
  await ext(`async ({ sidebar }) => sidebar.document.querySelectorAll("#spaces .space")[0].click()`);
  for (let i = 0; i < 6; i++) spaceFrames.push(await frame());
  await pause(400);
  spaceFrames.push(await frame(0.6));
  await gif("spaces", spaceFrames);

  // 3. A new space: the dialog.
  await ext(`async ({ sidebar }) => {
    const d = sidebar.document;
    d.getElementById("new-space").click();
    d.getElementById("space-name").value = "Side project";
    d.querySelector('#space-icons [data-icon="🎨"]').click();
  }`);
  await pause(400);
  await shot("new-space");
  await ext(`async ({ sidebar }) => sidebar.document.getElementById("space-dialog").close()`);

  // 4. Folders: open and close, Collapse all.
  await pause(300);
  const folderFrames = [await frame(1.4)];
  const clickFolder = name =>
    ext(
      `async ({ sidebar }, name) => [...sidebar.document.querySelectorAll(".row.folder")].find(r => r.textContent.includes(name)).click()`,
      name
    );
  for (const step of [() => clickFolder("Reading list"), () => clickFolder("Research"), () => ext(`async ({ sidebar }) => sidebar.document.getElementById("collapse-all").click()`), () => ext(`async ({ sidebar }) => sidebar.document.getElementById("collapse-all").click()`), () => clickFolder("Reading list")]) {
    await step();
    for (let i = 0; i < 3; i++) folderFrames.push(await frame());
    await pause(300);
    folderFrames.push(await frame(1.2));
  }
  await gif("folders", folderFrames);
  await pause(500);

  // 5. Glance: a real Option+click on the page's link opens a floating window.
  await ff.chrome(
    `async (main, id) => {
      const { ExtensionPermissions } = ChromeUtils.importESModule("resource://gre/modules/ExtensionPermissions.sys.mjs");
      await ExtensionPermissions.add(id, { permissions: [], origins: ["<all_urls>"] }, WebExtensionPolicy.getByID(id).extension);
    }`,
    ff.id
  );
  await waitFor(() => ext(`async ({ browser }) => (await browser.scripting.getRegisteredContentScripts()).length > 0`), { message: "Glance's script" });
  await ff.driver.setContext("content");
  for (const handle of await ff.driver.getAllWindowHandles()) {
    await ff.driver.switchTo().window(handle);
    if ((await ff.driver.getCurrentUrl()) === site.url("roadmap")) break;
  }
  await waitFor(() => ff.driver.executeScript("return true"), { message: "the page" });
  await pause(800);
  await ff.driver.actions().keyDown(Key.ALT).click(await ff.driver.findElement({ id: "link" })).keyUp(Key.ALT).perform();
  await waitFor(() => ext(`async ({ browser }) => (await browser.windows.getAll({ windowTypes: ["popup"], populate: true }))[0]?.tabs[0].status === "complete"`), {
    message: "the Glance window",
  });
  await pause(1000);
  // Each window is captured on its own, the Glance first (focusing the
  // window it came from closes it), then laid over the main window where it
  // is on screen.
  await ff.driver.setContext("chrome");
  let popup = null;
  for (const handle of await ff.driver.getAllWindowHandles()) {
    if (handle === MAIN) continue;
    await ff.driver.switchTo().window(handle);
    // The window showing the linked page.
    if (await ff.driver.executeScript(`return gBrowser.selectedBrowser.currentURI.spec.endsWith("/story-1")`)) {
      await ff.driver.executeScript(PAINT);
      popup = await ff.driver.executeScript("return [window.screenX, window.screenY]");
      fs.writeFileSync(path.join(FRAMES, "glance-popup.png"), Buffer.from(await ff.driver.takeScreenshot(), "base64"));
      break;
    }
  }
  if (!popup) throw new Error("No Glance window");
  const main = await capture(path.join(FRAMES, "glance-main.png"));
  const mainAt = await ff.driver.executeScript("return [window.screenX, window.screenY]");
  execFileSync("ffmpeg", [
    "-loglevel", "error", "-y", "-i", main, "-i", path.join(FRAMES, "glance-popup.png"),
    "-filter_complex", `[1]pad=iw+2:ih+2:1:1:color=0x6b7280[p];[0][p]overlay=${popup[0] - mainAt[0] - 1}:${popup[1] - mainAt[1] - 1}`,
    path.join(OUT, "glance.png"),
  ]);
  await ext(`async ({ browser }) => { for (const w of await browser.windows.getAll({ windowTypes: ["popup"] })) await browser.windows.remove(w.id); }`);

  // 6. The settings page, with its live preview.
  const settingsTab = await ff.openInMain(`moz-extension://${ff.host}/options/options.html`);
  await pause(1000);
  await shot("settings");
  await ff.driver.setContext("content");
  await ff.driver.switchTo().window(settingsTab);
  await ff.driver.close();

  // 7. The theme alone, without the extension: Firefox's own vertical tabs,
  // with tab groups as folders (a leading space makes a subfolder).
  await ext(`async ({ browser, bg, windowId }) => {
    const spaces = await bg.ZF.loadSpaces();
    for (const tab of await browser.tabs.query({ windowId, pinned: false })) {
      const space = bg.ZF.tabSpace(await browser.sessions.getTabValue(tab.id, bg.ZF.SPACE_KEY), spaces, "home");
      if (space !== "home" || tab.url.startsWith("moz-extension:")) await browser.tabs.remove(tab.id);
    }
  }`);
  const themeState = await ff.chrome(
    `async (main, id) => {
      const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
      await (await AddonManager.getAddonByID(id)).disable();
      const byEnd = end => main.gBrowser.tabs.find(t => t.linkedBrowser.currentURI.spec.endsWith(end));
      const group = (label, ends, color) => main.gBrowser.addTabGroup(ends.map(byEnd), { label, color, insertBefore: byEnd("/weather") });
      group("Projects", ["/roadmap"], "blue");
      group(" Research", ["/research-notes", "/user-interviews", "/survey-results"], "cyan");
      group("Reading list", ["/reading-1", "/reading-2", "/reading-3"], "grey").collapsed = true;
      main.gBrowser.moveTabTo(byEnd("/journal"), { tabIndex: main.gBrowser.pinnedTabCount });
      main.gBrowser.selectedTab = byEnd("/roadmap");
      // Firefox's own expanded tab list, at the width install.sh sets.
      const sidebar = main.SidebarController;
      sidebar.hide();
      const state = sidebar._state;
      Object.assign(state, { launcherWidth: 300, expandedLauncherWidth: 300 });
      if (!state.launcherVisible) state.updateVisibility ? state.updateVisibility(true) : (state.userLauncherVisible = true);
      state.launcherExpanded = true;
      return { visible: state.launcherVisible, expanded: state.launcherExpanded, open: sidebar.isOpen };
    }`,
    ff.id
  );
  await pause(1500);
  await shot("theme");
  console.log("theme sidebar", JSON.stringify(themeState));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await ff.quit();
  site.server.close();
  fs.rmSync(FRAMES, { recursive: true, force: true });
}
