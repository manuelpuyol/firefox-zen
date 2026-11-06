# firefox-zen

Make stock Firefox look and behave like [Zen Browser](https://zen-browser.app/) on macOS, using only Firefox's built-in features, a `userChrome.css` theme, and an optional extension.

Tested with Firefox 159 (the "Nova" design) on macOS, compared side by side with Zen 1.24b.

## What you get

- **Sidebar:** native vertical tabs, 300px wide, without the Firefox tool buttons. Control+Z shows and hides it.
- **Essentials:** pinned tabs shown as a grid of rounded tiles.
- **Folders:** tab groups restyled as Zen folders.
  - Folder icon that opens and closes, `+N` count badge, whole row clickable.
  - Animated open and close.
  - Hovering a collapsed folder for 1 second shows its tabs (this delay applies to all Firefox tooltips; set with `ui.tooltip.delay_ms`).
  - **Subfolders:** a group whose name starts with a space nests under the group above it (two spaces for two levels), and is shown above that folder's own tabs, like Zen.
- **Tab rows:** Zen's measurements for hover and selection: 8px inset, 14px radius, icons and titles aligned with folders.
- **Unloaded tabs:** greyed out ("ghost" tabs).
- **Separator:** a line between your folders and loose tabs.
- **Floating URL bar:** on a new tab or when you start typing, the URL bar and its suggestions move to the middle of the window.
- **Page area:** rounded, floating web content with a soft shadow.
- **Translucent sidebar and toolbar:** uses the macOS sidebar material, with Nova's purple tint removed.
- **Toolbar order:** sidebar toggle, back, forward, reload, URL bar, extensions.
- **Session behaviour:** restores your previous session and keeps pinned tabs loaded; Containers enabled; no sponsored content.

## Install

Requires macOS and Python 3.

```sh
git clone https://github.com/manuelpuyol/firefox-zen.git
cd firefox-zen
./install.sh               # prefs, theme, toolbar, sidebar width; keeps your tabs
./install.sh --import-zen  # also replace current tabs with your Zen Essentials + folders
```

macOS doesn't let other apps write to Firefox's profile folder. So `install.sh` quits Firefox, restarts it with Marionette (Firefox's remote-control protocol), and has Firefox copy the files into its own profile. It then restarts Firefox normally. Your previous `user.js`, `chrome/` and session are backed up to `<profile>/zen-kit-backup-*`.

**Theme:** the installer switches Firefox to its default (system) theme, because any add-on theme paints the window opaque and hides the translucency.

### Importing from Zen

With `--import-zen`, the installer reads your Zen session (`zen-sessions.jsonlz4`) and converts it:

| Zen | Firefox |
| --- | --- |
| Essentials | Pinned tabs |
| Folders | Tab groups |
| Subfolders | Tab groups whose name starts with a space |
| Pinned tabs in folders | Regular tabs in those groups |
| Other tabs | Regular tabs after the groups |

Firefox has no Spaces, so tabs from every space are imported into one window.

## Customising

- `user.js` — Firefox preferences. Re-applied on every launch.
- `chrome/userChrome.css` — the theme.
  - Edit above the `@generated` marker. The variables at the top control spacing, radius, colours and animation speed.
  - Then run `python3 generate_css.py` to rebuild the generated rules (folder counts and subfolder collapsing).

Run `./install.sh` again to apply changes.

## Extension: Zen Folder Tools

`extension/` is an optional extension that replaces Firefox's tab list with a Zen-style sidebar, plus a few extras CSS can't provide.

### Sidebar

Opens in Firefox's sidebar panel; `userChrome.css` hides Firefox's own vertical tabs while it's open. It's translucent like the rest of the window: `user.js` turns on `browser.tabs.allow_transparent_browser`, and `userChrome.css` keeps web pages on a solid background so pages without one don't turn see-through. Top to bottom:

- **Essentials:** Firefox's pinned tabs, as tiles. They stay at the top while the list below scrolls; if they'd take more than half the sidebar, they scroll on their own.
- **Kept tabs:** tabs and folders that stay around, with **real nested subfolders**. Subfolders are ordinary items: drag them anywhere among a folder's tabs. Folders can be empty. Each folder shows a `+N` count of every tab inside it, subfolders included.
- **Separator with Clear:** closes all regular tabs (asks "Close N tabs?" first; click again to confirm).
- **Regular tabs**, then **New Tab**.

Behaviour:

- **Close to unload:** closing a loaded Essential or kept tab from the sidebar (× or middle-click) unloads it; closing it again while unloaded closes it (Essentials are never closed this way). Cmd+W can't be taken over by an extension, so it always closes.
- **Multi-select:** Shift+click selects a range, Cmd+click adds or removes a tab, Escape clears. It uses Firefox's own tab selection, so Cmd+W and the tab context menu act on every selected tab; dragging a selected tab moves them all (in order), and × or middle-click unloads or closes them all. Right-click → **Copy N URLs** copies their addresses, one per line in tab order (**Copy URL** for a single tab).
- **Drag and drop:** drop on the top or bottom edge of a row to place before or after it (tabs and folders alike), or on the middle of a folder to move into it; drag between Essentials, kept and regular tabs. Firefox's real tab order follows the sidebar, moving only the tabs that need to move.
- **Menus:** right-clicking a tab shows Firefox's own tab menu plus *Keep in Sidebar*, *Move to Regular Tabs*, *Move to New Folder* and the reset items. Right-clicking a folder or empty space offers *New Folder*, *New Subfolder*, *Rename Folder* and *Remove Folder (Keep Tabs)*.
- **Firefox tab groups become folders:** on install, existing tab groups (including the leading-space subfolder convention) are converted. A group created later with Firefox's own menu becomes a top-level folder once its name has stopped changing for a second (drag it into another folder to nest it). Turn this off in settings to keep Firefox's groups as they are.

### Auto-unload

Every 5 minutes, tabs you haven't looked at for an hour are unloaded, the same rules as [Zen Stale Tabs](https://github.com/manuelpuyol/zen-stale-pinned-tabs). Never unloaded:

- Essentials (and Firefox's own low-memory unloader is told to skip them; turn off *Keep Essentials loaded* to allow it). Only protection this extension set is ever removed, so other extensions' protection is left alone.
- The current tab, and tabs playing audio, using the camera, microphone or screen sharing, still loading, in private windows, or protected by another extension.
- Addresses on your *Never unload* list (one per line, `*` matches anything).

Change the timings, turn it off, or unload idle tabs immediately from the settings page.

### Settings

The gear button at the bottom of the sidebar (or `about:addons` → Zen Folder Tools → Preferences) opens a settings page with a live preview of your sidebar:

- **Sidebar:** Essentials tile size, folder counts, Clear button and its confirmation, unload-before-closing, animations, scrollbar (space for it is always reserved, so the list doesn't shift).
- **Appearance:** text size, row height (corners follow; 32px is the old *Compact rows*), folder indent, and how much of the sidebar the Essentials may take before they scroll on their own.
- **Folders:** turning Firefox tab groups into folders, importing folders from Zen, and backups: **Export…** saves your folders, kept tabs (folder, position, address, original address) and Essentials to a JSON file; **Restore…** adds back what's missing without removing anything. Folders with the same name and parent are reused, open tabs with a matching address move into their folder, and missing tabs reopen unloaded. The whole file is checked before anything changes. Private windows aren't exported.
- **Auto-unload:** on/off, idle time, check interval, last run and *Unload idle tabs now*.
- **Glance:** on/off, access to websites, and window size.
- **Keyboard shortcuts:** current shortcuts, with a link to Firefox's shortcut editor.

- **Reset kept tabs:** each kept tab remembers the URL it had when it was kept. A ↺ button appears in the sidebar when it has navigated away; also in the tab menu (**Reset to Original URL**) and Option+Shift+R. **Use Current Page as Original URL** changes it.
- **Glance:** Option+click a link in a page (not inside embedded frames) to open it in a centred floating window.
  - It needs access to websites, an optional permission: allow it from the settings page (turning Glance on asks for it). Glance's script runs in pages only while Glance is on and access is granted; otherwise the extension has no access to web pages at all.
  - Only real clicks count; a page can't open Glance windows by faking clicks. One Glance per window: Option+clicking again reuses it.
  - In a private window it opens a private Glance. It's off in container tabs, because keeping a container's cookies would need the *cookies* permission (which would let the extension read every site's cookies); Option+click does what Firefox normally does there.
  - Escape, or clicking back on the main window, closes it.
  - Option+Shift+G moves it into the main window next to the tab you came from, keeping the page as it is.

### How changes are made

Every change to folders, tab placement and settings runs in the extension's background page, one at a time, so two windows (or the settings page) can't overwrite each other. Afterwards every sidebar refreshes, including for changes that don't move any tab. Clear works out which tabs are regular at the moment you click it.

Tab groups in private windows aren't converted into folders, since folders are shared by all windows and saved on disk.

### Your folders are safe across reloads

Firefox deletes an extension's data when it's removed, and a temporarily loaded extension is removed every time Firefox restarts or you load it again. So:

- `user.js` sets `extensions.webextensions.keepStorageOnUninstall` and `keepUuidOnUninstall`, which keep the data (side effect: uninstalled extensions leave their data behind).
- Every folder change is also saved with your windows in Firefox's session, and restored from there if the extension's own copy is gone.
- Tabs that still point at a folder nobody knows about are grouped into *Recovered folder N* folders instead of being scattered.

To rebuild folders from Zen, run `python3 export_zen_folders.py` (writes `~/Downloads/zen-folders.json`) and use **Import folders from Zen** on the settings page. Open tabs with matching addresses are moved into the recreated folders, and emptied *Recovered* folders are removed.

### Installing

Release Firefox only installs signed extensions. To install:

1. Build it: `npx web-ext build --source-dir extension --artifacts-dir dist`.
2. Submit the zip to [addons.mozilla.org](https://addons.mozilla.org/developers/) as an unlisted add-on.
3. Install the signed `.xpi` it returns.

To try it without signing, load `extension/manifest.json` from `about:debugging`; it's removed when Firefox restarts.

## Limitations

Things Zen does that this can't reproduce:

- **Spaces:** Firefox has no equivalent.
- **Translucency:** Zen uses a darker macOS material (HUD) that Firefox doesn't expose, so the sidebar is tinted with CSS instead.
- **Without the extension, subfolders are a naming convention:** Firefox tab groups can't nest, so a subfolder is a separate group shown indented under the one above it. Dragging a subfolder or dropping a tab into one doesn't work reliably, and a folder's `+N` count leaves out its subfolders. The extension's sidebar has real subfolders instead.
- **Folder tabs aren't pinned without the extension:** they're regular tabs in a group.
- **Close-to-unload with Cmd+W:** the extension's sidebar unloads kept tabs on first close, but Cmd+W always closes; extensions can't take over that shortcut.
- **Glance:** opens a separate window rather than an overlay inside the page.
- **New tabs:** Firefox creates the tab immediately; Zen waits until you press Enter in the floating URL bar.

## License

[MIT](LICENSE)
