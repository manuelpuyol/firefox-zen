"use strict";

const SVG_NS = "http://www.w3.org/2000/svg";
const FOLDER_CLOSED =
  "M1.75 4a1.25 1.25 0 0 1 1.25-1.25h3.3l1.6 1.6h5.1a1.25 1.25 0 0 1 1.25 1.25v6.4a1.25 1.25 0 0 1-1.25 1.25H3a1.25 1.25 0 0 1-1.25-1.25z";
const FOLDER_OPEN = [
  "M1.75 12.6V4a1.25 1.25 0 0 1 1.25-1.25h3.3l1.6 1.6h4.1a1.25 1.25 0 0 1 1.25 1.25v1.15",
  "M1.75 12.6l1.85-4.85a1.25 1.25 0 0 1 1.17-.8h9.05a.75.75 0 0 1 .7 1.02l-1.7 4.4a1.25 1.25 0 0 1-1.17.8H2.9a1.15 1.15 0 0 1-1.15-.57z",
];
const GLOBE =
  "data:image/svg+xml," +
  encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='gray' stroke-width='1.2'><circle cx='8' cy='8' r='6.5'/><path d='M1.5 8h13M8 1.5c2 2.2 2 10.8 0 13M8 1.5c-2 2.2-2 10.8 0 13'/></svg>"
  );

let windowId = null;
let view = null;
let dragging = null;
let renamingFolderId = null;
let renderPending = false;
let renderTimer = null;
let pointerDown = false;
let lastSignature = null;
// Bumped by local changes (e.g. folder toggles). A redraw that started reading
// state before a change would show stale data, so it's discarded and redone.
let editGeneration = 0;
let settings = ZF.normalizeSettings({});

function applySettings(next) {
  settings = next;
  const sb = settings.sidebar;
  document.body.classList.toggle("compact", sb.compact);
  document.body.classList.toggle("hide-counts", !sb.showCounts);
  document.body.classList.toggle("hide-clear", !sb.showClear);
  document.body.classList.toggle("no-animations", !sb.animations);
  document.documentElement.style.setProperty("--tile-size", `${sb.tileSize}px`);
}

const $ = id => document.getElementById(id);

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "dataset") Object.assign(node.dataset, value);
    else if (key === "style") node.style.cssText = value;
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) if (child) node.append(child);
  return node;
}

function folderIcon(open) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("class", "icon");
  svg.setAttribute("fill", "light-dark(white, black)");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.4");
  svg.setAttribute("stroke-linejoin", "round");
  for (const d of open ? FOLDER_OPEN : [FOLDER_CLOSED]) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

function favicon(tab) {
  const usable = tab.favIconUrl && /^(https?:|data:|moz-extension:)/.test(tab.favIconUrl);
  const img = el("img", { className: "favicon", src: usable ? tab.favIconUrl : GLOBE, alt: "" });
  img.addEventListener("error", () => (img.src = GLOBE), { once: true });
  return img;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

// Rebuilding the list while a button is held swallows the click (the element
// under the pointer at mouseup is no longer the one from mousedown), so
// redraws wait until the pointer is released, a drag ends or a rename ends.
function busy() {
  return pointerDown || dragging || renamingFolderId;
}

function scheduleRender() {
  if (busy()) {
    renderPending = true;
    return;
  }
  clearTimeout(renderTimer);
  renderTimer = setTimeout(render, 50);
}

// Only what the list shows; if it's unchanged, the DOM is left alone.
function signature(v) {
  const tab = t => [t.id, t.title, t.url, t.favIconUrl, t.active, t.discarded, t.audible, t.mutedInfo?.muted, t.zfOriginalUrl];
  return JSON.stringify([
    v.essentials.map(tab),
    v.folders.map(f => [f.id, f.name, f.parentId, f.order, f.collapsed]),
    [...v.byPlace].map(([place, tabs]) => [place, tabs.map(tab)]),
    v.regular.map(tab),
    renamingFolderId,
  ]);
}

async function render({ force = false } = {}) {
  renderPending = false;
  const generation = editGeneration;
  const next = await ZF.buildView(windowId);
  if (generation !== editGeneration) {
    scheduleRender();
    return;
  }
  if (busy() && !force) {
    renderPending = true;
    return;
  }
  view = next;
  const sig = signature(view);
  if (sig === lastSignature && !force) return;
  lastSignature = sig;

  $("essentials").replaceChildren(...view.essentials.map(tileFor));

  const pinned = [];
  for (const folder of ZF.childrenOf(view.folders, null)) pinned.push(folderBlock(folder, 0));
  for (const tab of view.byPlace.get(ZF.ROOT) ?? []) pinned.push(tabRow(tab, 0, ZF.ROOT));
  $("pinned").replaceChildren(...pinned);

  $("regular").replaceChildren(...view.regular.map(tab => tabRow(tab, 0, "regular")));
  $("separator").classList.toggle("empty", view.regular.length === 0);
}

function tileFor(tab) {
  return el(
    "div",
    {
      className: `tile${tab.active ? " active" : ""}${tab.discarded ? " discarded" : ""}`,
      title: tab.title,
      draggable: true,
      dataset: { tabId: tab.id, kind: "essential" },
    },
    [favicon(tab)]
  );
}

function tabRow(tab, depth, place) {
  const changed = place !== "regular" && tab.zfOriginalUrl && tab.url !== tab.zfOriginalUrl && ZF.isRealUrl(tab.url);
  const audio = tab.audible || tab.mutedInfo?.muted;
  return el(
    "div",
    {
      className: `row tab${tab.active ? " active" : ""}${tab.discarded ? " discarded" : ""}`,
      title: tab.title,
      draggable: true,
      style: `--depth: ${depth}`,
      dataset: { tabId: tab.id, place, kind: "tab" },
    },
    [
      favicon(tab),
      el("span", { className: "title", textContent: tab.title || tab.url }),
      audio && el("button", { className: "audio", title: tab.mutedInfo?.muted ? "Unmute" : "Mute", textContent: tab.mutedInfo?.muted ? "🔇" : "🔊", dataset: { action: "mute" } }),
      place !== "regular" && el("button", { className: `reset${changed ? " changed" : ""}`, title: "Reset to original URL", textContent: "↺", dataset: { action: "reset" } }),
      el("button", {
        className: "close",
        title: place === "regular" || tab.discarded || !settings.sidebar.unloadOnClose ? "Close tab" : "Unload tab (close again to remove)",
        textContent: "×",
        dataset: { action: "close" },
      }),
    ]
  );
}

function descendantTabs(folderId) {
  const tabs = [...(view.byPlace.get(folderId) ?? [])];
  for (const child of ZF.childrenOf(view.folders, folderId)) tabs.push(...descendantTabs(child.id));
  return tabs;
}

function folderBlock(folder, depth) {
  const all = descendantTabs(folder.id);
  const title =
    renamingFolderId === folder.id
      ? el("input", { className: "rename", value: folder.name, dataset: { renameFor: folder.id } })
      : el("span", { className: "title", textContent: folder.name });
  const row = el(
    "div",
    {
      className: "row folder",
      draggable: renamingFolderId !== folder.id,
      style: `--depth: ${depth}`,
      dataset: { folderId: folder.id, kind: "folder" },
    },
    [folderIcon(!folder.collapsed), title, all.length ? el("span", { className: "count", textContent: `+${all.length}` }) : null]
  );

  // A collapsed folder still shows its active tab (CSS keeps that row).
  const children = el("div", { className: `children${folder.collapsed ? " collapsed" : ""}` });
  for (const child of ZF.childrenOf(view.folders, folder.id)) children.append(folderBlock(child, depth + 1));
  for (const tab of view.byPlace.get(folder.id) ?? []) children.append(tabRow(tab, depth + 1, folder.id));
  return el("div", { className: "folder-block", dataset: { folderBlock: folder.id } }, [row, children]);
}

// ---------------------------------------------------------------------------
// Clicks
// ---------------------------------------------------------------------------

document.addEventListener("click", async event => {
  const action = event.target.closest("[data-action]")?.dataset.action;
  const item = event.target.closest("[data-tab-id], [data-folder-id]");
  if (event.target.closest("#new-tab")) return browser.tabs.create({ windowId });
  if (event.target.closest("#settings")) return browser.runtime.openOptionsPage();
  if (event.target.closest("#clear")) return ZF.clearRegular(view);
  if (!item || event.target.closest(".rename")) return;

  if (item.dataset.folderId) {
    const folder = view.folders.find(f => f.id === item.dataset.folderId);
    if (!folder) return;
    editGeneration++;
    folder.collapsed = !folder.collapsed;
    const block = item.parentElement;
    block.querySelector(":scope > .children")?.classList.toggle("collapsed", folder.collapsed);
    item.querySelector(".icon")?.replaceWith(folderIcon(!folder.collapsed));
    lastSignature = signature(view);
    await ZF.updateFolder(folder.id, { collapsed: folder.collapsed });
    editGeneration++;
    return;
  }

  const tabId = Number(item.dataset.tabId);
  const tab = view.tabsById.get(tabId);
  if (action === "close") return ZF.closeOrUnload(tabId, view, { unloadFirst: settings.sidebar.unloadOnClose });
  if (action === "reset") return tab?.zfOriginalUrl && browser.tabs.update(tabId, { url: tab.zfOriginalUrl });
  if (action === "mute") return browser.tabs.update(tabId, { muted: !tab?.mutedInfo?.muted });
  return browser.tabs.update(tabId, { active: true });
});

// Middle-click: unload (or close) like the close button.
document.addEventListener("auxclick", event => {
  if (event.button !== 1) return;
  const item = event.target.closest("[data-tab-id]");
  if (item) {
    event.preventDefault();
    ZF.closeOrUnload(Number(item.dataset.tabId), view, { unloadFirst: settings.sidebar.unloadOnClose });
  }
});

document.addEventListener("mousedown", event => {
  if (event.button === 1) event.preventDefault();
});

document.addEventListener("pointerdown", () => (pointerDown = true), true);
function pointerReleased() {
  if (!pointerDown) return;
  // Let the click handler run before redrawing.
  setTimeout(() => {
    pointerDown = false;
    if (renderPending) scheduleRender();
  }, 0);
}
window.addEventListener("pointerup", pointerReleased, true);
window.addEventListener("pointercancel", pointerReleased, true);
window.addEventListener("blur", pointerReleased);

function startRename(folderId) {
  renamingFolderId = folderId;
  renderPending = false;
  render({ force: true }).then(() => {
    const input = document.querySelector(`[data-rename-for="${folderId}"]`);
    if (!input) return;
    input.focus();
    input.select();
    const finish = async save => {
      if (renamingFolderId !== folderId) return;
      renamingFolderId = null;
      const name = input.value.trim();
      if (save && name) await ZF.updateFolder(folderId, { name });
      render({ force: true });
    };
    input.addEventListener("keydown", e => {
      if (e.key === "Enter") finish(true);
      if (e.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
  });
}

// ---------------------------------------------------------------------------
// Context menus: tabs get Firefox's own tab menu (plus this extension's
// items); folders and empty space get only this extension's folder items.
// ---------------------------------------------------------------------------

let menuTarget = null;

document.addEventListener("contextmenu", event => {
  const tabItem = event.target.closest("[data-tab-id]");
  if (tabItem) {
    menuTarget = null;
    browser.menus.overrideContext({ context: "tab", tabId: Number(tabItem.dataset.tabId) });
    return;
  }
  const folderRow = event.target.closest(".row.folder");
  menuTarget = { folderId: folderRow?.dataset.folderId ?? null, inPinned: Boolean(event.target.closest("#pinned")) };
  browser.menus.overrideContext({ showDefaults: false });
});

browser.menus.onShown.addListener(info => {
  if (!menuTarget || info.contexts.includes("tab") || !document.hasFocus()) return;
  const onFolder = Boolean(menuTarget.folderId);
  browser.menus.update("zf-new-folder", { visible: true });
  for (const id of ["zf-new-subfolder", "zf-rename-folder", "zf-remove-folder"]) browser.menus.update(id, { visible: onFolder });
  browser.menus.refresh();
});

browser.menus.onClicked.addListener(async info => {
  if (!menuTarget || !document.hasFocus()) return;
  const { folderId } = menuTarget;
  menuTarget = null;
  if (info.menuItemId === "zf-new-folder") {
    const folder = await ZF.createFolder("New Folder", null);
    startRename(folder.id);
  }
  if (info.menuItemId === "zf-new-subfolder" && folderId) {
    await ZF.updateFolder(folderId, { collapsed: false });
    const folder = await ZF.createFolder("New Folder", folderId);
    startRename(folder.id);
  }
  if (info.menuItemId === "zf-rename-folder" && folderId) startRename(folderId);
  if (info.menuItemId === "zf-remove-folder" && folderId) await ZF.removeFolder(folderId);
});

browser.runtime.onMessage.addListener(message => {
  if (message.type === "zf-rename" && message.windowId === windowId) startRename(message.folderId);
});

// ---------------------------------------------------------------------------
// Drag and drop
// ---------------------------------------------------------------------------

const DRAG_TYPE = "application/x-zen-folder-tools";

function clearIndicators() {
  for (const node of document.querySelectorAll(".drop-before, .drop-after, .drop-into, .drop-zone")) {
    node.classList.remove("drop-before", "drop-after", "drop-into", "drop-zone");
  }
}

document.addEventListener("dragstart", event => {
  const item = event.target.closest?.("[draggable=true]");
  if (!item) return;
  dragging = item.dataset.folderId ? { kind: "folder", id: item.dataset.folderId } : { kind: "tab", id: Number(item.dataset.tabId) };
  event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(dragging));
  event.dataTransfer.effectAllowed = "move";
  item.classList.add("dragging");
});

document.addEventListener("dragend", () => {
  dragging = null;
  clearIndicators();
  for (const node of document.querySelectorAll(".dragging")) node.classList.remove("dragging");
  if (renderPending) scheduleRender();
});

// Works out what a drop at this point would do. Returns null if nothing.
function dropTarget(event, drag) {
  const target = event.target.closest?.(".tile, .row, #essentials, #pinned, #separator, #regular, #new-tab");
  if (!target) return null;
  const rect = target.getBoundingClientRect();
  const y = (event.clientY - rect.top) / rect.height;
  const x = (event.clientX - rect.left) / rect.width;

  if (target.classList.contains("tile")) {
    if (drag.kind !== "tab") return null;
    const id = Number(target.dataset.tabId);
    return { node: target, mark: x < 0.5 ? "drop-before" : "drop-after", run: () => ZF.moveTab(drag.id, "essentials", x < 0.5 ? { beforeId: id } : { afterId: id }) };
  }
  if (target.id === "essentials") {
    if (drag.kind !== "tab") return null;
    return { node: target, mark: "drop-zone", run: () => ZF.moveTab(drag.id, "essentials") };
  }
  if (target.classList.contains("folder")) {
    const folderId = target.dataset.folderId;
    if (drag.kind === "tab") return { node: target, mark: "drop-into", run: () => ZF.moveTab(drag.id, folderId) };
    if (drag.id === folderId) return null;
    const folder = view.folders.find(f => f.id === folderId);
    if (y < 0.25) return { node: target, mark: "drop-before", run: () => ZF.moveFolder(drag.id, folder.parentId ?? null, { beforeId: folderId }) };
    if (y > 0.75) return { node: target, mark: "drop-after", run: () => ZF.moveFolder(drag.id, folder.parentId ?? null, { afterId: folderId }) };
    return { node: target, mark: "drop-into", run: () => ZF.moveFolder(drag.id, folderId) };
  }
  if (target.classList.contains("tab")) {
    const place = target.dataset.place === "regular" ? null : target.dataset.place;
    const id = Number(target.dataset.tabId);
    if (drag.kind === "folder") {
      if (place === null) return null;
      return { node: target, mark: "drop-into", run: () => ZF.moveFolder(drag.id, place === ZF.ROOT ? null : place) };
    }
    if (id === drag.id) return null;
    const before = y < 0.5;
    return { node: target, mark: before ? "drop-before" : "drop-after", run: () => ZF.moveTab(drag.id, place, before ? { beforeId: id } : { afterId: id }) };
  }
  if (target.id === "pinned") {
    if (drag.kind === "folder") return { node: target, mark: "drop-zone", run: () => ZF.moveFolder(drag.id, null) };
    return { node: target, mark: "drop-zone", run: () => ZF.moveTab(drag.id, ZF.ROOT) };
  }
  if (drag.kind !== "tab") return null;
  if (target.id === "separator") {
    const first = view.regular.find(t => t.id !== drag.id);
    return { node: target, mark: "drop-zone", run: () => ZF.moveTab(drag.id, null, first ? { beforeId: first.id } : {}) };
  }
  return { node: target, mark: "drop-zone", run: () => ZF.moveTab(drag.id, null) };
}

document.addEventListener("dragover", event => {
  if (!dragging) return;
  const drop = dropTarget(event, dragging);
  clearIndicators();
  if (!drop) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  drop.node.classList.add(drop.mark);
});

document.addEventListener("drop", async event => {
  if (!dragging) return;
  const drop = dropTarget(event, dragging);
  event.preventDefault();
  clearIndicators();
  if (drop) await drop.run();
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

(async () => {
  windowId = (await browser.windows.getCurrent()).id;
  for (const event of ["onCreated", "onRemoved", "onActivated", "onMoved", "onAttached", "onDetached", "onReplaced"]) {
    browser.tabs[event].addListener(scheduleRender);
  }
  browser.tabs.onUpdated.addListener(scheduleRender, {
    windowId,
    properties: ["title", "url", "favIconUrl", "discarded", "audible", "mutedInfo", "pinned", "hidden"],
  });
  browser.storage.onChanged.addListener(changes => {
    if (changes.settings) applySettings(ZF.normalizeSettings(changes.settings.newValue));
    if (changes.folders) scheduleRender();
  });
  applySettings(await ZF.getSettings());
  await render({ force: true });
  // Session values for restored tabs can arrive a little after startup.
  setTimeout(scheduleRender, 1000);
  setTimeout(scheduleRender, 4000);
})();

globalThis.zfTest = { render: () => render({ force: true }), view: () => view, dropTarget, windowId: () => windowId };
