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
let renamingSpaceId = null;
// The space the list was last drawn for, to slide in the next one.
let drawnSpaceId = null;
let renderPending = false;
let renderTimer = null;
let pointerDown = false;
let lastSignature = null;
// Set by in-place patches; the signature is recomputed once at the next
// render instead of after every patch.
let patched = false;
let selectedCount = 0;
// Bumped by local changes (e.g. folder toggles). A redraw that started reading
// state before a change would show stale data, so it's discarded and redone.
let editGeneration = 0;
let settings = ZF.normalizeSettings({});

function applySettings(next) {
  settings = next;
  const sb = settings.sidebar;
  document.body.classList.toggle("hide-counts", !sb.showCounts);
  document.body.classList.toggle("hide-clear", !sb.showClear);
  document.body.classList.toggle("no-animations", !sb.animations);
  document.documentElement.classList.toggle("hide-scrollbar", !sb.showScrollbar);
  const root = document.documentElement.style;
  root.setProperty("--tile-size", `${sb.tileSize}px`);
  const ap = settings.appearance;
  root.setProperty("--text-size", `${ap.textSize}px`);
  root.setProperty("--row-height", `${ap.rowHeight}px`);
  // Corners follow the row height (Zen: 14px on 40px rows).
  root.setProperty("--radius", `${Math.round(ap.rowHeight * 0.35)}px`);
  root.setProperty("--indent", `${ap.indent}px`);
  root.setProperty("--essentials-max", `${ap.essentialsMaxHeight}vh`);
  applyBackground();
}

// A space can have its own background; otherwise the Appearance setting's.
function applyBackground() {
  document.body.dataset.background = view?.space?.background ?? settings.appearance.background;
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
  return pointerDown || dragging || renamingFolderId || renamingSpaceId;
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
  // Place and position too: a move can change only a tab's stored position.
  const tab = t => [t.id, t.title, t.url, t.favIconUrl, t.active, t.highlighted, t.discarded, t.audible, t.mutedInfo?.muted, t.zfOriginalUrl, t.zfPlace, t.zfOrder];
  return JSON.stringify([
    v.essentials.map(tab),
    v.folders.map(f => [f.id, f.name, f.parentId, f.order, f.collapsed]),
    [...v.byPlace].map(([place, tabs]) => [place, tabs.map(tab)]),
    v.regular.map(tab),
    v.spaceId,
    v.spaces.map(s => [s.id, s.name, s.icon, s.background]),
    renamingFolderId,
    renamingSpaceId,
  ]);
}

let renderSeq = 0;

async function render({ force = false } = {}) {
  renderPending = false;
  // A render that couldn't draw anyway must not cancel one that can (e.g.
  // the forced render that shows the rename box), so defer before counting.
  if (busy() && !force) {
    renderPending = true;
    return;
  }
  const generation = editGeneration;
  const seq = ++renderSeq;
  const next = await ZF.buildView(windowId);
  // A newer render started meanwhile and has fresher data; it draws instead.
  // (While renaming, ordinary renders defer above without counting, so the
  // newest render is always one that can draw.)
  if (seq !== renderSeq) return;
  if (generation !== editGeneration) {
    if (force) return render({ force: true });
    scheduleRender();
    return;
  }
  if (busy() && !force) {
    renderPending = true;
    return;
  }
  if (patched && view) lastSignature = signature(view);
  patched = false;
  view = next;
  selectedCount = [...view.tabsById.values()].filter(t => t.highlighted).length;
  const sig = signature(view);
  if (sig === lastSignature && !force) return;
  lastSignature = sig;

  $("essentials").replaceChildren(...view.essentials.map(tileFor));

  $("pinned").replaceChildren(...ZF.itemsOf(view, ZF.ROOT).map(item => itemNode(item, 0, ZF.ROOT)));

  $("regular").replaceChildren(...view.regular.map(tab => tabRow(tab, 0, "regular")));
  $("separator").classList.toggle("empty", view.regular.length === 0);
  updateFolderBar();
  renderSpaces();
  applyBackground();
  slideInSpace();
  revealActive();

  if (renamingSpaceId) {
    const input = document.querySelector("#space-label .rename");
    if (!input) {
      renamingSpaceId = null;
      scheduleRender();
    } else if (document.activeElement !== input) {
      input.focus();
      if (input.zfSelection) input.setSelectionRange(...input.zfSelection);
      else input.select();
    }
  }

  if (renamingFolderId) {
    const input = document.querySelector(`[data-rename-for="${renamingFolderId}"]`);
    // The folder is gone: never leave the sidebar stuck in rename mode.
    if (!input) {
      renamingFolderId = null;
      scheduleRender();
    } else if (document.activeElement !== input) {
      input.focus();
      if (input.zfSelection) input.setSelectionRange(...input.zfSelection);
      else input.select();
    }
  }
}

// Collapse all when any folder is open, Expand all when every one is closed.
function updateFolderBar() {
  const bar = $("folder-bar");
  bar.classList.toggle("no-folders", !view.folders.length);
  $("collapse-all").textContent = view.folders.some(f => !f.collapsed) ? "Collapse all" : "Expand all";
}

async function toggleAllFolders() {
  const collapsed = view.folders.some(f => !f.collapsed);
  // Same as clicking each folder: change the rows now (animated), save after.
  editGeneration++;
  for (const folder of view.folders) {
    if (folder.collapsed === collapsed) continue;
    folder.collapsed = collapsed;
    const block = document.querySelector(`[data-folder-block="${folder.id}"]`);
    block?.querySelector(":scope > .children")?.classList.toggle("collapsed", collapsed);
    block?.querySelector(":scope > .row .icon")?.replaceWith(folderIcon(!collapsed));
  }
  patched = true;
  updateFolderBar();
  // Only this space's folders.
  await ZF.setAllCollapsed(collapsed, view.folders.map(f => f.id));
  editGeneration++;
}

// ---------------------------------------------------------------------------
// Spaces: the switcher at the bottom and the name under the Essentials.
// ---------------------------------------------------------------------------

function renderSpaces() {
  const icons = view.spaces.length > 1
    ? view.spaces.map(sp =>
        el("button", {
          type: "button",
          role: "tab",
          className: `space${sp.id === view.spaceId ? " active" : ""}`,
          title: sp.name,
          textContent: sp.icon,
          "aria-selected": String(sp.id === view.spaceId),
          dataset: { spaceId: sp.id },
        })
      )
    : [];
  $("spaces").replaceChildren(...icons, el("button", { type: "button", id: "new-space", title: "New space", "aria-label": "New space", textContent: "+" }));
  $("spaces").querySelector(".active")?.scrollIntoView({ inline: "nearest", block: "nearest" });
  const label = $("space-label");
  label.dataset.spaceId = view.spaceId;
  label.replaceChildren(
    ...(renamingSpaceId === view.spaceId
      ? [spaceRenameInput(view.space)]
      : [el("span", { textContent: view.space.icon }), el("span", { className: "name", textContent: view.space.name })])
  );
}

function slideInSpace() {
  const previous = drawnSpaceId;
  drawnSpaceId = view.spaceId;
  if (!previous || previous === view.spaceId) return;
  const ids = view.spaces.map(sp => sp.id);
  const scroll = $("scroll");
  scroll.classList.remove("space-in-next", "space-in-prev");
  void scroll.offsetWidth;
  scroll.classList.add(ids.indexOf(view.spaceId) > ids.indexOf(previous) ? "space-in-next" : "space-in-prev");
}

function startSpaceRename(spaceId) {
  renamingSpaceId = spaceId;
  renderPending = false;
  clearTimeout(renderTimer);
  render({ force: true });
}

function spaceRenameInput(space) {
  const previous = document.querySelector("#space-label .rename");
  const input = el("input", { className: "rename", value: previous?.value ?? space.name, maxLength: 50 });
  if (previous) input.zfSelection = [previous.selectionStart, previous.selectionEnd];
  const finish = async save => {
    if (!input.isConnected || renamingSpaceId !== space.id) return;
    renamingSpaceId = null;
    const name = input.value.trim();
    try {
      if (save && name) await ZF.updateSpace(space.id, { name });
    } catch (error) {
      console.error(error);
    } finally {
      render({ force: true });
    }
  };
  input.addEventListener("keydown", e => {
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
  return input;
}

async function newSpace() {
  const space = await ZF.createSpace(windowId);
  startSpaceRename(space.id);
}

// A horizontal trackpad swipe over the sidebar switches space, once per
// swipe: the momentum that follows is ignored until the wheel goes quiet.
const swipe = { sum: 0, done: false, timer: null };
document.addEventListener(
  "wheel",
  event => {
    if (Math.abs(event.deltaX) <= Math.abs(event.deltaY) || event.target.closest?.("#spaces")) return;
    event.preventDefault();
    clearTimeout(swipe.timer);
    swipe.timer = setTimeout(() => Object.assign(swipe, { sum: 0, done: false }), 250);
    if (swipe.done || !view || view.spaces.length < 2) return;
    swipe.sum += event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaX * 16 : event.deltaX;
    if (Math.abs(swipe.sum) < 80) return;
    swipe.done = true;
    ZF.switchSpaceBy(windowId, Math.sign(swipe.sum));
  },
  { passive: false }
);

// The tooltip names the current shortcut (it can be changed in Firefox).
async function showHideShortcut() {
  const command = (await browser.commands.getAll()).find(c => c.name === "_execute_sidebar_action");
  const keys = command?.shortcut
    ?.replace(/Alt/g, "⌥").replace(/Shift/g, "⇧").replace(/Command/g, "⌘").replace(/MacCtrl|Ctrl/g, "⌃").replace(/\+/g, "");
  $("hide-sidebar").title = keys ? `Hide sidebar (${keys})` : "Hide sidebar";
}

function isSelected(tab) {
  return tab.highlighted && selectedCount > 1;
}

function itemNode(item, depth, key) {
  return item.kind === "folder" ? folderBlock(item.folder, depth) : tabRow(item.tab, depth, key);
}

function tileFor(tab) {
  return el(
    "div",
    {
      className: `tile${tab.active ? " active" : ""}${tab.discarded ? " discarded" : ""}${isSelected(tab) ? " selected" : ""}`,
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
      className: `row tab${tab.active ? " active" : ""}${tab.discarded ? " discarded" : ""}${isSelected(tab) ? " selected" : ""}`,
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
    renamingFolderId === folder.id ? renameInput(folder) : el("span", { className: "title", textContent: folder.name });
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
  // Subfolders and tabs in one order: a subfolder can sit anywhere.
  for (const item of ZF.itemsOf(view, folder.id)) children.append(itemNode(item, depth + 1, folder.id));
  return el("div", { className: "folder-block", dataset: { folderBlock: folder.id } }, [row, children]);
}

// ---------------------------------------------------------------------------
// In-place updates. The most frequent events (switching tabs, title, favicon
// and unload changes) only touch the affected rows instead of rebuilding the
// list, which also avoids re-reading every tab's session values.
// ---------------------------------------------------------------------------

function rowsFor(tabId) {
  return document.querySelectorAll(`[data-tab-id="${tabId}"]`);
}

// When the active tab changes (a new tab, Ctrl+Tab, …) and its row is out of
// view, scroll to it. A new tab's row only exists after the next render, so
// this also runs after every render; it only scrolls once per activation.
let revealedId = null;
function revealActive() {
  const id = view?.activeId;
  if (id == null || id === revealedId) return;
  const row = rowsFor(id)[0];
  if (!row) return;
  revealedId = id;
  // Scroll only the list it's in (not scrollIntoView, which would also scroll
  // the settings page around its live preview).
  const list = row.closest("#scroll, #essentials");
  if (!list) return;
  const box = list.getBoundingClientRect();
  const r = row.getBoundingClientRect();
  const delta = r.top < box.top ? r.top - box.top : r.bottom > box.bottom ? r.bottom - box.bottom : 0;
  if (delta) list.scrollBy({ top: delta, behavior: settings.sidebar.animations ? "smooth" : "instant" });
}

function patchDone() {
  patched = true;
}

function onTabActivated({ tabId, previousTabId, windowId: activatedWindow }) {
  if (activatedWindow !== windowId) return;
  const next = view?.tabsById.get(tabId);
  // Only toggles classes, so it's safe even mid-click.
  if (!next || !rowsFor(tabId).length) return scheduleRender();
  const previous = view.tabsById.get(previousTabId);
  if (previous) previous.active = false;
  next.active = true;
  view.activeId = tabId;
  for (const node of document.querySelectorAll(".active[data-tab-id]")) node.classList.remove("active");
  for (const node of rowsFor(tabId)) node.classList.add("active");
  patchDone();
  revealActive();
}

function onTabPatched(tabId, change, tab) {
  const known = view?.tabsById.get(tabId);
  const nodes = rowsFor(tabId);
  if (busy() || !known || !nodes.length) return scheduleRender();
  Object.assign(known, { title: tab.title, url: tab.url, favIconUrl: tab.favIconUrl, discarded: tab.discarded });
  for (const node of nodes) {
    node.title = tab.title;
    node.classList.toggle("discarded", Boolean(tab.discarded));
    const title = node.querySelector(":scope > .title");
    if (title) title.textContent = tab.title || tab.url;
    if ("favIconUrl" in change) node.querySelector(":scope > .favicon")?.replaceWith(favicon(tab));
    const reset = node.querySelector(".reset");
    if (reset) reset.classList.toggle("changed", Boolean(known.zfOriginalUrl && tab.url !== known.zfOriginalUrl && ZF.isRealUrl(tab.url)));
    const close = node.querySelector(".close");
    if (close && "discarded" in change && node.dataset.place !== "regular") {
      close.title = tab.discarded || !settings.sidebar.unloadOnClose ? "Close tab" : "Unload tab (close again to remove)";
    }
  }
  patchDone();
}

// ---------------------------------------------------------------------------
// Multi-select. Firefox's own tab highlighting is the selection, so Cmd+W and
// the tab context menu act on every selected tab.
// ---------------------------------------------------------------------------

let anchorId = null;

function selectedIds() {
  if (!view) return [];
  const ids = [...view.tabsById.values()].filter(t => t.highlighted).map(t => t.id);
  return ids.length > 1 ? orderOnScreen(ids) : [];
}

// Tabs in the order they appear in the sidebar, skipping ones hidden inside
// collapsed folders.
function visibleTabOrder() {
  return [...document.querySelectorAll("[data-tab-id]")]
    .filter(node => node.classList.contains("tile") || node.getBoundingClientRect().height > 0)
    .map(node => Number(node.dataset.tabId));
}

function orderOnScreen(ids) {
  const order = ZF.displayOrder(view);
  return [...ids].sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

async function activeTabId() {
  const [active] = await browser.tabs.query({ windowId, active: true });
  return active?.id ?? null;
}

async function highlight(ids, activeId) {
  const tabs = await browser.tabs.query({ windowId });
  const index = new Map(tabs.map(t => [t.id, t.index]));
  // Firefox makes the first listed tab the active one.
  const ordered = [activeId, ...ids.filter(id => id !== activeId)].filter(id => index.has(id));
  await browser.tabs.highlight({ windowId, tabs: ordered.map(id => index.get(id)), populate: false });
}

function showSelection(ids) {
  const set = new Set(ids.length > 1 ? ids : []);
  for (const tab of view?.tabsById.values() ?? []) tab.highlighted = ids.includes(tab.id);
  for (const node of document.querySelectorAll("[data-tab-id]")) node.classList.toggle("selected", set.has(Number(node.dataset.tabId)));
}

async function selectRange(toId) {
  const active = await activeTabId();
  const from = anchorId ?? active;
  const order = visibleTabOrder();
  let a = order.indexOf(from);
  const b = order.indexOf(toId);
  if (a === -1) a = b;
  const range = order.slice(Math.min(a, b), Math.max(a, b) + 1);
  showSelection(range);
  await highlight(range, range.includes(active) ? active : toId);
}

async function toggleSelected(id) {
  const active = await activeTabId();
  const current = new Set((await browser.tabs.query({ windowId, highlighted: true })).map(t => t.id));
  if (current.has(id) && id !== active) current.delete(id);
  else current.add(id);
  const ids = [...current];
  showSelection(ids);
  anchorId = id;
  await highlight(ids, active);
}

function onTabsHighlighted({ windowId: highlightedWindow, tabIds }) {
  if (highlightedWindow !== windowId || !view) return;
  showSelection(tabIds);
  patchDone();
}

document.addEventListener("keydown", async event => {
  if (event.key !== "Escape" || !selectedIds().length) return;
  const active = await activeTabId();
  if (!active) return;
  showSelection([active]);
  highlight([active], active);
});

// Close (or unload) one tab, or every selected tab when it's part of the selection.
async function closeFromSidebar(tabId) {
  const selection = selectedIds();
  const ids = selection.includes(tabId) ? selection : [tabId];
  for (const id of ids) {
    await ZF.closeOrUnload(id, view, { unloadFirst: settings.sidebar.unloadOnClose, avoid: ids }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Clicks
// ---------------------------------------------------------------------------

document.addEventListener("click", async event => {
  const action = event.target.closest("[data-action]")?.dataset.action;
  const item = event.target.closest("[data-tab-id], [data-folder-id]");
  if (event.target.closest("#new-tab")) return browser.tabs.create({ windowId });
  if (event.target.closest("#settings")) return browser.runtime.openOptionsPage();
  // Must run straight from the click: closing needs a user action.
  if (event.target.closest("#hide-sidebar")) return browser.sidebarAction.close();
  if (event.target.closest("#clear")) return onClear();
  if (event.target.closest("#collapse-all")) return toggleAllFolders();
  if (event.target.closest("#new-space")) return newSpace();
  const spaceButton = event.target.closest("#spaces [data-space-id]");
  if (spaceButton) return ZF.switchSpace(windowId, spaceButton.dataset.spaceId);
  if (event.target.closest("#space-label")) return;
  if (!item || event.target.closest(".rename")) return;

  if (item.dataset.folderId) {
    const folder = view.folders.find(f => f.id === item.dataset.folderId);
    if (!folder) return;
    editGeneration++;
    folder.collapsed = !folder.collapsed;
    const block = item.parentElement;
    block.querySelector(":scope > .children")?.classList.toggle("collapsed", folder.collapsed);
    item.querySelector(".icon")?.replaceWith(folderIcon(!folder.collapsed));
    patched = true;
    updateFolderBar();
    await ZF.updateFolder(folder.id, { collapsed: folder.collapsed });
    editGeneration++;
    return;
  }

  const tabId = Number(item.dataset.tabId);
  const tab = view.tabsById.get(tabId);
  if (action === "close") return closeFromSidebar(tabId);
  if (action === "reset") return tab?.zfOriginalUrl && browser.tabs.update(tabId, { url: tab.zfOriginalUrl });
  if (action === "mute") return browser.tabs.update(tabId, { muted: !tab?.mutedInfo?.muted });
  if (event.shiftKey) return selectRange(tabId);
  if (event.metaKey || event.ctrlKey) return toggleSelected(tabId);
  anchorId = tabId;
  if (selectedIds().length) {
    showSelection([tabId]);
    return highlight([tabId], tabId);
  }
  return browser.tabs.update(tabId, { active: true });
});

// Clear asks once ("Close 5 tabs?") unless confirmation is turned off.
let clearTimer = null;

function resetClear() {
  clearTimeout(clearTimer);
  $("clear").classList.remove("confirming");
  $("clear").textContent = "↓ Clear";
}

function onClear() {
  const button = $("clear");
  if (!settings.sidebar.confirmClear || button.classList.contains("confirming")) {
    resetClear();
    return ZF.clearRegular(windowId);
  }
  const n = view.regular.length;
  button.textContent = `Close ${n} tab${n === 1 ? "" : "s"}?`;
  button.classList.add("confirming");
  clearTimer = setTimeout(resetClear, 3000);
}

document.addEventListener("dblclick", event => {
  if (event.target.closest("#space-label") && !renamingSpaceId) startSpaceRename(view.spaceId);
});

// Middle-click: unload (or close) like the close button.
document.addEventListener("auxclick", event => {
  if (event.button !== 1) return;
  const item = event.target.closest("[data-tab-id]");
  if (item) {
    event.preventDefault();
    closeFromSidebar(Number(item.dataset.tabId));
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
  clearTimeout(renderTimer);
  render({ force: true });
}

// Whichever render draws the rename box wires it up, so a redraw mid-rename
// keeps working save/cancel handlers and what was typed so far.
function renameInput(folder) {
  const previous = document.querySelector(`[data-rename-for="${folder.id}"]`);
  const input = el("input", { className: "rename", value: previous?.value ?? folder.name, dataset: { renameFor: folder.id } });
  if (previous) input.zfSelection = [previous.selectionStart, previous.selectionEnd];
  const finish = async save => {
    // Ignore a box that was replaced by a redraw, or a rename already finished.
    if (!input.isConnected || renamingFolderId !== folder.id) return;
    renamingFolderId = null;
    const name = input.value.trim();
    try {
      if (save && name) await ZF.updateFolder(folder.id, { name });
    } catch (error) {
      console.error(error);
    } finally {
      render({ force: true });
    }
  };
  input.addEventListener("keydown", e => {
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
  return input;
}

// ---------------------------------------------------------------------------
// Context menus: tabs get Firefox's own tab menu (plus this extension's
// items); folders and empty space get only this extension's folder items.
// ---------------------------------------------------------------------------

let menuTarget = null;

document.addEventListener("contextmenu", event => {
  const spaceItem = event.target.closest("#spaces [data-space-id], #space-label");
  if (spaceItem && view) {
    menuTarget = { spaceId: spaceItem.dataset.spaceId ?? view.spaceId };
    browser.menus.overrideContext({ showDefaults: false });
    return;
  }
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
  if (!menuTarget || info.contexts.includes("tab") || !document.hasFocus() || !view) return;
  const space = menuTarget.spaceId ? view.spaces.find(sp => sp.id === menuTarget.spaceId) : null;
  const onFolder = !space && Boolean(menuTarget.folderId);
  browser.menus.update("zf-new-folder", { visible: !space });
  for (const id of ["zf-new-subfolder", "zf-rename-folder", "zf-remove-folder"]) browser.menus.update(id, { visible: onFolder });
  browser.menus.update("zf-folder-to-space", { visible: onFolder && view.spaces.length > 1 });
  for (const sp of view.spaces) browser.menus.update(`zf-folder-to-space:${sp.id}`, { enabled: sp.id !== view.spaceId });
  for (const id of ZF.SPACE_MENU_ITEMS) browser.menus.update(id, { visible: Boolean(space) });
  if (space) {
    const i = view.spaces.indexOf(space);
    browser.menus.update("zf-space-left", { enabled: i > 0 });
    browser.menus.update("zf-space-right", { enabled: i < view.spaces.length - 1 });
    browser.menus.update("zf-space-delete", { enabled: view.spaces.length > 1 });
    browser.menus.update(`zf-space-bg:${space.background ?? "default"}`, { checked: true });
  }
  browser.menus.refresh();
});

async function onSpaceMenu(id, spaceId) {
  if (id === "zf-space-rename") {
    if (spaceId !== view.spaceId) await ZF.switchSpace(windowId, spaceId);
    startSpaceRename(spaceId);
  }
  if (id.startsWith("zf-space-icon:")) await ZF.updateSpace(spaceId, { icon: id.slice("zf-space-icon:".length) });
  if (id.startsWith("zf-space-bg:")) {
    const background = id.slice("zf-space-bg:".length);
    await ZF.updateSpace(spaceId, { background: background === "default" ? null : background });
  }
  if (id === "zf-space-left" || id === "zf-space-right") await ZF.moveSpace(spaceId, id === "zf-space-left" ? -1 : 1);
  if (id === "zf-space-delete") await ZF.deleteSpace(spaceId);
  if (id === "zf-space-new") await newSpace();
}

browser.menus.onClicked.addListener(async info => {
  if (!menuTarget || !document.hasFocus()) return;
  const { folderId, spaceId } = menuTarget;
  menuTarget = null;
  const id = String(info.menuItemId);
  if (spaceId) return onSpaceMenu(id, spaceId);
  if (id.startsWith("zf-folder-to-space:") && folderId) return ZF.moveFolderToSpace(folderId, id.slice("zf-folder-to-space:".length));
  if (info.menuItemId === "zf-new-folder") {
    const folder = await ZF.createFolder("New Folder", null, view?.spaceId ?? null);
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
    node.classList.remove("drop-before", "drop-after", "drop-into", "drop-zone", "drop-child");
  }
}

document.addEventListener("dragstart", event => {
  const item = event.target.closest?.("[draggable=true]");
  if (!item) return;
  if (item.dataset.folderId) {
    dragging = { kind: "folder", id: item.dataset.folderId };
  } else {
    const id = Number(item.dataset.tabId);
    const selection = selectedIds();
    dragging = { kind: "tab", id, ids: selection.includes(id) ? selection : [id] };
  }
  event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(dragging));
  event.dataTransfer.effectAllowed = "move";
  item.classList.add("dragging");
  for (const id of dragging.ids ?? []) for (const node of rowsFor(id)) node.classList.add("dragging");
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
    if (drag.ids.includes(id)) return null;
    return { node: target, mark: x < 0.5 ? "drop-before" : "drop-after", run: () => ZF.moveTabs(drag.ids, "essentials", x < 0.5 ? { beforeId: id } : { afterId: id }) };
  }
  if (target.id === "essentials") {
    if (drag.kind !== "tab") return null;
    return { node: target, mark: "drop-zone", run: () => ZF.moveTabs(drag.ids, "essentials") };
  }
  const moving = drag.kind === "folder" ? [{ kind: "folder", id: drag.id }] : drag.ids.map(id => ({ kind: "tab", id }));
  // A folder can't be dropped inside itself or its own subfolders.
  const canEnter = key => drag.kind !== "folder" || (key !== drag.id && !(key !== ZF.ROOT && ZF.isDescendant(view.folders, key, drag.id)));
  const into = (key, opts, node, mark) =>
    canEnter(key) ? { node, mark, run: () => ZF.moveItems(windowId, moving, key, opts) } : null;

  if (target.classList.contains("folder")) {
    const folderId = target.dataset.folderId;
    if (drag.kind === "folder" && drag.id === folderId) return null;
    const folder = view.folders.find(f => f.id === folderId);
    const parentKey = folder.parentId ?? ZF.ROOT;
    const self = { kind: "folder", id: folderId };
    if (y < 0.25) return into(parentKey, { anchor: self }, target, "drop-before");
    if (y > 0.75) {
      // Below an open folder's header is its first item; below a closed one is the next item.
      return folder.collapsed
        ? into(parentKey, { anchor: self, after: true }, target, "drop-after")
        : into(folderId, { atStart: true }, target, "drop-after drop-child");
    }
    return into(folderId, {}, target, "drop-into");
  }
  if (target.classList.contains("tab")) {
    const id = Number(target.dataset.tabId);
    if (drag.kind === "tab" && drag.ids.includes(id)) return null;
    const before = y < 0.5;
    if (target.dataset.place === "regular") {
      if (drag.kind === "folder") return null;
      return { node: target, mark: before ? "drop-before" : "drop-after", run: () => ZF.moveTabs(drag.ids, null, before ? { beforeId: id } : { afterId: id }) };
    }
    return into(target.dataset.place, { anchor: { kind: "tab", id }, after: !before }, target, before ? "drop-before" : "drop-after");
  }
  if (target.id === "pinned") return into(ZF.ROOT, {}, target, "drop-zone");
  if (drag.kind !== "tab") return null;
  if (target.id === "separator") {
    const first = view.regular.find(t => !drag.ids.includes(t.id));
    return { node: target, mark: "drop-zone", run: () => ZF.moveTabs(drag.ids, null, first ? { beforeId: first.id } : {}) };
  }
  return { node: target, mark: "drop-zone", run: () => ZF.moveTabs(drag.ids, null) };
}

document.addEventListener("dragover", event => {
  if (!dragging) return;
  const drop = dropTarget(event, dragging);
  clearIndicators();
  if (!drop) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  drop.node.classList.add(...drop.mark.split(" "));
});

document.addEventListener("drop", async event => {
  if (!dragging) return;
  const drop = dropTarget(event, dragging);
  event.preventDefault();
  clearIndicators();
  if (!drop) return;
  const moved = dragging?.ids ?? [];
  await drop.run();
  // Moving tabs clears Firefox's selection; keep it, like a native drag.
  const active = await activeTabId();
  if (moved.length > 1 && moved.includes(active)) await highlight(moved, active);
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

(async () => {
  ZF.metaCache = new Map();
  windowId = (await browser.windows.getCurrent()).id;
  // Only events for this window; other windows' sidebars handle theirs.
  const here = id => id === windowId && scheduleRender();
  browser.tabs.onCreated.addListener(tab => here(tab.windowId));
  browser.tabs.onRemoved.addListener((tabId, info) => {
    ZF.metaCache.delete(tabId);
    here(info.windowId);
  });
  browser.tabs.onMoved.addListener((_id, info) => here(info.windowId));
  browser.tabs.onAttached.addListener((_id, info) => here(info.newWindowId));
  browser.tabs.onDetached.addListener((_id, info) => here(info.oldWindowId));
  browser.tabs.onReplaced.addListener(() => scheduleRender());
  browser.tabs.onActivated.addListener(onTabActivated);
  browser.tabs.onHighlighted.addListener(onTabsHighlighted);
  browser.tabs.onUpdated.addListener(onTabPatched, { windowId, properties: ["title", "url", "favIconUrl", "discarded"] });
  browser.tabs.onUpdated.addListener(
    tabId => {
      ZF.metaCache.delete(tabId);
      scheduleRender();
    },
    { windowId, properties: ["audible", "mutedInfo", "pinned", "hidden"] }
  );
  browser.storage.onChanged.addListener(changes => {
    if (changes.settings) applySettings(ZF.normalizeSettings(changes.settings.newValue));
    if (changes.folders) scheduleRender();
  });
  // The background says so after any change to folders or tab placement,
  // including ones that don't move a tab (e.g. keeping the first regular tab).
  browser.runtime.onMessage.addListener(message => {
    if (message?.type === "zf-changed") {
      // Drop only the tabs whose metadata changed. A new map rather than
      // deletes, so a read already in flight can't put a stale value back.
      if (Array.isArray(message.tabIds)) {
        const changed = new Set(message.tabIds);
        ZF.metaCache = new Map([...ZF.metaCache].filter(([id]) => !changed.has(id)));
      } else ZF.metaCache = new Map();
      scheduleRender();
    }
  });
  applySettings(await ZF.getSettings());
  showHideShortcut();
  browser.commands.onChanged?.addListener(showHideShortcut);
  await render({ force: true });
  // Session values for restored tabs can arrive a little after startup.
  const reread = () => {
    ZF.metaCache = new Map();
    scheduleRender();
  };
  setTimeout(reread, 1000);
  setTimeout(reread, 4000);
})();

globalThis.zfTest = { selectedIds, startRename, startSpaceRename, renaming: () => renamingFolderId, render: () => render({ force: true }), view: () => view, dropTarget, windowId: () => windowId };
