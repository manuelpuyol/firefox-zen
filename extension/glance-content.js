"use strict";

// Alt+click on a link opens it in Glance instead of following it.
document.addEventListener(
  "click",
  event => {
    if (!event.altKey || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
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
  if (event.key === "Escape" && !event.defaultPrevented && window.top === window) {
    browser.runtime.sendMessage({ type: "glance-escape" });
  }
});
