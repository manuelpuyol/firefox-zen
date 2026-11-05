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

`extension/` is an optional extension with two Zen features that CSS can't provide:

- **Reset folder tabs:** each tab in a tab group remembers the URL it had when it joined the group.
  - Right-click the tab → **Reset to Original URL**, or press Option+Shift+R.
  - **Use Current Page as Original URL** changes the remembered URL.
- **Glance:** Option+click a link to open it in a centred floating window.
  - Escape, or clicking back on the main window, closes it.
  - Option+Shift+G opens it as a regular tab next to the one you came from.

Release Firefox only installs signed extensions. To install:

1. Build it: `npx web-ext build --source-dir extension --artifacts-dir dist`.
2. Submit the zip to [addons.mozilla.org](https://addons.mozilla.org/developers/) as an unlisted add-on.
3. Install the signed `.xpi` it returns.

To try it without signing, load `extension/manifest.json` from `about:debugging`; it's removed when Firefox restarts.

## Limitations

Things Zen does that this can't reproduce:

- **Spaces:** Firefox has no equivalent.
- **Translucency:** Zen uses a darker macOS material (HUD) that Firefox doesn't expose, so the sidebar is tinted with CSS instead.
- **Subfolders are a naming convention:** Firefox tab groups can't nest, so a subfolder is a separate group shown indented under the one above it. That means:
  - Firefox won't drop a group inside another group, so a subfolder always sits after its parent folder's own tabs. The theme shows subfolders above those tabs anyway (with CSS `order`), but keyboard navigation and drag-and-drop still follow Firefox's real order, and you can't mix subfolders in between a folder's tabs.
  - A folder's `+N` count only includes its own tabs, not its subfolders' (Zen counts both).
- **Folder tabs aren't pinned:** Zen keeps folder tabs pinned. Here they're regular tabs; the extension adds the reset-to-original-URL part.
- **Close-to-unload:** closing a folder tab unloads it in Zen. Firefox can only fake this by reopening the tab, which flickers.
- **Glance:** opens a separate window rather than an overlay inside the page.
- **New tabs:** Firefox creates the tab immediately; Zen waits until you press Enter in the floating URL bar.

## License

[MIT](LICENSE)
