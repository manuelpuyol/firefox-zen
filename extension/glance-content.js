"use strict";

// Off until the background answers: Glance setting, whether this tab can use
// Glance (not in container tabs), and whether this page is inside a Glance.
let glance = { enabled: false, allowed: false, inGlance: false };
browser.runtime.sendMessage({ type: "glance-context" }).then(
  reply => (glance = { ...glance, ...reply }),
  () => {}
);
browser.runtime.onMessage.addListener(message => {
  if (message?.type !== "glance-settings") return;
  if ("enabled" in message) glance.enabled = message.enabled;
  if ("inGlance" in message) glance.inGlance = message.inGlance;
});

// Alt+click on a link opens it in Glance instead of following it.
document.addEventListener(
  "click",
  event => {
    // Only real clicks: a page can dispatch synthetic Alt+clicks.
    if (!event.isTrusted || !glance.enabled || !glance.allowed) return;
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

// Escape closes the Glance this page is in, unless the page used the key.
window.addEventListener("keydown", event => {
  if (glance.inGlance && event.isTrusted && event.key === "Escape" && !event.defaultPrevented) {
    browser.runtime.sendMessage({ type: "glance-escape" });
  }
});
