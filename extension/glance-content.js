"use strict";

let glanceEnabled = true;
// Off until the background confirms this tab can use Glance (not in containers).
let glanceAllowed = false;
browser.runtime.sendMessage({ type: "glance-context" }).then(r => (glanceAllowed = Boolean(r?.allowed)), () => {});
browser.storage.local.get("settings").then(({ settings }) => (glanceEnabled = settings?.glance?.enabled !== false));
browser.storage.onChanged.addListener(changes => {
  if (changes.settings) glanceEnabled = changes.settings.newValue?.glance?.enabled !== false;
});

// Alt+click on a link opens it in Glance instead of following it.
document.addEventListener(
  "click",
  event => {
    // Only real clicks: a page can dispatch synthetic Alt+clicks.
    if (!event.isTrusted || !glanceEnabled || !glanceAllowed || !event.altKey || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
    const link = event.target instanceof Element && event.target.closest("a[href]");
    if (!link) return;
    const url = new URL(link.getAttribute("href"), document.baseURI);
    if (!/^https?:$/.test(url.protocol)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    browser.runtime.sendMessage({ type: "glance-open", url: url.href });
  },
  true
);

// Escape closes Glance (only acts inside a Glance window), unless the page used it.
window.addEventListener("keydown", event => {
  if (event.isTrusted && event.key === "Escape" && !event.defaultPrevented && window.top === window) {
    browser.runtime.sendMessage({ type: "glance-escape" });
  }
});
