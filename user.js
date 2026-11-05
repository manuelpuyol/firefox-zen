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
// "always-show" = Zen with sidebar expanded.
// Use "expand-on-hover" for Zen compact-sidebar behaviour.
user_pref("sidebar.visibility", "always-show");
user_pref("sidebar.expandOnHover", true);
user_pref("sidebar.animation.expand-on-hover.delay-duration-ms", 150);
user_pref("sidebar.animation.expand-on-hover.duration-ms", 250);

// No tool buttons (bookmarks, history, AI…) in the sidebar, like Zen.
// Re-add any via right-click on the sidebar > Customize sidebar.
user_pref("sidebar.main.tools", "none");

// macOS translucent window (Zen vibrancy); userChrome.css makes chrome transparent
user_pref("widget.macos.sidebar-blend-mode.behind-window", true);
user_pref("widget.macos.titlebar-blend-mode.behind-window", true);

// Tab groups (= Zen folders) and split view
user_pref("browser.tabs.groups.enabled", true);
user_pref("browser.tabs.splitView.enabled", true);
user_pref("browser.tabs.groups.hoverPreview.enabled", true);

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
