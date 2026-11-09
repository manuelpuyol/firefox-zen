// Zen-like Firefox (tested on Firefox 159 / Nova).
// Copied into the profile folder; Firefox re-applies these on every launch.
// To undo a pref: delete the line here AND reset it in about:config.

// Load chrome/userChrome.css
user_pref("toolkit.legacyUserProfileCustomizations.stylesheets", true);

// Native vertical tabs in the new sidebar (Zen sidebar)
user_pref("sidebar.revamp", true);
user_pref("sidebar.verticalTabs", true);
user_pref("sidebar.verticalTabs.dragToPinPromo.dismissed", true);
user_pref("sidebar.position_start", true);
// "hide-sidebar": the toolbar's sidebar button and Ctrl+Z show and hide the
// whole sidebar, including the Zen Folder Tools panel. ("always-show" only
// expands/collapses Firefox's own tab list, which that panel replaces, so
// the panel couldn't be hidden.)
user_pref("sidebar.visibility", "hide-sidebar");
user_pref("sidebar.expandOnHover", true);
user_pref("sidebar.animation.expand-on-hover.delay-duration-ms", 150);
user_pref("sidebar.animation.expand-on-hover.duration-ms", 250);

// No tool buttons (bookmarks, history, AI…) in the sidebar, like Zen.
// Re-add any via right-click on the sidebar > Customize sidebar.
user_pref("sidebar.main.tools", "none");

// macOS translucent window (Zen vibrancy); userChrome.css makes chrome transparent
user_pref("widget.macos.sidebar-blend-mode.behind-window", true);
user_pref("widget.macos.titlebar-blend-mode.behind-window", true);
// Keep extension data when an extension is removed. Without this, reloading
// a temporarily loaded Zen Folder Tools (about:debugging) or restarting
// Firefox deletes its folders. Side effect: uninstalled extensions leave
// their data behind.
user_pref("extensions.webextensions.keepStorageOnUninstall", true);
user_pref("extensions.webextensions.keepUuidOnUninstall", true);

// Off on purpose. It would let the Zen Folder Tools sidebar panel be
// translucent, but Firefox applies it to every tab too: pages that don't set
// a background (they rely on the default white) turn see-through.
user_pref("browser.tabs.allow_transparent_browser", false);

// Tab groups (= Zen folders) and split view
user_pref("browser.tabs.groups.enabled", true);
user_pref("browser.tabs.splitView.enabled", true);
user_pref("browser.tabs.groups.hoverPreview.enabled", true);
// Wait 1s (default 0.5s) before showing a collapsed folder's tab list or a
// tab preview. Firefox uses the same delay for all tooltips.
user_pref("ui.tooltip.delay_ms", 1000);

// Session: continue where you left off, keep pinned tabs (= Essentials) loaded
user_pref("browser.startup.page", 3);
user_pref("browser.sessionstore.restore_pinned_tabs_on_demand", false);
user_pref("browser.sessionstore.restore_on_demand", true);
user_pref("browser.tabs.closeWindowWithLastTab", false);

// Unloaded tabs: native favicon fade + "Unload Tab" in context menu
// userChrome.css ghosts the whole row; the native favicon fade would double it
user_pref("browser.tabs.fadeOutUnloadedTabs", false);
user_pref("browser.tabs.unloadTabInContextMenu", true);
// macOS ships with automatic low-memory tab unloading off; turn it on
user_pref("browser.lowMemoryResponseMask", 3);

// Containers (Zen per-workspace containers)
user_pref("privacy.userContext.enabled", true);
user_pref("privacy.userContext.ui.enabled", true);

// Calm chrome: no bookmarks bar, no Firefox View button, no sponsored junk
user_pref("browser.toolbars.bookmarks.visibility", "never");
user_pref("browser.tabs.firefox-view", false);
user_pref("browser.newtabpage.activity-stream.showSponsored", false);
user_pref("browser.newtabpage.activity-stream.showSponsoredTopSites", false);
user_pref("browser.newtabpage.activity-stream.feeds.section.topstories", false);
user_pref("browser.urlbar.suggest.quicksuggest.sponsored", false);
