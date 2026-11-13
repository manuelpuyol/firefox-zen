// Opens the sidebar page (happy-dom) with the real background script behind it.

import { createFirefox, loadBackground, loadPage } from "./firefox.js";

export async function openSidebar(setup = async () => {}, { windows } = {}) {
  const env = createFirefox(windows ? { windows } : undefined);
  await setup(env);
  const bg = loadBackground(env);
  await env.events.runtime.onInstalled.trigger({ reason: "install" });
  await env.settle();
  const win = await loadPage(env, "sidebar/sidebar.html");
  const doc = win.document;
  const s = {
    env,
    bg,
    ZF: bg.ZF,
    win,
    doc,
    // Renders are debounced by 50 ms.
    redraw: () => env.settle(150),
    $: selector => doc.querySelector(selector),
    $$: selector => [...doc.querySelectorAll(selector)],
    titles: selector => [...doc.querySelectorAll(`${selector} .title`)].map(n => n.textContent),
    row: id => doc.querySelector(`.row[data-tab-id="${id}"]`),
    tile: id => doc.querySelector(`.tile[data-tab-id="${id}"]`),
    folderRow: id => doc.querySelector(`.row[data-folder-id="${id}"]`),
    click: (node, init = {}) => node.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true, ...init })),
    key: (node, key, init = {}) => node.dispatchEvent(new win.KeyboardEvent("keydown", { key, bubbles: true, ...init })),
    activeSpace: async (windowId = env.windows[0].id) => bg.ZF.activeSpaceId(windowId, await bg.ZF.loadSpaces()),
    close: () => win.happyDOM.close(),
  };
  await s.redraw();
  return s;
}
