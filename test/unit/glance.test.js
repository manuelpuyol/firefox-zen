// Glance: the content script in web pages, and the popup the background opens.

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createFirefox, loadBackground, loadContentScript } from "../support/firefox.js";

const W = 1;
let env, ZF, source, pages;

beforeEach(async () => {
  env = createFirefox();
  ZF = loadBackground(env).ZF;
  await env.events.runtime.onInstalled.trigger({ reason: "install" });
  await env.browser.permissions.request({ origins: ["<all_urls>"] });
  await env.settle(90);
  source = await env.browser.tabs.create({ url: "https://news.test/" });
  pages = [];
});

afterEach(async () => {
  for (const page of pages) await page.window.happyDOM.close();
});

const LINKS = `
  <a id="story" href="/story">Story</a>
  <a id="other" href="https://news.test/other">Other</a>
  <a id="script" href="javascript:alert(1)">Script</a>
  <span id="text">Text</span>`;

async function page(tab = source) {
  const p = await loadContentScript(env, await env.browser.tabs.get(tab.id), { html: LINKS });
  pages.push(p);
  return p;
}

// isTrusted can't be set by pages; tests stand in for a real click or key.
function trusted(p, node, type, init) {
  const Event = type === "keydown" ? p.window.KeyboardEvent : p.window.MouseEvent;
  const event = new Event(type, { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, "isTrusted", { value: true });
  node.dispatchEvent(event);
  return event;
}
const altClick = (p, id, init = {}) => trusted(p, p.document.getElementById(id), "click", { altKey: true, button: 0, ...init });
const popups = () => env.windows.filter(w => w.type === "popup");
const glanceTab = () => env.tabs.find(t => t.windowId === popups()[0]?.id);
const pause = ms => new Promise(r => setTimeout(r, ms));

describe("the page script", () => {
  test("Option+click opens the link in a Glance instead of following it", async () => {
    const p = await page();
    const click = altClick(p, "story");
    expect(click.defaultPrevented).toBe(true);
    await env.settle();
    expect(popups()).toHaveLength(1);
    expect(glanceTab().url).toBe("https://news.test/story");
    // Centred on the window it came from.
    expect(popups()[0]).toMatchObject({ width: 960, height: 680, left: 120, top: 60 });
  });

  test("clicks made up by the page, other keys, and non-web links are left alone", async () => {
    const p = await page();
    const fake = new p.window.MouseEvent("click", { bubbles: true, cancelable: true, altKey: true });
    p.document.getElementById("story").dispatchEvent(fake);
    const results = [
      fake,
      trusted(p, p.document.getElementById("story"), "click", { button: 0 }),
      altClick(p, "story", { metaKey: true }),
      altClick(p, "story", { button: 1 }),
      altClick(p, "text"),
      altClick(p, "script"),
    ];
    await env.settle();
    expect(results.map(e => e.defaultPrevented)).toEqual([false, false, false, false, false, false]);
    expect(popups()).toHaveLength(0);
  });

  test("turning Glance off reaches open pages straight away, and back on", async () => {
    const p = await page();
    await ZF.updateSettings("glance", { enabled: false });
    await env.settle(90);
    expect(env.scripts.size).toBe(0);
    expect(altClick(p, "story").defaultPrevented).toBe(false);
    await ZF.updateSettings("glance", { enabled: true });
    await env.settle(90);
    expect(env.scripts.size).toBe(1);
    expect(altClick(p, "story").defaultPrevented).toBe(true);
  });

  test("removing site access turns it off in open pages too", async () => {
    const p = await page();
    await env.browser.permissions.remove({ origins: ["<all_urls>"] });
    await env.settle(90);
    expect(altClick(p, "story").defaultPrevented).toBe(false);
    // An old page that still sends the request gets nothing.
    await p.window.browser.runtime.sendMessage({ type: "glance-open", url: "https://news.test/story" });
    expect(popups()).toHaveLength(0);
  });

  test("in a container tab, Option+click behaves as usual", async () => {
    const bank = await env.browser.tabs.create({ url: "https://bank.test/", cookieStoreId: "firefox-container-1" });
    const p = await page(bank);
    expect(altClick(p, "story").defaultPrevented).toBe(false);
  });

  test("injected twice into a page, it still acts once", async () => {
    const p = await page();
    p.run();
    let sent = 0;
    const send = p.window.browser.runtime.sendMessage;
    p.window.browser.runtime.sendMessage = message => {
      if (message.type === "glance-open") sent++;
      return send(message);
    };
    altClick(p, "story");
    expect(sent).toBe(1);
  });

  test("Escape inside a Glance closes it; elsewhere, or when the page uses it, nothing happens", async () => {
    const p = await page();
    altClick(p, "story");
    await env.settle();
    // On the page it came from: nothing.
    trusted(p, p.document.body, "keydown", { key: "Escape" });
    await env.settle();
    expect(popups()).toHaveLength(1);

    const inside = await page(glanceTab());
    // The page used the key (e.g. to close its own dialog).
    inside.document.addEventListener("keydown", e => e.preventDefault(), { once: true });
    trusted(inside, inside.document.body, "keydown", { key: "Escape" });
    await env.settle();
    expect(popups()).toHaveLength(1);
    trusted(inside, inside.document.body, "keydown", { key: "Escape" });
    await env.settle();
    expect(popups()).toHaveLength(0);
  });

  test("a page already loading in the new Glance is told it's in one", async () => {
    altClick(await page(), "story");
    await env.settle();
    expect(env.calls.tabMessages.some(m => m.tabId === glanceTab().id && m.message.inGlance === true)).toBe(true);
  });
});

describe("the Glance window", () => {
  test("another Option+click reuses it; one inside it navigates it", async () => {
    const p = await page();
    altClick(p, "story");
    await env.settle();
    await pause(550);
    altClick(p, "other");
    await env.settle();
    expect(popups()).toHaveLength(1);
    expect(glanceTab().url).toBe("https://news.test/other");

    const inside = await page(glanceTab());
    altClick(inside, "story");
    await env.settle();
    expect(popups()).toHaveLength(1);
    expect(glanceTab().url).toBe("https://news.test/story");
  });

  test("at most one request per tab every half second", async () => {
    const p = await page();
    altClick(p, "story");
    altClick(p, "other");
    await env.settle();
    expect(glanceTab().url).toBe("https://news.test/story");
  });

  test("going back to the window it came from closes it; closing it by hand forgets it", async () => {
    const p = await page();
    altClick(p, "story");
    await env.settle();
    await env.events.windows.onFocusChanged.trigger(W);
    await env.settle();
    expect(popups()).toHaveLength(0);

    await pause(550);
    altClick(p, "story");
    await env.settle();
    await env.browser.windows.remove(popups()[0].id);
    await env.settle();
    expect((await env.browser.storage.session.get("glances")).glances).toEqual({});
  });

  test("a Glance from a private window is private", async () => {
    const priv = await env.browser.windows.create({ incognito: true, url: "https://news.test/" });
    altClick(await page(priv.tabs[0]), "story");
    await env.settle();
    expect(popups()[0].incognito).toBe(true);
  });

  test("Expand puts it next to its tab, or at the end if that tab is gone; without a Glance it does nothing", async () => {
    await env.events.commands.onCommand.trigger("glance-expand");
    expect(env.tabs).toHaveLength(1);

    await env.browser.tabs.create({ url: "https://later.test/", active: false });
    altClick(await page(), "story");
    await env.settle();
    const popup = popups()[0];
    const tab = glanceTab();
    await env.browser.tabs.remove(source.id);
    env.windows.splice(env.windows.indexOf(popup), 1);
    env.windows.unshift(popup);
    await env.events.commands.onCommand.trigger("glance-expand");
    expect(tab.windowId).toBe(W);
    expect(tab.index).toBe(env.tabs.filter(t => t.windowId === W).length - 1);
    expect(tab.active).toBe(true);
  });
});

test("a page told it's in a Glance after it asked closes that Glance with Escape, and only a Glance", async () => {
  const p = await page();
  // Told late (it asked before the Glance was registered): it now sends Escape,
  // but its window isn't a Glance, so nothing closes.
  await env.browser.tabs.sendMessage(source.id, { type: "glance-settings", inGlance: true });
  let sent = 0;
  const send = p.window.browser.runtime.sendMessage;
  p.window.browser.runtime.sendMessage = message => (message.type === "glance-escape" && sent++, send(message));
  trusted(p, p.document.body, "keydown", { key: "Escape" });
  await env.settle();
  expect(sent).toBe(1);
  expect(env.windows).toHaveLength(1);
});
